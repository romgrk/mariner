import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import Pango from 'gi:Pango-1.0'
import { ProcessStream } from '../core/process-stream.ts'

/* Output panel for `!command` typed in the location entry: runs the command
 * through the user's shell in the tab's directory and streams the combined
 * stdout+stderr into a monospace log at the bottom of the content area.
 *
 *   Revealer .command-panel (ToolbarView bottom bar)
 *     Box (vertical)
 *       Box header: "$ cmd" | ✓/✗ status | spinner | stop | close
 *       ScrolledWindow (grows with content up to a cap)
 *         TextView (read-only, selectable, monospace)
 *
 * The panel never flashes: it stays hidden until there is evidence the user
 * needs it — the first output line, a command still running after REVEAL_MS, or
 * a non-zero exit. A command that exits 0 silently only shows a toast. Commands
 * run non-interactively (stdin is /dev/null, the Gio.Subprocess default), so
 * prompts fail fast instead of hanging — that failure shows in the panel, and
 * `!!command` (external terminal) is the escape hatch. One command at a time
 * per window; the panel persists across tab switches and navigation until
 * dismissed (close button, or Esc with focus inside). */

export interface CommandPanel {
  widget: any
  /* Launch `command` in `cwd`; onDone fires once when it exits, is stopped, or
   * fails to spawn (reload the launching tab — it likely changed). */
  run: (command: string, cwd: string, onDone: () => void) => void
  /* Same as the ✕ button: stop the command if running, hide the panel. */
  close: () => void
}

/* Reveal a still-quiet command after this long, so slow ones have a visible
 * spinner and Stop button. */
const REVEAL_MS = 300

/* Keep the TextView responsive under runaway output (`!yes`, a verbose build):
 * past the cap lines are counted, not appended; the stream is still drained so
 * EOF and the exit status arrive. */
const MAX_LINES = 2000

