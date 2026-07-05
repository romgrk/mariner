import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

function parseInvocation(): { mode: Mode; targets: string[] } {
  const args = process.argv.slice(2)
  if (args[0] === '--select') return { mode: 'select', targets: args.slice(1) }
  if (args[0] === '--properties') return { mode: 'properties', targets: args.slice(1) }
  return { mode: 'open', targets: args }
}

/* A CLI argument may be a path or a URI (file://, trash://, …). */
function fileForArg(arg: string): GFile {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? fileForUri(arg) : fileForPath(resolve(arg))
}

/* Initial location for `open` mode: a folder path or file:// URI, else HOME.
 * A file argument opens its parent directory. */
function startPath(): string {
  const arg = process.argv[2]
  if (!arg) return HOME
  try {
    const abs = resolve(arg.startsWith('file://') ? fileURLToPath(arg) : arg)
    return statSync(abs).isDirectory() ? abs : dirname(abs)
  } catch {
    return HOME
  }
}

installDiagnostics()

/* Under node-gtk ESM, app.run() returns immediately; an explicit GLib.MainLoop
 * pumps the GLib loop, and is quit when the last window is removed. */
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application({ applicationId: 'com.github.romgrk.mariner', flags: 0 })

app.on('activate', () => {
  /* Fires on the primary instance for every launch, including remote ones
   * (single-instance GApplication), so repeats here mean another invocation
   * — xdg-open, the FileManager1 service, a test run — reached this process. */
  debugLog('activate', `argv=${JSON.stringify(process.argv.slice(2))}`)
  loadStyles()
  for (const [action, accels] of Object.entries(ACCELS))
    app.setAccelsForAction(action, accels)

  const { mode, targets } = parseInvocation()
  if (mode === 'open' || targets.length === 0) {
    new AppWindow(app, fileForPath(startPath()))
  } else {
    const uris = targets.map(t => fileForArg(t).getUri())
    /* Start at the first item's parent; revealItems groups the rest and opens
     * further tabs for items living in other folders. */
    const first = fileForUri(uris[0])
    const win = new AppWindow(app, first.getParent() ?? first)
    if (mode === 'properties') win.showItemProperties(uris)
    else win.revealItems(uris)
  }
  loop.run()
})

app.on('window-added', () => debugLog('window-added', `count=${app.getWindows().length}`))
app.on('window-removed', () => {
  const count = app.getWindows().length
  debugLog('window-removed', `count=${count}`)
  if (count === 0) { debugLog('loop-quit', 'last window removed'); loop.quit() }
})

app.run()
