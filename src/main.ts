import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { AppWindow } from './window.ts'
import { fileForPath } from './core/gio.ts'
import { HOME } from './core/format.ts'
import { loadStyles } from './ui/style.ts'

/* Under node-gtk ESM, app.run() returns immediately; an explicit GLib.MainLoop
 * pumps the GLib loop, and is quit when the last window is removed. */
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application('com.github.nodegtk.nautilusclone', 0)

const ACCELS: Record<string, string[]> = {
  'win.back': ['<alt>Left'],
  'win.forward': ['<alt>Right'],
  'win.up': ['<alt>Up'],
  'win.go-home': ['<alt>Home'],
  'win.reload': ['<ctrl>r', 'F5'],
  'win.new-tab': ['<ctrl>t'],
  'win.new-window': ['<ctrl>n'],
  'win.close-tab': ['<ctrl>w'],
  'win.tab-prev': ['<ctrl>Page_Up'],
  'win.tab-next': ['<ctrl>Page_Down'],
  'win.location': ['<ctrl>l'],
  'win.search': ['<ctrl>f'],
  'win.show-hidden': ['<ctrl>h'],
  'win.select-all': ['<ctrl>a'],
  'win.invert-selection': ['<ctrl><shift>i'],
  'win.copy': ['<ctrl>c'],
  'win.cut': ['<ctrl>x'],
  'win.paste': ['<ctrl>v'],
  'win.undo': ['<ctrl>z'],
  'win.redo': ['<ctrl><shift>z'],
  'win.open-new-tab': ['<ctrl>Return'],
  'win.rename': ['F2'],
  'win.create-link': ['<ctrl>m'],
  'win.trash': ['Delete'],
  'win.delete': ['<shift>Delete'],
  'win.new-folder': ['<ctrl><shift>n'],
  'win.view-list': ['<ctrl>1'],
  'win.view-grid': ['<ctrl>2'],
  'win.zoom-in': ['<ctrl>plus', '<ctrl>equal'],
  'win.zoom-out': ['<ctrl>minus'],
  'win.zoom-reset': ['<ctrl>0'],
  'win.properties': ['<ctrl>i', '<alt>Return'],
  'win.preferences': ['<ctrl>comma'],
  'win.shortcuts': ['<ctrl>question', '<ctrl>slash'],
  'win.quit': ['<ctrl>q'],
}

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