/* CSI/OSC escape sequences (colors, cursor movement, window titles). Most tools
 * disable them on a non-tty; strip the stragglers rather than render garbage. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b[@-_]/g

export function createCommandPanel(onToast: (message: string) => void): CommandPanel {
  const revealer = new Gtk.Revealer({
    transitionType: Gtk.RevealerTransitionType.SLIDE_UP,
    revealChild: false,
  })

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  box.addCssClass('command-panel')
  revealer.setChild(box)

  /* Header row */
  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
  header.addCssClass('command-panel-header')

  const cmdLabel = new Gtk.Label({ hexpand: true, xalign: 0, singleLineMode: true })
  cmdLabel.addCssClass('command-panel-cmd')
  cmdLabel.setEllipsize(Pango.EllipsizeMode.END)
  header.append(cmdLabel)

  const statusLabel = new Gtk.Label({ singleLineMode: true, visible: false })
  header.append(statusLabel)

  const spinner = new Gtk.Spinner({ visible: false })
  header.append(spinner)

  const stopButton = new Gtk.Button({ iconName: 'media-playback-stop-symbolic', tooltipText: 'Stop Command', visible: false })
  stopButton.addCssClass('flat')
  header.append(stopButton)

  const closeButton = new Gtk.Button({ iconName: 'window-close-symbolic', tooltipText: 'Close' })
  closeButton.addCssClass('flat')
  header.append(closeButton)

  box.append(header)

  /* Output */
  const textView = new Gtk.TextView({
    editable: false,
    cursorVisible: false,
    monospace: true,
    leftMargin: 12, rightMargin: 12, topMargin: 2, bottomMargin: 6,
  })
  textView.addCssClass('command-panel-output')
  const buffer = textView.getBuffer()

  const scrolled = new Gtk.ScrolledWindow({ maxContentHeight: 240, propagateNaturalHeight: true })
  scrolled.setPolicy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
  scrolled.setChild(textView)
  box.append(scrolled)

  /* Tail-follow: pinned to the bottom while lines stream in, unpinned the
   * moment the user scrolls up, re-pinned when they scroll back down. */
  let pinned = true
  const vadj = scrolled.getVadjustment()
  vadj.on('value-changed', () => {
    pinned = vadj.getValue() >= vadj.getUpper() - vadj.getPageSize() - 1
  })
  vadj.on('changed', () => {
    if (pinned) vadj.setValue(vadj.getUpper() - vadj.getPageSize())
  })

  /* ---- Run state (one command slot) ---- */
  let stream: ProcessStream | null = null
  let running = false
  let currentCommand = ''
  let lineCount = 0
  let truncated = false
  let errored = false
  let revealTimer = 0
  let done: () => void = () => {}

  function appendText(text: string): void {
    try { buffer.insert(buffer.getEndIter(), text, -1) } catch {}
  }

  function setStatus(text: string | null, cls: 'success' | 'error' | null): void {
    statusLabel.removeCssClass('success')
    statusLabel.removeCssClass('error')
    if (text === null) { statusLabel.setVisible(false); return }
    statusLabel.setText(text)
    if (cls) statusLabel.addCssClass(cls)
    statusLabel.setVisible(true)
  }

  function cancelRevealTimer(): void {
    if (revealTimer) { try { GLib.sourceRemove(revealTimer) } catch {}; revealTimer = 0 }
  }

  function reveal(): void {
    cancelRevealTimer()
    revealer.setRevealChild(true)
  }

  function setRunning(on: boolean): void {
    running = on
    spinner.setVisible(on)
    if (on) spinner.start(); else spinner.stop()
    stopButton.setVisible(on)
    closeButton.setTooltipText(on ? 'Stop and Close' : 'Close')
  }

  /* The command exited; `code` is null when the exit status could not be read.
   * A quiet success never shows the panel — just a toast. */
  function finish(code: number | null): void {
    if (!running) return
    setRunning(false)
    if (code !== null && code !== 0) { setStatus(`✗ exit ${code}`, 'error'); reveal() }
    else if (lineCount === 0 && !errored) {
      /* Quiet success (or quiet with unreadable exit status): skip the panel. */
      cancelRevealTimer()
      revealer.setRevealChild(false)
      onToast(`✓ ${currentCommand}`)
    } else if (code === 0) setStatus('✓', 'success')
    else setStatus(errored ? '✗' : 'done', errored ? 'error' : null)
    done()
  }

  /* Both pipes hit EOF, so the shell has exited and waitAsync resolves
   * immediately; the timeout covers node-gtk dropping the callback (waitAsync
   * has been unreliable before — see ProcessStream._maybeFinish). */
  function fetchExitCode(s: ProcessStream): void {
    let fallback = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 1500, () => { fallback = 0; finish(null); return false })
    try {
      s.proc.waitAsync(null, () => {
        if (fallback) { try { GLib.sourceRemove(fallback) } catch {}; fallback = 0 }
        let code: number | null = null
        try { code = s.proc.getIfExited() ? s.proc.getExitStatus() : null } catch {}
        finish(code)
      })
    } catch {
      if (fallback) { try { GLib.sourceRemove(fallback) } catch {}; fallback = 0 }
      finish(null)
    }
  }

  function stop(): void {
    if (!running || !stream) return
    stream.cancel()
    setRunning(false)
    setStatus('✗ stopped', 'error')
    done()
  }

  function close(): void {
    stop()
    cancelRevealTimer()
    revealer.setRevealChild(false)
  }

  stopButton.on('clicked', stop)
  closeButton.on('clicked', close)

  /* Esc closes the panel when focus is inside it (e.g. selecting output). */
  const key = new Gtk.EventControllerKey()
  key.on('key-pressed', (...a: any[]) => {
    if (a[0] === Gdk.KEY_Escape) { close(); return true }
    return false
  })
  box.addController(key)

  /* Strip escape sequences, and keep only the final state of \r-rewritten
   * progress lines (`50%\r100%` should read `100%`). */
  function cleanLine(line: string): string {
    const noCr = line.replace(/\r+$/, '')
    const last = noCr.slice(noCr.lastIndexOf('\r') + 1)
    return last.replace(ANSI, '')
  }

  function run(command: string, cwd: string, onDone: () => void): void {
    if (running) {
      reveal()
      onToast(`A command is already running — stop it first`)
      return
    }

    buffer.setText('', -1)
    lineCount = 0
    truncated = false
    errored = false
    pinned = true
    currentCommand = command
    done = onDone
    setStatus(null, null)
    cmdLabel.setText(`$ ${command}`)
    cmdLabel.setTooltipText(`${command}\nin ${cwd}`)
    setRunning(true)

    /* Reveal on evidence the user needs the panel, not on Enter: the first
     * output line, slowness, or (in finish) a failure. */
    cancelRevealTimer()
    revealTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, REVEAL_MS, () => {
      revealTimer = 0
      if (running) revealer.setRevealChild(true)
      return false
    })

    const shell = GLib.getenv('SHELL') || '/bin/sh'
    const s = new ProcessStream([shell, '-c', command], { cwd, rawLines: true, mergeStderr: true })
    stream = s
    s.on('line', (line: string) => {
      if (s !== stream) return
      lineCount++
      if (lineCount > MAX_LINES) {
        if (!truncated) { truncated = true; appendText(`… output truncated at ${MAX_LINES} lines\n`) }
        return
      }
      appendText(cleanLine(line) + '\n')
      reveal()
    })
    s.on('error', (message: string) => {
      if (s !== stream) return
      errored = true
      appendText(message + '\n')
      reveal()
    })
    s.on('end', () => { if (s === stream) fetchExitCode(s) })
    s.start()
  }

  return { widget: revealer, run, close }
}
