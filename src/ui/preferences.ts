import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import type { AppWindow } from '../window.ts'
import type { SortKey, ViewMode } from '../core/types.ts'

const VIEW_MODES: ViewMode[] = ['grid', 'list']
const SORT_KEYS: SortKey[] = ['name', 'size', 'type', 'modified']

/* Preferences dialog (win.preferences), a thin editor over AppWindow.prefs. It
 * writes through the same paths the header/menu actions use so all surfaces stay
 * in sync. Adw.PreferencesDialog + rows, mirroring GNOME Files' preferences. */
export function preferencesDialog(parent: any, win: AppWindow): void {
  const dialog = new Adw.PreferencesDialog()
  dialog.setTitle('Preferences')
  const page = new Adw.PreferencesPage()

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

  dialog.add(page)
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
