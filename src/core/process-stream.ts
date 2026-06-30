import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { EventEmitter } from './emitter.ts'

/* Streams a child process's stdout line by line, GLib-native (Gio.Subprocess +
 * async readLine), so it is serviced by the GLib loop where libuv handles are
 * not. Events: 'line' (string), 'end' (ok: boolean), 'error' (message: string).
 *
 * readLineFinish returns [bytes, length]; bytes is a plain JS number[]. node-gtk
 * maps EOF (NULL) to an *empty* array — indistinguishable from a blank line — so
 * a zero-length read is treated as EOF. Callers must use a line protocol that
 * never emits blank lines (ours emits JSON-encoded paths). */
export class ProcessStream extends EventEmitter {
  argv: string[]
  cancelled = false
  proc: any = null
  _stderr = ''
  _outDone = false
  _errDone = false

  constructor(argv: string[]) {
    super()
    this.argv = argv
  }

  start(): this {
    try {
      const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      this.proc = Gio.Subprocess.new(this.argv, flags)
    } catch (e: any) {
      GLib.idleAdd(GLib.PRIORITY_DEFAULT, () => {
        this.emit('error', `Failed to start: ${e.message}`)
        this.emit('end', false)
        return false
      })
      return this
    }
    this._pump(Gio.DataInputStream.new(this.proc.getStdoutPipe()), line => this.emit('line', line), () => { this._outDone = true; this._maybeFinish() })
    this._pump(Gio.DataInputStream.new(this.proc.getStderrPipe()), line => { this._stderr += line + '\n' }, () => { this._errDone = true; this._maybeFinish() }, GLib.PRIORITY_LOW)
    return this
  }

  cancel() {
    if (this.cancelled) return
    this.cancelled = true
    try { this.proc?.forceExit() } catch {}
  }

  _pump(stream: any, onLine: (line: string) => void, onEof: () => void, priority = GLib.PRIORITY_DEFAULT): void {
    const step = () => {
      stream.readLineAsync(priority, null, (_src: any, res: any) => {
        if (this.cancelled) return
        let out
        try { out = stream.readLineFinish(res) }
        catch (e: any) { if (!this.cancelled) this.emit('error', e.message); return }
        const bytes = out[0]
        if (bytes === null || bytes.length === 0) { onEof(); return }
        onLine(Buffer.from(bytes).toString('utf8'))
        step()
      })
    }
    step()
  }

  /* Finalize once both pipes hit EOF (the child has closed its output). This is
   * more reliable in node-gtk than Gio.Subprocess.waitAsync. */
  _maybeFinish(): void {
    if (this.cancelled || !this._outDone || !this._errDone) return
    const err = this._stderr.trim()
    if (err) this.emit('error', err)
    this.emit('end', !err)
  }
}
