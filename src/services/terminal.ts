import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'

/* Spawning an external terminal, shared by "Open in Terminal" and the location
 * entry's `!!command`. There is no portable way to hand a terminal emulator a
 * working directory and a command, so each launch goes through a command
 * template with two placeholders:
 *
 *   %d  the working directory
 *   %c  a single argv element holding the shell command line to run
 *
 * The command is always wrapped as `…; exec "${SHELL:-sh}"` so the window stays
 * open as a live shell after the command finishes (plain "open terminal" is the
 * degenerate case of running nothing first). The user can set a custom template
 * in Preferences (prefs.terminal); when unset, the known emulators below are
 * probed in order. The launcher's cwd is also set to %d for emulators without a
 * working-directory flag (xterm) — the flag still matters for the ones that
 * forward to an already-running server process (gnome-terminal, kgx). */

const KNOWN_TERMINALS = [
  'ptyxis --working-directory %d -- sh -c %c',
  'kgx --working-directory %d -- sh -c %c',
  'gnome-terminal --working-directory=%d -- sh -c %c',
  'konsole --workdir %d -e sh -c %c',
  'alacritty --working-directory %d -e sh -c %c',
  'foot --working-directory=%d sh -c %c',
  'xterm -e sh -c %c',
]

/* Split a template into argv (respecting quotes) and substitute placeholders.
 * node-gtk returns shellParseArgv's out param as [ok, argv] or argv depending
 * on version, so unwrap defensively. Returns null on a malformed template. */
function expandTemplate(template: string, dir: string, command: string): string[] | null {
  let argv: string[]
  try {
    const out = GLib.shellParseArgv(template) as any
    argv = Array.isArray(out?.[1]) ? out[1] : out
    if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) return null
  } catch { return null }
  return argv.map(arg => arg.replaceAll('%d', dir).replaceAll('%c', command))
}

/* Open a terminal in `dir`, running `command` first if given. Returns false
 * when no terminal could be spawned (unknown emulator and no custom template). */
export function spawnTerminal(dir: string, command: string | null, template: string): boolean {
  const keepOpen = 'exec "${SHELL:-sh}"'
  const cmdArg = command ? `${command}; ${keepOpen}` : keepOpen
  const templates = template.trim() ? [template.trim()] : KNOWN_TERMINALS
  for (const t of templates) {
    const argv = expandTemplate(t, dir, cmdArg)
    if (!argv || !argv.length) continue
    try {
      const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE)
      launcher.setCwd(dir)
      launcher.spawnv(argv)
      return true
    } catch { /* not installed — try next */ }
  }
  return false
}
