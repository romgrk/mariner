import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { SIDEBAR_ITEMS } from '../services/places-service.ts'
import { tagsService } from '../services/tags-service.ts'
import { saveViewPrefs } from '../services/view-prefs.ts'
import type { AppWindow } from '../window.ts'
import type { SortKey, ViewMode } from '../core/types.ts'

const VIEW_MODES: ViewMode[] = ['grid', 'list']
const SORT_KEYS: SortKey[] = ['name', 'size', 'type', 'modified']

/* Preferences dialog (win.preferences), a thin editor over AppWindow.prefs. It
 * writes through the same paths the header/menu actions use so all surfaces stay
 * in sync. Adw.PreferencesDialog + rows, mirroring GNOME Files' preferences.
 * Two titled pages — the dialog shows an Adw.ViewSwitcher in its header bar to
 * flip between them. */
export function preferencesDialog(parent: any, win: AppWindow): void {
  const dialog = new Adw.PreferencesDialog()
  dialog.setTitle('Preferences')
  const page = new Adw.PreferencesPage({ title: 'General', iconName: 'preferences-system-symbolic' })

  const viewGroup = new Adw.PreferencesGroup({ title: 'Views' })
  viewGroup.add(comboRow('Default View', ['Grid', 'List'], VIEW_MODES.indexOf(win.prefs.viewMode),
    i => win._setViewMode(VIEW_MODES[i])))
  viewGroup.add(switchRow('Show Hidden Files', win.prefs.showHidden, v => {
    win.prefs.showHidden = v
    win.hiddenAction.setState(GLib.Variant.newBoolean(v))
    win.activeTab?.applyPrefs()
  }))
  page.add(viewGroup)

  const sortGroup = new Adw.PreferencesGroup({ title: 'Sorting' })
  sortGroup.add(comboRow('Sort By', ['Name', 'Size', 'Type', 'Modified'], SORT_KEYS.indexOf(win.prefs.sortKey),
    i => { win.prefs.sortKey = SORT_KEYS[i]; win._syncSort(); win.activeTab?.applyPrefs() }))
  sortGroup.add(switchRow('Descending Order', win.prefs.sortDesc, v => {
    win.prefs.sortDesc = v
    win.sortDescAction.setState(GLib.Variant.newBoolean(v))
    win.activeTab?.applyPrefs()
  }))
  page.add(sortGroup)

  /* Tags kill switch: hides tags from every UI surface (sidebar, cell dots,
   * menus, search, palette); the tag data itself is kept. Stored in the tags
   * database, so every window and Mariner process follows. */
  const tagsGroup = new Adw.PreferencesGroup({ title: 'Tags' })
  const tagsRow = new Adw.SwitchRow({
    title: 'Enable Tags',
    subtitle: 'Show tags in the sidebar, file views and menus',
    active: tagsService.enabled,
  })
  tagsRow.on('notify::active', () => tagsService.setEnabled(tagsRow.getActive()))
  tagsGroup.add(tagsRow)
  page.add(tagsGroup)

  /* Template used by Open in Terminal and the location entry's `!!command`
   * (see services/terminal.ts). Empty = probe the known emulators. */
  const termGroup = new Adw.PreferencesGroup({
    title: 'Terminal',
    description: 'Command used to open an external terminal. %d is the directory, %c the command to run. Leave empty to auto-detect.',
  })
  const termRow = new Adw.EntryRow({ title: 'Terminal Command', text: win.prefs.terminal })
  termRow.on('notify::text', () => {
    win.prefs.terminal = termRow.getText().trim()
    saveViewPrefs(win.prefs)
  })
  termGroup.add(termRow)
  page.add(termGroup)

  const sidebarPage = new Adw.PreferencesPage({ title: 'Sidebar', iconName: 'sidebar-show-symbolic' })
  const sidebarGroup = new Adw.PreferencesGroup({ title: 'Visible Items' })
  for (const item of SIDEBAR_ITEMS)
    sidebarGroup.add(switchRow(item.label, !win.prefs.sidebarHidden.includes(item.id),
      v => win._setSidebarItemVisible(item.id, v)))
  sidebarPage.add(sidebarGroup)

  dialog.add(page)
  dialog.add(sidebarPage)
  dialog.present(parent)
}

function switchRow(title: string, active: boolean, onChange: (v: boolean) => void): any {
  const row = new Adw.SwitchRow({ title, active })
  row.on('notify::active', () => onChange(row.getActive()))
  return row
}

function comboRow(title: string, labels: string[], selected: number, onChange: (i: number) => void): any {
  const row = new Adw.ComboRow({ title, model: Gtk.StringList.new(labels), selected: Math.max(0, selected) })
  row.on('notify::selected', () => onChange(row.getSelected()))
  return row
}
