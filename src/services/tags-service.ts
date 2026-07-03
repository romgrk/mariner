import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { EventEmitter } from '../core/emitter.ts'
import { setTagsColumnFormatter } from '../core/columns.ts'
import { fileForUri } from '../core/gio.ts'
import type { GFile, GFileInfo } from '../core/types.ts'

/* File tags (see GNOME Design whiteboard #332). Three layers:
 *
 *  - Truth: the file's `user.xdg.tags` xattr — a comma-separated list of tag
 *    names, the same convention Dolphin/Baloo use, so tags interop with other
 *    file managers and survive moves/copies made outside Mariner.
 *  - Registry: tag definitions (color, sidebar pinning), keyed by NAME — the
 *    xattr stores names, so the name is the identity. Unknown names discovered
 *    in xattrs (files tagged elsewhere) materialize as colorless text tags.
 *  - Index: uri → tags, so "all files tagged Pink" is a lookup rather than a
 *    filesystem scan. A cache of the xattrs: healed opportunistically whenever
 *    a listing's xattr disagrees with it (external moves/retags), pruned when
 *    an indexed file turns out gone.
 *
 * Registry + index persist in one SQLite database (built-in node:sqlite, WAL) —
 * chosen over the JSON-under-config-dir pattern because the index takes small
 * frequent writes (a heal per changed listing entry) from multiple Mariner
 * processes at once; WAL makes concurrent writers safe and PRAGMA data_version
 * tells our monitor whether another process actually committed.
 *
 * When a filesystem can't take xattrs (FAT, read-only, unowned files) an
 * assignment degrades to index-only (src='index') — the tag still works inside
 * Mariner; heals ignore index-only rows so they aren't wiped by the absent
 * xattr.
 *
 * Events: 'changed' (uris: string[] | null) — null means a registry-level
 * change (create/rename/recolor/delete) where any tag display may be stale. */

export const XATTR_TAGS = 'xattr::xdg.tags'

export interface Tag {
  name: string
  color: string | null   /* a TAG_COLORS key, or null for a text tag */
  pinned: boolean
}

interface Assignment { tag: string; src: 'xattr' | 'index' }

/* The nine tag colors: libadwaita's system accent palette, referenced through
 * its CSS variables (--accent-blue …) so they adapt to the light/dark style.
 * The hex values are the light-style standalone colors — used as the CSS
 * fallback on older GTK and for the menu-item dot icons (SVG can't read GTK
 * variables). style.ts generates the .tag-color-<key> classes from this map. */
export const TAG_COLORS: Array<{ key: string; label: string; cssVar: string; hex: string }> = [
  { key: 'blue', label: 'Blue', cssVar: '--accent-blue', hex: '#3584e4' },
  { key: 'teal', label: 'Teal', cssVar: '--accent-teal', hex: '#2190a4' },
  { key: 'green', label: 'Green', cssVar: '--accent-green', hex: '#3a944a' },
  { key: 'yellow', label: 'Yellow', cssVar: '--accent-yellow', hex: '#c88800' },
  { key: 'orange', label: 'Orange', cssVar: '--accent-orange', hex: '#ed5b00' },
  { key: 'red', label: 'Red', cssVar: '--accent-red', hex: '#e62d42' },
  { key: 'pink', label: 'Pink', cssVar: '--accent-pink', hex: '#d56199' },
  { key: 'purple', label: 'Purple', cssVar: '--accent-purple', hex: '#9141ac' },
  { key: 'slate', label: 'Slate', cssVar: '--accent-slate', hex: '#6f8396' },
]

export const TAG_COLOR: Record<string, { key: string; label: string; cssVar: string; hex: string }> =
  Object.fromEntries(TAG_COLORS.map(c => [c.key, c]))

const DIR = GLib.getUserDataDir() + '/mariner'
const DB_FILE = DIR + '/tags.db'

/* tag:///<name> — the virtual location listing a tag's files (tag:/// lists
 * every tagged file). */
