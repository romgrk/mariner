import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import { F, ATTRS, fileForPath } from '../core/gio.ts'
import type { GFile } from '../core/types.ts'

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

  get active(): boolean { return this.stream !== null }

  search(rootDir: GFile, query: string, { showHidden = false }: { showHidden?: boolean } = {}): void {
    this.cancel()
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
        this.emit('result', { info, file })
      })
  }

  cancel() {
    if (this.stream) { this.stream.cancel(); this.stream = null }
    if (this.cancellable) { try { this.cancellable.cancel() } catch {} this.cancellable = null }
  }
}
