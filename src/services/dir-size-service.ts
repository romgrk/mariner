import GLib from 'gi:GLib-2.0'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { ProcessStream } from '../core/process-stream.ts'
import { setDirSizeLookup } from '../core/format.ts'

/* Recursive folder sizes for the list view's Size column (opt-in, see
 * Preferences → Views). Finder's "Calculate all sizes", roughly.
 *
 *  - Scans run `du -B1 --apparent-size` per requested folder: one C-speed pass
 *    prints the cumulative size of *every* nested directory, so a single scan
 *    warms the cache for the whole subtree — navigating into a scanned folder
 *    shows its children's sizes instantly. Apparent size (sum of st_size)
 *    matches the file Size column and the properties dialog's walker.
 *  - Cells request sizes on bind (visible rows only); the queue is LIFO with
 *    small concurrency, so what the user is looking at *now* scans first and
 *    scans queued from folders they've navigated away from run later — their
 *    results still land in the cache.
 *  - Cache: in-memory map over a SQLite table (same node:sqlite/WAL pattern as
 *    tags.db), so sizes survive restarts. Entries older than the TTL are still
 *    shown, but a request re-scans them in the background — there is no exact
 *    invalidation: a directory's mtime only reflects direct-child changes, so
 *    nothing short of a rescan can validate a recursive total.
 *
 * The lookup is injected into core/format.ts at import time (formatSize and
 * the size comparator read through it) so core stays free of service imports. */

const DIR = GLib.getUserDataDir() + '/mariner'
const DB_FILE = DIR + '/dir-sizes.db'
const MAX_ROWS = 50_000     /* evicted down to this (oldest first) at startup */
const CONCURRENCY = 2       /* du processes in flight */

/* bytes is null for folders du could not read at all (a tombstone: respects
 * the TTL so unreadable folders aren't rescanned on every bind). */
interface Entry { bytes: number | null; scannedAt: number }
type Cb = (bytes: number | null) => void

/* `path === root || under(root)`, with the root='/' edge handled. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : root + '/')
}

export class DirSizeService {
  enabled = false
  ttlMs = 15 * 60_000
  _ready = false
  _db: any = null
  _selectStmt: any = null
  _insertStmt: any = null
  /* Entry = cached; null = known db miss (negative cache, so sorting a large
   * listing doesn't re-query SQLite per compare). */
  _mem = new Map<string, Entry | null>()
  _waiters = new Map<string, Cb[]>()
  _queue: string[] = []          /* scan roots, popped LIFO */
  _running = new Set<string>()   /* scan roots in flight */

  /* Synchronous cache-only lookup (no scan side-effect) — the read path for
   * formatSize and the comparator. */
  bytesOf(path: string): number | null {
    if (!this.enabled) return null
    return this._get(path)?.bytes ?? null
  }

  /* Ask for a folder's size: if the cached entry is missing or older than the
   * TTL, queue a scan and fire `cb` when it lands (never synchronously — bind
   * already painted the cached value through formatSize). */
  request(path: string, cb: Cb): void {
    if (!this.enabled) return
    const entry = this._get(path)
    if (entry && Date.now() - entry.scannedAt < this.ttlMs) return
    const waiters = this._waiters.get(path)
    if (waiters) waiters.push(cb)
    else this._waiters.set(path, [cb])
    if (!this._covered(path)) { this._queue.push(path); this._pump() }
  }

  /* ---- cache ---- */

  _ensure(): void {
    if (this._ready) return
    this._ready = true
    try {
      mkdirSync(DIR, { recursive: true })
      this._db = new DatabaseSync(DB_FILE)
      this._db.exec('PRAGMA journal_mode = WAL')
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS dir_sizes (
          path TEXT PRIMARY KEY,
          bytes INTEGER NOT NULL,
          scanned_at INTEGER NOT NULL
        );
      `)
      this._db.exec(`DELETE FROM dir_sizes WHERE rowid NOT IN
        (SELECT rowid FROM dir_sizes ORDER BY scanned_at DESC LIMIT ${MAX_ROWS})`)
      this._selectStmt = this._db.prepare('SELECT bytes, scanned_at FROM dir_sizes WHERE path = ?')
      this._insertStmt = this._db.prepare('INSERT OR REPLACE INTO dir_sizes (path, bytes, scanned_at) VALUES (?, ?, ?)')
    } catch {
      /* Unopenable database (corrupt / no permissions): run memory-only —
       * sizes still work for this session; nothing persists. */
      this._db = null
    }
  }

  _get(path: string): Entry | null {
    const cached = this._mem.get(path)
    if (cached !== undefined) return cached
    this._ensure()
    let row: any = null
    if (this._db) { try { row = this._selectStmt.get(path) } catch { /* torn db */ } }
    const entry = row ? { bytes: Number(row.bytes), scannedAt: Number(row.scanned_at) } : null
    this._mem.set(path, entry)
    return entry
  }

  /* ---- scan queue ---- */

  /* A queued or running scan of `path` or an ancestor will produce its entry. */
  _covered(path: string): boolean {
    for (const root of this._running) if (isUnder(path, root)) return true
    for (const root of this._queue) if (isUnder(path, root)) return true
    return false
  }

  _pump(): void {
    while (this._running.size < CONCURRENCY && this._queue.length) {
      const root = this._queue.pop()!
      if (this._covered(root)) continue   /* an ancestor got queued after it */
      this._running.add(root)
      this._scan(root)
    }
  }

  _scan(root: string): void {
    const results = new Map<string, number>()
    const proc = new ProcessStream(['du', '-B1', '--apparent-size', '--', root],
      { env: { LC_ALL: 'C' }, rawLines: true })
    proc.on('line', (line: string) => {
      const m = /^(\d+)\t(.+)$/.exec(line)
      if (m) results.set(m[2], Number(m[1]))
    })
    /* Permission-denied subfolders make du print to stderr and exit non-zero;
     * the totals it did print are still good — commit whatever we got. */
    proc.on('error', () => {})
    proc.on('end', () => {
      this._running.delete(root)
      this._commit(root, results)
      this._pump()
    })
    proc.start()
  }

  _commit(root: string, results: Map<string, number>): void {
    const now = Date.now()
    for (const [path, bytes] of results) this._mem.set(path, { bytes, scannedAt: now })
    if (!results.has(root)) this._mem.set(root, { bytes: null, scannedAt: now })
    if (this._db && results.size) {
      try {
        this._db.exec('BEGIN')
        for (const [path, bytes] of results) this._insertStmt.run(path, bytes, now)
        this._db.exec('COMMIT')
      } catch { try { this._db.exec('ROLLBACK') } catch {} }
    }
    /* Resolve every waiter the scan covered — including paths that produced no
     * line (vanished, unreadable): they get null and keep an empty cell. */
    for (const [path, cbs] of [...this._waiters]) {
      if (!isUnder(path, root)) continue
      this._waiters.delete(path)
      const bytes = this._mem.get(path)?.bytes ?? null
      for (const cb of cbs) cb(bytes)
    }
  }
}

export const dirSizes = new DirSizeService()

setDirSizeLookup(info => {
  const path = info._file?.getPath?.()
  return path ? dirSizes.bytesOf(path) : null
})
