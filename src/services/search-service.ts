import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import { F, ATTRS, fileForPath } from '../core/gio.ts'
import { modifiedUnix } from '../core/format.ts'
import type { GFile, GFileInfo, SearchFilter } from '../core/types.ts'

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

/* Recursive search, run out-of-process (search-worker.mjs) and streamed back so
 * results appear incrementally and a long search never blocks the UI. The worker
 * emits paths; we query each one's GFileInfo (for icon/metadata) asynchronously.
 *
 * Events:
 *   'start'                      search began
 *   'result'  ({info, file})     a match resolved
 *   'end'     (ok)               worker finished (ok=false if it errored)
 *   'error'   (message)          worker/spawn error
 */
export class SearchService extends EventEmitter {
  stream: ProcessStream | null = null
  cancellable: any = null
  filter: SearchFilter | null = null

  get active(): boolean { return this.stream !== null }

  search(rootDir: GFile, query: string, { showHidden = false, filter = null }: { showHidden?: boolean; filter?: SearchFilter | null } = {}): void {
    this.cancel()
    this.filter = filter
    const token = this.cancellable = new Gio.Cancellable()
    const argv = [process.execPath, WORKER, F.getPath(rootDir), query, showHidden ? '1' : '0']

    this.stream = new ProcessStream(argv)
    this.stream.on('line', (path: string) => this._resolve(path, token))
    this.stream.on('error', (msg: string) => this.emit('error', msg))
    this.stream.on('end', (ok: boolean) => { this.stream = null; this.emit('end', ok) })

    this.emit('start')
    this.stream.start()
  }

  _resolve(line: string, token: any): void {
    let path
    try { path = JSON.parse(line) } catch { return }
    const file = fileForPath(path)
    F.queryInfoAsync(file, ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, token,
      (_src: any, res: any) => {
        if (token.isCancelled()) return
        let info
        try { info = F.queryInfoFinish(file, res) } catch { return }
        if (matchesFilter(info, this.filter)) this.emit('result', { info, file })
      })
  }

  cancel() {
    if (this.stream) { this.stream.cancel(); this.stream = null }
    if (this.cancellable) { try { this.cancellable.cancel() } catch {} this.cancellable = null }
  }
}
