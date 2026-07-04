import GLib from 'gi:GLib-2.0'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import { setDirSizeLookup, setDirSizePending } from '../core/format.ts'

/* Recursive folder sizes for the list view's Size column (opt-in, see
 * Preferences → Views). Finder's "Calculate all sizes", roughly.
 *
 *  - Scans run `du -B1 --apparent-size` per folder: one C-speed pass prints the
 *    cumulative size of *every* nested directory, so a single scan warms the
 *    cache for the whole subtree — navigating into a scanned folder shows its
 *    children's sizes instantly. Apparent size (sum of st_size) matches the
 *    file Size column and the properties dialog's walker.
 *  - Panes feed the queue: when a listing finishes loading, its folder paths
 *    are queued *in view order* and REPLACE whatever was queued before — the
 *    folder the user is looking at always scans front-to-back, and a navigation
 *    never waits behind hundreds of scans queued for the previous folder.
 *    (Cells can't request individually: the ColumnView binds every row of the
 *    listing up front, so bind-time requests would queue the world.)
 *  - Cells are pure cache readers (formatSize shows the cached value, "…"
 *    while a scan is pending); a coalesced 'changed' event repaints the views
 *    as results land.
 *  - Cache: in-memory map over a SQLite table (same node:sqlite/WAL pattern as
 *    tags.db), so sizes survive restarts. Entries older than the TTL are still
 *    shown, but a re-listing queues a background rescan — there is no exact
 *    invalidation: a directory's mtime only reflects direct-child changes, so
 *    nothing short of a rescan can validate a recursive total.
 *
 * The lookups are injected into core/format.ts at import time (formatSize and
 * the size comparator read through them) so core stays free of service imports. */

const DIR = GLib.getUserDataDir() + '/mariner'
const DB_FILE = DIR + '/dir-sizes.db'
const MAX_ROWS = 50_000     /* evicted down to this (oldest first) at startup */
/* du processes in flight. Scans are metadata-I/O bound and a cold multi-GB
 * folder can hold a slot for minutes — with too few slots every other folder
 * in the view sits pending behind it. */
const CONCURRENCY = 4
const CHANGED_DEBOUNCE_MS = 150
/* du prints one line per nested directory; a node_modules-heavy tree yields
 * tens of thousands — parsing and committing them all stalls the main thread
 * for hundreds of ms. --max-depth bounds the *output* (the root total is
 * still fully recursive): we keep subtree warmth for the levels the user will
 * actually navigate next, and anything deeper rescans quickly from a warm
 * page cache. */
const MAX_DEPTH = 4

/* bytes is null for folders du could not read at all (a tombstone: respects
 * the TTL so unreadable folders aren't rescanned on every listing). */
interface Entry { bytes: number | null; scannedAt: number }

/* `path === root || under(root)`, with the root='/' edge handled. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : root + '/')
}

export class DirSizeService extends EventEmitter {
  enabled = false
  ttlMs = 15 * 60_000
  _ready = false
  _db: any = null
  _selectStmt: any = null
  _insertStmt: any = null
  /* Entry = cached; null = known db miss (negative cache, so sorting a large
   * listing doesn't re-query SQLite per compare). */
  _mem = new Map<string, Entry | null>()
  _queue: string[] = []          /* scan roots, view order, popped FIFO */
  _queued = new Set<string>()    /* queue membership (isPending is per-bind) */
  _running = new Set<string>()   /* scan roots in flight */
  _debounce = 0

  /* Synchronous cache-only lookup — the read path for formatSize and the
   * comparator. */
  bytesOf(path: string): number | null {
    if (!this.enabled) return null
    return this._get(path)?.bytes ?? null
  }

  /* Whether a scan that will produce this path's size is queued or running
   * (drives the "…" placeholder). */
  isPending(path: string): boolean {
    if (!this.enabled) return false
    if (this._queued.has(path)) return true
    for (const root of this._running) if (isUnder(path, root)) return true
    return false
  }

  /* Queue scans for a just-loaded listing's folders, in view order. Replaces
   * the previous queue — the current listing always scans front-to-back and
   * never waits behind a folder the user already left. Fresh entries are
   * skipped; stale ones re-scan in the background (their old value stays up
   * until the result lands). Running scans are unaffected. */
  scanListing(paths: string[]): void {
    if (!this.enabled) return
    const now = Date.now()
    this._queue = paths.filter(p => {
      const entry = this._get(p)
      if (entry && now - entry.scannedAt < this.ttlMs) return false
      for (const root of this._running) if (isUnder(p, root)) return false
      return true
    })
    this._queued = new Set(this._queue)
    if (this._queue.length) { this._emitChanged(); this._pump() }
  }

  /* Drop everything queued (feature toggled off / shutdown). Running scans
   * finish into the cache harmlessly. */
  clear(): void {
    this._queue = []
    this._queued.clear()
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

  _pump(): void {
    while (this._running.size < CONCURRENCY && this._queue.length) {
      const root = this._queue.shift()!
      this._queued.delete(root)
      /* A scan that ran since this was queued may already cover it. */
      const entry = this._mem.get(root)
      if (entry && Date.now() - entry.scannedAt < this.ttlMs) continue
      this._running.add(root)
      this._scan(root)
    }
  }

  _scan(root: string): void {
    const results = new Map<string, number>()
    const proc = new ProcessStream(['du', '-B1', '--apparent-size', `--max-depth=${MAX_DEPTH}`, '--', root],
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
    this._emitChanged()
  }

  /* Coalesce repaints: a wave of completing scans emits one 'changed'. */
  _emitChanged(): void {
    if (this._debounce) return
    this._debounce = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, CHANGED_DEBOUNCE_MS, () => {
      this._debounce = 0
      this.emit('changed')
      return false
    })
  }
}

export const dirSizes = new DirSizeService()

setDirSizeLookup(info => {
  const path = info._file?.getPath?.()
  return path ? dirSizes.bytesOf(path) : null
})
setDirSizePending(info => {
  const path = info._file?.getPath?.()
  return path ? dirSizes.isPending(path) : false
})
