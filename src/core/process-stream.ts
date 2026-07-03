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
  cwd?: string
  env?: Record<string, string>
  rawLines: boolean
  cancelled = false
  paused = false
  proc: any = null
  _stderr = ''
  _outDone = false
  _errDone = false

  /* `env` augments the child environment (e.g. LC_ALL=C so tool output we parse
   * isn't localized). `rawLines` reads stdout as raw bytes split on \n, so a *blank*
   * line is a real line (the GDataInputStream path treats a zero-length read as EOF,
   * which truncates tools that print blank lines mid-output, e.g. 7z's banner). */
  constructor(argv: string[], opts: { cwd?: string; env?: Record<string, string>; rawLines?: boolean } = {}) {
    super()
    this.argv = argv
    this.cwd = opts.cwd
    this.env = opts.env
    this.rawLines = !!opts.rawLines
  }

  start(): this {
    try {
      const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      if (this.cwd || this.env) {
        const launcher = Gio.SubprocessLauncher.new(flags)
        if (this.cwd) launcher.setCwd(this.cwd)
        if (this.env) for (const [k, v] of Object.entries(this.env)) launcher.setenv(k, v, true)
        this.proc = launcher.spawnv(this.argv)
      } else {
        this.proc = Gio.Subprocess.new(this.argv, flags)
      }
    } catch (e: any) {
      GLib.idleAdd(GLib.PRIORITY_DEFAULT, () => {
        this.emit('error', `Failed to start: ${e.message}`)
        this.emit('end', false)
        return false
      })
      return this
    }
    const onOut = (line: string) => this.emit('line', line)
    const outEof = () => { this._outDone = true; this._maybeFinish() }
    if (this.rawLines) this._pumpRaw(this.proc.getStdoutPipe(), onOut, outEof)
    else this._pump(Gio.DataInputStream.new(this.proc.getStdoutPipe()), onOut, outEof)
    this._pump(Gio.DataInputStream.new(this.proc.getStderrPipe()), line => { this._stderr += line + '\n' }, () => { this._errDone = true; this._maybeFinish() }, GLib.PRIORITY_LOW)
    return this
  }

  cancel() {
    if (this.cancelled) return
    this.cancelled = true
    try { this.proc?.forceExit() } catch {}
  }

  /* SIGSTOP / SIGCONT the child (best-effort; stops only the direct child, so a
   * `tar | gzip` decompressor may run on until its pipe fills). */
  pause() {
    if (this.paused || this.cancelled) return
    this.paused = true
    try { this.proc?.sendSignal(19 /* SIGSTOP */) } catch {}
  }
  resume() {
    if (!this.paused) return
    this.paused = false
    try { this.proc?.sendSignal(18 /* SIGCONT */) } catch {}
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

  /* Raw-byte line pump: reads chunks and splits on \n in JS, so a zero-length read
   * (genuine EOF) is distinct from a blank line. Only stdout uses this (opt-in). */
  _pumpRaw(stream: any, onLine: (line: string) => void, onEof: () => void): void {
    let buf = ''
    const step = () => {
      stream.readBytesAsync(65536, GLib.PRIORITY_DEFAULT, null, (_src: any, res: any) => {
        if (this.cancelled) return
        let bytes
        try { bytes = stream.readBytesFinish(res) }
        catch (e: any) { if (!this.cancelled) this.emit('error', e.message); return }
        if (Number(bytes.getSize()) === 0) { if (buf.length) onLine(buf); onEof(); return }
        buf += Buffer.from(bytes.getData()).toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, idx)); buf = buf.slice(idx + 1) }
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
