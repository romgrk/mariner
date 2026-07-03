import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import { ATTRS, fileForPath } from '../core/gio.ts'
import { modifiedUnix } from '../core/format.ts'
import type { Entry, GFile, GFileInfo, SearchFilter } from '../core/types.ts'

const DOCUMENT_RE = /officedocument|opendocument|msword|pdf|rtf|ebook|epub/

/* Whether a resolved entry passes the rich-search filter (category + date). */
function matchesFilter(info: GFileInfo, filter: SearchFilter | null): boolean {
  if (!filter) return true
  if (filter.since && modifiedUnix(info) < filter.since) return false
  const ct = info.getContentType() || ''
  switch (filter.category) {
    case 'folder': return info.getFileType() === Gio.FileType.DIRECTORY
    case 'image': return ct.startsWith('image/')
    case 'audio': return ct.startsWith('audio/')
    case 'video': return ct.startsWith('video/')
    case 'document': return ct.startsWith('text/') || DOCUMENT_RE.test(ct)
    default: return true
  }
}

const WORKER = fileURLToPath(new URL('../workers/search-worker.ts', import.meta.url))

/* Resolved matches are coalesced over this window and emitted as one batch, so
 * the view inserts them with a single splice instead of one items-changed per
 * result — thousands of matches arriving at once would otherwise freeze the UI
 * (each per-item change is processed by the selection model and both views). */
const FLUSH_MS = 50

/* ripgrep flags for content search: emit each matching file once, treat the
 * query as a literal case-insensitive substring (mirroring the name search),
 * search everything the user can see (--no-ignore), and keep stderr clean
 * (--no-messages) since ProcessStream treats any stderr as an error. */
const RG_FLAGS = ['--files-with-matches', '--fixed-strings', '--ignore-case', '--no-messages', '--no-ignore']

/* Recursive search, run out-of-process and streamed back so results appear
 * incrementally and a long search never blocks the UI. Two modes:
 *  - name (default): the breadth-first worker, emitting JSON-encoded paths.
 *  - content (filter.contents + a query): ripgrep, emitting raw paths.
 * Either way each path is resolved to a GFileInfo (icon/metadata) asynchronously
 * and passed through the category/date filter.
 *
 * Events:
 *   'start'                      search began
 *   'result'  (Entry[])          a coalesced batch of resolved matches
 *   'end'     (ok)               finished (ok=false if it errored)
 *   'error'   (message)          worker/spawn error
 */
export class SearchService extends EventEmitter {
  stream: ProcessStream | null = null
  cancellable: any = null
  filter: SearchFilter | null = null
  _contentMode = false
  _pending: Entry[] = []
  _flushTimer = 0

  get active(): boolean { return this.stream !== null }

  search(rootDir: GFile, query: string, { showHidden = false, filter = null }: { showHidden?: boolean; filter?: SearchFilter | null } = {}): void {
    this.cancel()
    this.filter = filter
    const token = this.cancellable = new Gio.Cancellable()
    this.emit('start')

    const path = rootDir.getPath()
    const wantContent = !!(filter?.contents && query && path)
    this._contentMode = wantContent

    let argv: string[]
    if (wantContent) {
      const rg = GLib.findProgramInPath('rg')
      if (!rg) { this.emit('error', 'Content search requires ripgrep (rg), which was not found on PATH.'); return }
      argv = [rg, ...RG_FLAGS, ...(showHidden ? ['--hidden'] : []), '--', query, path!]
    } else {
      argv = [process.execPath, WORKER, path!, query, showHidden ? '1' : '0']
    }

    this.stream = new ProcessStream(argv)
    this.stream.on('line', (line: string) => this._resolve(line, token))
    this.stream.on('error', (msg: string) => this.emit('error', msg))
    this.stream.on('end', (ok: boolean) => { this.stream = null; this._flush(); this.emit('end', ok) })
    this.stream.start()
  }

  _resolve(line: string, token: any): void {
    let path: string
    if (this._contentMode) { if (!line) return; path = line }
    else { try { path = JSON.parse(line) } catch { return } }
    const file = fileForPath(path)
    file.queryInfoAsync(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, token,
      (_src: any, res: any) => {
        if (token.isCancelled()) return
        let info
        try { info = file.queryInfoFinish(res) } catch { return }
        if (matchesFilter(info, this.filter)) this._push({ info, file })
      })
  }

  /* Buffer a resolved match and arm the coalescing flush (see FLUSH_MS). */
  _push(entry: Entry): void {
    this._pending.push(entry)
    if (!this._flushTimer) {
      this._flushTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT_IDLE, FLUSH_MS, () => {
        this._flushTimer = 0
        this._flush()
        return false
      })
    }
  }

  _flush(): void {
    if (this._flushTimer) { GLib.sourceRemove(this._flushTimer); this._flushTimer = 0 }
    if (this._pending.length === 0) return
    const batch = this._pending
    this._pending = []
    this.emit('result', batch)
  }

  cancel() {
    if (this._flushTimer) { GLib.sourceRemove(this._flushTimer); this._flushTimer = 0 }
    this._pending = []
    if (this.stream) { this.stream.cancel(); this.stream = null }
    if (this.cancellable) { try { this.cancellable.cancel() } catch {} this.cancellable = null }
  }
}
