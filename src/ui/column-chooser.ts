import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { COLUMN_DEF, defaultColumnConfig, normalizeColumns } from '../core/columns.ts'
import type { ColumnConfig } from '../core/types.ts'

/* "Visible Columns" dialog — the list-view column chooser, mirroring GNOME
 * Files' NautilusColumnChooser. A boxed list where the Name column is fixed
 * first and every other column is a switch row that can be toggled on/off and
 * moved up/down. Changes apply live via `onChange` (like nautilus's "changed"
 * signal), so there's no OK/Cancel — closing keeps the current state.
 *
 * We reorder with explicit move buttons rather than drag-and-drop: it's fully
 * keyboard/pointer reliable and headlessly verifiable, and node-gtk's DnD is
 * neither. Reordering rebuilds the list; toggling doesn't (keeps the switch). */
export function columnChooserDialog(
  parent: any,
  configs: ColumnConfig[],
  onChange: (configs: ColumnConfig[]) => void,
): void {
  let columns = normalizeColumns(configs)

  const dialog = new Adw.Dialog({ title: 'Visible Columns', contentWidth: 360, contentHeight: 480 })
  const toolbarView = new Adw.ToolbarView()
  const header = new Adw.HeaderBar()
  const reset = new Gtk.Button({ label: 'Reset', tooltipText: 'Restore the default columns' })
  reset.addCssClass('flat')
  reset.on('clicked', () => { columns = defaultColumnConfig(); rebuild(); emit() })
  header.packEnd(reset)
  toolbarView.addTopBar(header)

  const listBox = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE })
  listBox.addCssClass('boxed-list')
  const group = new Adw.PreferencesGroup()
  group.add(listBox)
  const page = new Adw.PreferencesPage()
  page.add(group)
  toolbarView.setContent(page)
  dialog.setChild(toolbarView)

  function emit(): void { onChange(columns.map(c => ({ id: c.id, visible: c.visible }))) }

  function move(index: number, delta: number): void {
    const j = index + delta
    if (j < 0 || j >= columns.length) return
    const tmp = columns[index]; columns[index] = columns[j]; columns[j] = tmp
    rebuild()
    emit()
  }

  function rebuild(): void {
    listBox.removeAll()
    listBox.append(nameRow())
    columns.forEach((c, i) => listBox.append(columnRow(c, i)))
  }

  /* The Name column is always shown and always first — a static, inert row. */
  function nameRow(): any {
    return new Adw.ActionRow({ title: 'Name', subtitle: 'Always shown first', activatable: false })
  }

  function columnRow(config: ColumnConfig, index: number): any {
    const def = COLUMN_DEF[config.id]
    const row = new Adw.SwitchRow({ title: def.label, active: config.visible })
    row.on('notify::active', () => { config.visible = row.getActive(); emit() })

    const up = moveButton('go-up-symbolic', 'Move Up', index > 0, () => move(index, -1))
    const down = moveButton('go-down-symbolic', 'Move Down', index < columns.length - 1, () => move(index, +1))
    row.addSuffix(up)
    row.addSuffix(down)
    return row
  }

  function moveButton(icon: string, tooltip: string, enabled: boolean, onClick: () => void): any {
    const b = new Gtk.Button({ iconName: icon, tooltipText: tooltip, valign: Gtk.Align.CENTER, sensitive: enabled })
    b.addCssClass('flat')
    b.on('clicked', onClick)
    return b
  }

  rebuild()
  dialog.present(parent)
}
