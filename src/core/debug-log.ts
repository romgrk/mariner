import GLib from 'gi:GLib-2.0'
import GLibUnix from 'gi:GLibUnix-2.0'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'

/* Append-only diagnostic journal for the "window closed by itself" class of
 * bug: every known exit path logs its reason here, so a session whose log ends
 * without an exit line died abruptly (segfault, SIGKILL/OOM) — check
 * `coredumpctl list mariner` / journalctl in that case. Lines are mirrored to
 * stderr so a terminal launch shows the reason live. */

const DIR = (GLib.getUserStateDir?.() ?? GLib.getUserConfigDir()) + '/mariner'
export const DEBUG_LOG_FILE = DIR + '/debug.log'
const MAX_SIZE = 512 * 1024

let ready = false
function ensure(): void {
  if (ready) return
  ready = true
  try {
    mkdirSync(DIR, { recursive: true })
    if (statSync(DEBUG_LOG_FILE).size > MAX_SIZE) renameSync(DEBUG_LOG_FILE, DEBUG_LOG_FILE + '.old')
  } catch { /* first run — appendFileSync creates the file */ }
}

/* Sync writes: exit paths can't await, and volume is a few lines per session. */
export function debugLog(event: string, detail = ''): void {
  const line = `${new Date().toISOString()} [${process.pid}] ${event}${detail ? ' ' + detail : ''}`
  try { ensure(); appendFileSync(DEBUG_LOG_FILE, line + '\n') } catch { /* non-fatal */ }
  if (event !== 'heartbeat')
    try { process.stderr.write(`mariner: ${line}\n`) } catch { /* non-fatal */ }
}

/* The JS stack of whoever triggered an exit, as one greppable line. */
function callSite(): string {
  return new Error().stack?.split('\n').slice(2).map(l => l.trim()).join(' | ') ?? '?'
}

export function installDiagnostics(): void {
  debugLog('start', `argv=${JSON.stringify(process.argv.slice(2))} node=${process.version}`)

  /* Patch exit so the log names the code path that decided to quit. */
  const realExit = process.exit.bind(process)
  process.exit = ((code?: number) => {
    debugLog('exit-called', `code=${code ?? 0} at=${callSite()}`)
    return realExit(code)
  }) as typeof process.exit

  process.on('exit', code => debugLog('exit', `code=${code}`))
  /* Fires only when the node event loop drains naturally — i.e. the GLib loop
   * quit and nothing called process.exit. */
  process.on('beforeExit', code => debugLog('before-exit', `code=${code} (event loop drained)`))

  /* Log then preserve node's default die-on-error behavior. */
  process.on('uncaughtException', err => {
    debugLog('uncaught-exception', err?.stack ?? String(err))
    realExit(1)
  })
  process.on('unhandledRejection', reason => {
    debugLog('unhandled-rejection', (reason as any)?.stack ?? String(reason))
    realExit(1)
  })

  /* Signals and the heartbeat go through GLib, not process.on/setInterval:
   * loop.run() blocks natively in the GLib main loop, so libuv — which
   * dispatches node-level signal handlers and timers — never gets a turn.
   * A process.on('SIGTERM') here would never fire AND would swallow the
   * default terminate disposition, making the app unkillable by TERM. */
  /* glib ≥2.88 introspects g_unix_signal_add_full as signalAdd; older
   * runtimes (GNOME 49 flatpak = glib 2.86) expose it as signalAddFull.
   * Same (priority, signum, callback) signature either way. */
  const signalAdd = GLibUnix.signalAdd ?? GLibUnix.signalAddFull
  const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
  for (const [sig, num] of Object.entries(SIGNALS))
    signalAdd(GLib.PRIORITY_DEFAULT, num, () => { debugLog('signal', sig); realExit(128 + num) })

  /* If the log ends on a heartbeat, the process was killed without warning;
   * a climbing RSS before the end points at the OOM killer. */
  GLib.timeoutAddSeconds(GLib.PRIORITY_DEFAULT, 60, () => {
    debugLog('heartbeat', `rss=${Math.round(process.memoryUsage.rss() / (1024 * 1024))}MB`)
    return true
  })
}
