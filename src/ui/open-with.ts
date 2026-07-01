import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import { F } from '../core/gio.ts'
import { displayName } from '../core/format.ts'
import type { GFile, GFileInfo } from '../core/types.ts'

/* "Open With" chooser: lists the apps registered for the file's content type
 * and launches the picked one, mirroring nautilus's app chooser. */
export function openWithDialog(parent: any, info: GFileInfo, file: GFile): void {
  const ct = info.getContentType?.() || 'application/octet-stream'
  const apps = Gio.AppInfo.getRecommendedForType(ct)
  const list = (apps && apps.length ? apps : Gio.AppInfo.getAllForType(ct)) || []
  const uri = F.getUri(file)

  const dialog = new Adw.Dialog()
  dialog.setTitle(`Open “${displayName(info)}” With`)
  dialog.setContentWidth(420)
  dialog.setContentHeight(480)

  const tv = new Adw.ToolbarView()
  tv.addTopBar(new Adw.HeaderBar())
  const page = new Adw.PreferencesPage()
  const group = new Adw.PreferencesGroup()

  if (!list.length) group.add(new Adw.ActionRow({ title: 'No applications found' }))
  for (const app of list) {
    const row = new Adw.ActionRow({ title: app.getDisplayName(), activatable: true })
    const icon = app.getIcon()
    if (icon) { const img = new Gtk.Image(); img.setFromGicon(icon); row.addPrefix(img) }
    row.on('activated', () => {
      try { app.launchUris([uri], null) } catch { /* launch failed */ }
      dialog.close()
    })
    group.add(row)
  }

  page.add(group)
  tv.setContent(page)
  dialog.setChild(tv)
  dialog.present(parent)
}
