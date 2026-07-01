import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppWindow } from './window.ts'
import { fileForPath } from './core/gio.ts'
import { HOME } from './core/format.ts'
import { loadStyles } from './ui/style.ts'
import { ACCELS } from './accels.ts'

/* Initial location: a folder path or file:// URI passed on the command line
 * (so Mariner can act as the default handler for inode/directory), else HOME.
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

/* Under node-gtk ESM, app.run() returns immediately; an explicit GLib.MainLoop
 * pumps the GLib loop, and is quit when the last window is removed. */
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application('com.github.nodegtk.mariner', 0)

app.on('activate', () => {
  loadStyles()
  for (const [action, accels] of Object.entries(ACCELS))
    app.setAccelsForAction(action, accels)
  new AppWindow(app, fileForPath(startPath()))
  loop.run()
})

app.on('window-removed', () => {
  if (app.getWindows().length === 0) {
    loop.quit()
    /* Exit explicitly, as node-gtk otherwise keeps the process alive with GLib handles. */
    process.exit(0)
  }
})

app.run()
