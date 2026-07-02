import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { EventEmitter } from '../core/emitter.ts'
import { ATTRS } from '../core/gio.ts'
import type { GFile } from '../core/types.ts'

const BATCH = 64

/* Lists a directory asynchronously and incrementally (non-blocking), and keeps
 * it fresh with a Gio.FileMonitor. GTK-free.
 *
 * Events:
 *   'loading'                 enumeration started (clear the view)
 *   'items'    (FileInfo[])   a batch of entries arrived
 *   'ready'    (count)        enumeration finished
 *   'error'    (message)      enumeration failed
 *   'invalidated'             the directory changed on disk (caller may reload)
 */
export class DirectoryService extends EventEmitter {
  dir: GFile | null = null
  cancellable: any = null
  monitor: any = null
  _debounce = 0

  load(dir: GFile): void {
    this.cancel()
    this.dir = dir
    const token = this.cancellable = new Gio.Cancellable()
    this.emit('loading')

    dir.enumerateChildrenAsync(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, token,
    (_src: any, res: any) => {
      if (token.isCancelled()) return
      let en
      try { en = dir.enumerateChildrenFinish(res) }
      catch (e: any) { this.emit('error', e.message); return }
      this._pump(en, token, 0)
    })

    this._watch(dir)
  }

  _pump(en: any, token: any, count: number): void {
    en.nextFilesAsync(BATCH, GLib.PRIORITY_DEFAULT, token, (_src: any, res: any) => {
      if (token.isCancelled()) return
      let batch
      try { batch = en.nextFilesFinish(res) }
      catch (e: any) { this.emit('error', e.message); return }
      if (!batch || batch.length === 0) {
        try { en.close(null) } catch {}
        this.emit('ready', count)
        return
      }
      this.emit('items', batch)
      this._pump(en, token, count + batch.length)
    })
  }

  _watch(dir: GFile): void {
    this._unwatch()
    try {
      this.monitor = dir.monitorDirectory(Gio.FileMonitorFlags.WATCH_MOVES, null)
      this.monitor.on('changed', () => {
        if (this._debounce) return
        this._debounce = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 150, () => {
          this._debounce = 0
          this.emit('invalidated')
          return false
        })
      })
    } catch { /* some backends (recent:) have no monitor */ }
  }

  _unwatch() {
    if (this._debounce) { GLib.sourceRemove(this._debounce); this._debounce = 0 }
    if (this.monitor) { try { this.monitor.cancel() } catch {} this.monitor = null }
  }

  cancel() {
    if (this.cancellable) { try { this.cancellable.cancel() } catch {} this.cancellable = null }
    this._unwatch()
  }
}
