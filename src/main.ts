import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { AppWindow } from './window.ts'
import { fileForPath } from './core/gio.ts'
import { HOME } from './core/format.ts'

/* Under node-gtk ESM, app.run() returns immediately; an explicit GLib.MainLoop
 * pumps the GLib loop, and is quit when the last window is removed. */
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application('com.github.nodegtk.nautilusclone', 0)

const ACCELS: Record<string, string[]> = {
  'win.back': ['<alt>Left'],
  'win.forward': ['<alt>Right'],
  'win.up': ['<alt>Up'],
  'win.reload': ['<ctrl>r', 'F5'],
  'win.new-tab': ['<ctrl>t'],
  'win.new-window': ['<ctrl>n'],
  'win.close-tab': ['<ctrl>w'],
  'win.location': ['<ctrl>l'],
  'win.search': ['<ctrl>f'],
  'win.show-hidden': ['<ctrl>h'],
  'win.select-all': ['<ctrl>a'],
  'win.copy': ['<ctrl>c'],
  'win.cut': ['<ctrl>x'],
  'win.paste': ['<ctrl>v'],
  'win.rename': ['F2'],
  'win.trash': ['Delete'],
  'win.delete': ['<shift>Delete'],
  'win.new-folder': ['<ctrl><shift>n'],
  'win.zoom-in': ['<ctrl>plus', '<ctrl>equal'],
  'win.zoom-out': ['<ctrl>minus'],
  'win.properties': ['<ctrl>Return'],
  'win.quit': ['<ctrl>q'],
}

app.on('activate', () => {
  for (const [action, accels] of Object.entries(ACCELS))
    app.setAccelsForAction(action, accels)
  new AppWindow(app, fileForPath(HOME))
  loop.run()
})

app.on('window-removed', () => {
  if (app.getWindows().length === 0) loop.quit()
})

app.run()