export function tagUri(name: string): string { return 'tag:///' + encodeURIComponent(name) }
export function isTagUri(uri: string): boolean { return uri.startsWith('tag:') }
/* The tag name of a tag:// URI, or null for the root (all tags). */
export function tagFromUri(uri: string): string | null {
  const m = /^tag:\/\/\/(.+)$/.exec(uri)
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

/* Tag names separate on commas in the xattr, so they can't contain one. */
export function validateTagName(name: string): string | null {
  const n = name.trim()
  if (!n) return null
  if (n.includes(',')) return null
  if (n.length > 64) return null
  return n
}

function parseXattr(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export class TagsService extends EventEmitter {
  _db: any = null
  _ready = false
  _tags = new Map<string, Tag>()                  /* insertion order = sort order */
  _byUri = new Map<string, Assignment[]>()
  _monitor: any = null
  _monitorDebounce = 0
  _dataVersion = -1
  _pendingChanged: Set<string> | null = null

  /* ---- lifecycle ---- */

  _ensure(): void {
    if (this._ready) return
    this._ready = true
    try {
      mkdirSync(DIR, { recursive: true })
      this._db = new DatabaseSync(DB_FILE)
      this._db.exec('PRAGMA journal_mode = WAL')
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS tags (
          name TEXT PRIMARY KEY,
          color TEXT,
          pinned INTEGER NOT NULL DEFAULT 1,
          sort INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS assignments (
          uri TEXT NOT NULL,
          tag TEXT NOT NULL,
          pos INTEGER NOT NULL DEFAULT 0,
          src TEXT NOT NULL DEFAULT 'xattr',
          PRIMARY KEY (uri, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_assignments_tag ON assignments(tag);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      `)
      this._seed()
      this._loadAll()
      this._dataVersion = this._readDataVersion()
      this._watch()
    } catch {
      /* Unopenable database (corrupt / no permissions): run memory-only. Tags
       * still work for this session via xattrs + heals; nothing persists. */
      this._db = null
    }
  }

  /* Seed the nine palette tags once (user_version marks it done, so deleting
   * one later doesn't resurrect it on the next launch). */
  _seed(): void {
    const ver = Number(this._db.prepare('PRAGMA user_version').get().user_version)
    if (ver !== 0) return
    const ins = this._db.prepare('INSERT OR IGNORE INTO tags (name, color, sort) VALUES (?, ?, ?)')
    TAG_COLORS.forEach((c, i) => ins.run(c.label, c.key, i))
    this._db.exec('PRAGMA user_version = 1')
  }

  _loadAll(): void {
    this._tags = new Map()
    for (const row of this._db.prepare('SELECT name, color, pinned FROM tags ORDER BY sort, name').all())
      this._tags.set(row.name, { name: row.name, color: row.color ?? null, pinned: !!row.pinned })
    this._byUri = new Map()
    for (const row of this._db.prepare('SELECT uri, tag, src FROM assignments ORDER BY uri, pos').all()) {
      let arr = this._byUri.get(row.uri)
      if (!arr) this._byUri.set(row.uri, arr = [])
      arr.push({ tag: row.tag, src: row.src === 'index' ? 'index' : 'xattr' })
    }
  }

  /* Other-process sync: WAL commits from another Mariner process touch the
   * -wal file; PRAGMA data_version only advances for commits made on OTHER
   * connections, so our own writes never trigger a reload. */
  _watch(): void {
    try {
      this._monitor = Gio.File.newForPath(DIR).monitorDirectory(Gio.FileMonitorFlags.NONE, null)
      this._monitor.on('changed', () => {
        if (this._monitorDebounce) return
        this._monitorDebounce = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 300, () => {
          this._monitorDebounce = 0
          const v = this._readDataVersion()
          if (v !== this._dataVersion) {
            this._dataVersion = v
            try { this._loadAll() } catch {}
            this.emit('changed', null)
          }
          return false
        })
      })
    } catch { /* no monitor backend — same-process events still flow */ }
  }

  _readDataVersion(): number {
    try { return Number(this._db.prepare('PRAGMA data_version').get().data_version) } catch { return -1 }
  }

  /* ---- registry ---- */

  tags(): Tag[] { this._ensure(); return [...this._tags.values()] }
  getTag(name: string): Tag | null { this._ensure(); return this._tags.get(name) ?? null }

  createTag(name: string, color: string | null): Tag | null {
    this._ensure()
    const n = validateTagName(name)
    if (!n || this._tags.has(n)) return null
    const tag: Tag = { name: n, color: color && TAG_COLOR[color] ? color : null, pinned: true }
    this._tags.set(n, tag)
    this._sql('INSERT OR IGNORE INTO tags (name, color, sort) VALUES (?, ?, ?)', n, tag.color, this._tags.size)
    this.emit('changed', null)
    return tag
  }

  /* Rename keeps every assignment (name is the identity in the xattrs, so each
   * tagged file's xattr is rewritten — the index knows exactly which). */
  renameTag(oldName: string, newName: string): boolean {
    this._ensure()
    const n = validateTagName(newName)
    const tag = this._tags.get(oldName)
    if (!tag || !n || n === oldName || this._tags.has(n)) return false

    this._tx(() => {
      this._sql('UPDATE tags SET name = ? WHERE name = ?', n, oldName)
      this._sql('UPDATE assignments SET tag = ? WHERE tag = ?', n, oldName)
    })
    /* Rebuild the registry map preserving order. */
    this._tags = new Map([...this._tags.entries()].map(([k, v]) =>
      k === oldName ? [n, { ...v, name: n }] : [k, v]))
    for (const [uri, entries] of this._byUri) {
      const hit = entries.find(e => e.tag === oldName)
      if (!hit) continue
      hit.tag = n
      this._rewriteXattr(uri, entries)
    }
    this.emit('changed', null)
    return true
  }

  setTagColor(name: string, color: string | null): void {
    this._ensure()
    const tag = this._tags.get(name)
    if (!tag) return
    tag.color = color && TAG_COLOR[color] ? color : null
    this._sql('UPDATE tags SET color = ? WHERE name = ?', tag.color, name)
    this.emit('changed', null)
  }

  /* Pinned tags appear in the sidebar (all tags are pinned by default). */
  setTagPinned(name: string, pinned: boolean): void {
    this._ensure()
    const tag = this._tags.get(name)
    if (!tag || tag.pinned === pinned) return
    tag.pinned = pinned
    this._sql('UPDATE tags SET pinned = ? WHERE name = ?', pinned ? 1 : 0, name)
    this.emit('changed', null)
  }

  /* Delete the tag and unassign it everywhere (rewriting each file's xattr). */
  deleteTag(name: string): void {
    this._ensure()
    if (!this._tags.delete(name)) return
    this._tx(() => {
      this._sql('DELETE FROM assignments WHERE tag = ?', name)
      this._sql('DELETE FROM tags WHERE name = ?', name)
    })
    for (const [uri, entries] of [...this._byUri]) {
      if (!entries.some(e => e.tag === name)) continue
      const kept = entries.filter(e => e.tag !== name)
      if (kept.length) this._byUri.set(uri, kept)
      else this._byUri.delete(uri)
      this._rewriteXattr(uri, kept)
    }
    this.emit('changed', null)
  }

  /* Discovered-in-xattr names (files tagged by other tools) become text tags. */
  _ensureRegistry(names: string[]): void {
    let created = false
    for (const name of names) {
      if (this._tags.has(name)) continue
      this._tags.set(name, { name, color: null, pinned: true })
      this._sql('INSERT OR IGNORE INTO tags (name, color, sort) VALUES (?, NULL, ?)', name, this._tags.size)
      created = true
    }
    if (created) this.emit('changed', null)
  }

  /* ---- assignments ---- */

  tagsOf(uri: string): string[] {
    this._ensure()
    return (this._byUri.get(uri) ?? []).map(e => e.tag)
  }

  /* The tag objects for a URI (for cell dots), in assignment order. */
  tagObjectsOf(uri: string): Tag[] {
    this._ensure()
    const out: Tag[] = []
    for (const e of this._byUri.get(uri) ?? []) {
      const t = this._tags.get(e.tag)
      if (t) out.push(t)
    }
    return out
  }

  filesWith(tag: string): string[] {
    this._ensure()
    const out: string[] = []
    for (const [uri, entries] of this._byUri) if (entries.some(e => e.tag === tag)) out.push(uri)
    return out
  }

  allTaggedUris(): string[] {
    this._ensure()
    return [...this._byUri.keys()]
  }

  counts(): Map<string, number> {
    this._ensure()
    const out = new Map<string, number>()
    for (const entries of this._byUri.values())
      for (const e of entries) out.set(e.tag, (out.get(e.tag) ?? 0) + 1)
    return out
  }

  /* Set the exact tag list of a file: xattr first (truth), then index, then
   * event. Unknown names are registered as text tags. */
  setTags(file: GFile, names: string[]): void {
    this._ensure()
    const clean: string[] = []
    for (const raw of names) {
      const n = validateTagName(raw)
      if (n && !clean.includes(n)) clean.push(n)
    }
    this._ensureRegistry(clean)
    const uri = file.getUri()
    const ok = this._writeXattr(file, clean)
    const src: 'xattr' | 'index' = ok ? 'xattr' : 'index'
    this._setIndex(uri, clean.map(tag => ({ tag, src })))
    this.emit('changed', [uri])
  }

  addTag(files: GFile[], name: string): void {
    for (const f of files) {
      const cur = this.tagsOf(f.getUri())
      if (!cur.includes(name)) this.setTags(f, [...cur, name])
    }
  }

  removeTag(files: GFile[], name: string): void {
    for (const f of files) {
      const cur = this.tagsOf(f.getUri())
      if (cur.includes(name)) this.setTags(f, cur.filter(t => t !== name))
    }
  }

  /* Context-menu toggle semantics: if every file already has the tag, remove it
   * from all; otherwise add it to the ones lacking it. */
  toggleTag(files: GFile[], name: string): void {
    this._ensure()
    const all = files.every(f => this.tagsOf(f.getUri()).includes(name))
    if (all) this.removeTag(files, name)
    else this.addTag(files, name)
  }

  removeAllTags(files: GFile[]): void {
    for (const f of files) if (this.tagsOf(f.getUri()).length) this.setTags(f, [])
  }

  /* ---- self-healing (called for every entry entering a view) ---- */

  /* Reconcile the index with the xattr the listing just fetched. Catches files
   * tagged/moved outside Mariner. Index-only assignments (xattr write failed)
   * are preserved — the missing xattr is expected for them. */
  heal(info: GFileInfo, file: GFile): void {
    const uri = file.getUri()
    if (!uri.startsWith('file://')) return
    this._ensure()
    const names = parseXattr(info.getAttributeString?.(XATTR_TAGS))
    const cur = this._byUri.get(uri)
    if (!names.length && !cur) return                        /* untagged, unindexed — the common case */
    const curXattr = (cur ?? []).filter(e => e.src === 'xattr').map(e => e.tag)
    if (sameNames(names, curXattr)) return
    this._ensureRegistry(names)
    const keep = (cur ?? []).filter(e => e.src === 'index' && !names.includes(e.tag))
    this._setIndex(uri, [...names.map((tag): Assignment => ({ tag, src: 'xattr' })), ...keep])
    this._queueChanged(uri)
  }

  /* Drop an indexed URI whose file no longer exists (found during a tag://
   * listing). The xattr is gone with the file; nothing to rewrite. */
  dropUri(uri: string): void {
    this._ensure()
    if (!this._byUri.delete(uri)) return
    this._sql('DELETE FROM assignments WHERE uri = ?', uri)
    this._queueChanged(uri)
  }

  /* ---- file-operation hooks (tags follow files through in-app operations) ---- */

  /* Re-key oldUri (and everything under it) to newUri after a move/rename. The
   * xattrs traveled with the files; only the index needs the new addresses. */
  rekeyPrefix(oldUri: string, newUri: string): void {
    this._ensure()
    const pre = oldUri + '/'
    const hits = [...this._byUri.keys()].filter(u => u === oldUri || u.startsWith(pre))
    if (!hits.length) return
    const changed: string[] = []
    this._tx(() => {
      for (const u of hits) {
        const next = newUri + u.slice(oldUri.length)
        this._sql('UPDATE OR REPLACE assignments SET uri = ? WHERE uri = ?', next, u)
        this._byUri.set(next, this._byUri.get(u)!)
        this._byUri.delete(u)
        changed.push(next)
      }
    })
    this.emit('changed', changed)
  }

  /* Drop the index rows for a deleted/trashed tree. (A trashed file keeps its
   * xattr, so restoring it re-heals its tags on the next listing.) */
  dropPrefix(uri: string): void {
    this._ensure()
    const pre = uri + '/'
    const hits = [...this._byUri.keys()].filter(u => u === uri || u.startsWith(pre))
    if (!hits.length) return
    this._tx(() => {
      for (const u of hits) {
        this._sql('DELETE FROM assignments WHERE uri = ?', u)
        this._byUri.delete(u)
      }
    })
    this.emit('changed', hits)
  }

  /* ---- settings (tag-related UI state, e.g. sidebar expansion) ---- */

  getSetting(key: string, fallback: string): string {
    this._ensure()
    try { return this._db?.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback }
    catch { return fallback }
  }

  setSetting(key: string, value: string): void {
    this._ensure()
    this._sql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  /* ---- internals ---- */

  /* Write the truth: the file's user.xdg.tags xattr. False when the filesystem
   * refuses (FAT, read-only, unowned) — the caller degrades to index-only. */
  _writeXattr(file: GFile, names: string[]): boolean {
    try {
      if (names.length) {
        file.setAttributeString(XATTR_TAGS, names.join(','), Gio.FileQueryInfoFlags.NONE, null)
      } else {
        /* Unset the attribute (type INVALID removes an xattr); some backends
         * reject that — an empty value is equivalent for every consumer. */
        try { file.setAttribute(XATTR_TAGS, Gio.FileAttributeType.INVALID, null, Gio.FileQueryInfoFlags.NONE, null) }
        catch { file.setAttributeString(XATTR_TAGS, '', Gio.FileQueryInfoFlags.NONE, null) }
      }
      return true
    } catch { return false }
  }

  /* Rewrite a file's xattr from its current (already-updated) index entries —
   * used by tag rename/delete, where the assignment set is driven from the
   * registry side. Missing/refusing files degrade those rows to index-only. */
  _rewriteXattr(uri: string, entries: Assignment[]): void {
    const names = entries.filter(e => e.src === 'xattr').map(e => e.tag)
    const ok = this._writeXattr(fileForUri(uri), names)
    const next = ok ? entries : entries.map((e): Assignment => ({ ...e, src: 'index' }))
    this._setIndex(uri, next)
  }

  _setIndex(uri: string, entries: Assignment[]): void {
    this._tx(() => {
      this._sql('DELETE FROM assignments WHERE uri = ?', uri)
      entries.forEach((e, i) =>
        this._sql('INSERT OR REPLACE INTO assignments (uri, tag, pos, src) VALUES (?, ?, ?, ?)', uri, e.tag, i, e.src))
    })
    if (entries.length) this._byUri.set(uri, entries)
    else this._byUri.delete(uri)
  }

  _sql(sql: string, ...args: any[]): void {
    if (!this._db) return
    try { this._db.prepare(sql).run(...args) } catch { /* keep the in-memory state authoritative */ }
  }

  _tx(fn: () => void): void {
    if (!this._db) { fn(); return }
    try { this._db.exec('BEGIN') } catch { fn(); return }
    try { fn(); this._db.exec('COMMIT') }
    catch { try { this._db.exec('ROLLBACK') } catch {} }
  }

  /* Coalesce heal-driven changes (one directory listing heals many entries)
   * into a single 'changed' on the idle loop. */
  _queueChanged(uri: string): void {
    if (this._pendingChanged) { this._pendingChanged.add(uri); return }
    this._pendingChanged = new Set([uri])
    GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
      const uris = this._pendingChanged
      this._pendingChanged = null
      if (uris?.size) this.emit('changed', [...uris])
      return false
    })
  }
}

/* Module-level singleton: one index/registry per process, shared by every
 * window; cross-process sync via the database monitor. */
export const tagsService = new TagsService()

/* The list view's Tags column reads through the service (live after toggles),
 * injected so core/columns.ts stays free of service imports. */
setTagsColumnFormatter(info => {
  const file = (info as any)._file
  return file ? tagsService.tagsOf(file.getUri()).join(', ') : ''
})
