import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { AppWindow } from './window.ts'
import { fileForPath } from './core/gio.ts'
import { HOME } from './core/format.ts'
import { loadStyles } from './ui/style.ts'
import { ACCELS } from './accels.ts'

/* Under node-gtk ESM, app.run() returns immediately; an explicit GLib.MainLoop
 * pumps the GLib loop, and is quit when the last window is removed. */
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application('com.github.nodegtk.nautilusclone', 0)

app.on('activate', () => {
  loadStyles()
  for (const [action, accels] of Object.entries(ACCELS))
    app.setAccelsForAction(action, accels)
  new AppWindow(app, fileForPath(HOME))
  loop.run()
})

app.on('window-removed', () => {
  if (app.getWindows().length === 0) loop.quit()
})

app.run()
