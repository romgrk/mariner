import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { resolve } from 'node:path'
import { AppWindow } from './window.ts'
import { debugLog, installDiagnostics } from './core/debug-log.ts'
import { fileForPath, fileForUri } from './core/gio.ts'
import { HOME } from './core/format.ts'
import { loadStyles } from './ui/style.ts'
import { ACCELS } from './accels.ts'
import type { GFile } from './core/types.ts'

/* GTK ≥ 4.22 defaults to the Vulkan renderer, which on NVIDIA-ICD dual-GPU
 * laptops renders on the discrete GPU — waking it from runtime suspend (~1s on
 * every launch) and pinning it awake for the app's lifetime. Prefer GL, which
 * follows the compositor's device. node-gtk sets the same default from its
 * register hook; this covers installs on older node-gtk releases. Read at
 * renderer creation (first window realize), so setting it here is early
 * enough. ('gl' is the renderer's name since GTK 4.18; 'ngl' still works but
 * warns on stderr.) */
process.env.GSK_RENDERER ??= 'gl'

/* Desktop-integration commands run and exit before the GApplication is created,
 * so they never activate a running instance. */
const command = process.argv[2]
if (command === '--install-desktop-entry' || command === '--uninstall-desktop-entry') {
  const entry = await import('./cli/desktop-entry.ts')
  process.exit(command === '--install-desktop-entry' ? entry.install() : entry.uninstall())
}

/* Command-line modes. Plain arguments open folders (so Mariner is the handler
 * for inode/directory). `--select <uri…>` reveals items in their parent folder
 * and `--properties <uri…>` additionally opens the Properties dialog — these
 * back org.freedesktop.FileManager1.ShowItems / ShowItemProperties, driven by
 * the D-Bus service (data/filemanager1.js). */
type Mode = 'open' | 'select' | 'properties'

function parseInvocation(args: string[]): { mode: Mode; targets: string[] } {
  if (args[0] === '--select') return { mode: 'select', targets: args.slice(1) }
  if (args[0] === '--properties') return { mode: 'properties', targets: args.slice(1) }
  return { mode: 'open', targets: args }
}

/* A CLI argument may be a path or a URI (file://, trash://, …). Relative paths
 * belong to the invoking process, which may not share the primary instance's
 * working directory. */
function fileForArg(arg: string, cwd: string): GFile {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? fileForUri(arg) : fileForPath(resolve(cwd, arg))
}

/* Initial location for `open` mode. A file argument opens its parent folder. */
function startFile(arg: string | undefined, cwd: string): GFile {
  if (!arg) return fileForPath(HOME)
  try {
    const file = fileForArg(arg, cwd)
    return file.queryFileType(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY
      ? file
      : file.getParent() ?? file
  } catch {
    return fileForPath(HOME)
  }
}

installDiagnostics()

/* Under node-gtk ESM, app.run() returns immediately; an explicit GLib.MainLoop
 * pumps the GLib loop, and is quit when the last window is removed. */
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application({
  applicationId: 'io.github.romgrk.Mariner',
  flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
})
let initialized = false

app.on('command-line', (commandLine: any) => {
  /* Unlike process.argv, ApplicationCommandLine carries the arguments and cwd
   * of every invocation, including launches forwarded to a running primary
   * instance. Its first argument is the executable name. */
  const args = (commandLine.getArguments() as string[]).slice(1)
  const cwd = commandLine.getCwd() ?? process.cwd()
  debugLog('command-line', `argv=${JSON.stringify(args)} cwd=${cwd}`)
  if (!initialized) {
    initialized = true
    loadStyles()
    for (const [action, accels] of Object.entries(ACCELS))
      app.setAccelsForAction(action, accels)
  }

  const { mode, targets } = parseInvocation(args)
  if (mode === 'open' || targets.length === 0) {
    new AppWindow(app, startFile(targets[0], cwd))
  } else {
    const uris = targets.map(t => fileForArg(t, cwd).getUri())
    /* Start at the first item's parent; revealItems groups the rest and opens
     * further tabs for items living in other folders. */
    const first = fileForUri(uris[0])
    const win = new AppWindow(app, first.getParent() ?? first)
    if (mode === 'properties') win.showItemProperties(uris)
    else win.revealItems(uris)
  }
  /* The initial invocation needs to start the explicit GLib loop. A forwarded
   * invocation is already being dispatched by that loop and must not nest it. */
  if (!loop.isRunning()) loop.run()
  return 0
})

app.on('window-added', () => debugLog('window-added', `count=${app.getWindows().length}`))
app.on('window-removed', () => {
  const count = app.getWindows().length
  debugLog('window-removed', `count=${count}`)
  if (count === 0) { debugLog('loop-quit', 'last window removed'); loop.quit() }
})

/* GApplication only forwards arguments it is explicitly given. argv[0] must
 * be the program name, so omit Node's executable but retain main.ts. */
app.run(process.argv.slice(1))
