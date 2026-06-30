import Gtk from 'gi:Gtk-4.0'
import Pango from 'gi:Pango-1.0'
import { displayName, formatSize, formatType, formatModified } from '../core/format.ts'
import type { GFileInfo } from '../core/types.ts'

/* Cell factories for the grid and list views. `ctx` provides the live icon size
 * and a hook to wire a right-click menu onto each cell. Factory/bind callbacks
 * in node-gtk receive a single arg: the GtkListItem. */
export interface CellContext {
  iconSize: () => number
  attachMenu: (widget: any, item: any) => void
}

type Formatter = (info: GFileInfo) => string

export function gridFactory(ctx: CellContext): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 6,
      halign: Gtk.Align.CENTER, valign: Gtk.Align.START,
      marginTop: 6, marginBottom: 6, marginStart: 4, marginEnd: 4,
      widthRequest: 100,
    })
    box.append(new Gtk.Image({ pixelSize: ctx.iconSize() }))
    box.append(new Gtk.Label({
      ellipsize: Pango.EllipsizeMode.END, wrap: true,
      wrapMode: Pango.WrapMode.WORD_CHAR, lines: 2,
      justify: Gtk.Justification.CENTER, maxWidthChars: 14,
    }))
    item.setChild(box)
    ctx.attachMenu(box, item)
  })
  factory.on('bind', (item: any) => {
    const info = item.getItem()
    const box = item.getChild()
    const image = box.getFirstChild()
    image.setPixelSize(ctx.iconSize())
    const icon = info.getIcon()
    if (icon) image.setFromGicon(icon)
    else image.setFromIconName('text-x-generic')
    box.getLastChild().setLabel(displayName(info))
  })
  return factory
}

export function nameColumn(ctx: CellContext): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
    box.append(new Gtk.Image({ pixelSize: 16 }))
    box.append(new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, xalign: 0 }))
    item.setChild(box)
    ctx.attachMenu(box, item)
  })
  factory.on('bind', (item: any) => {
    const info = item.getItem()
    const box = item.getChild()
    const icon = info.getIcon()
    if (icon) box.getFirstChild().setFromGicon(icon)
    box.getLastChild().setLabel(displayName(info))
  })
  const col = new Gtk.ColumnViewColumn({ title: 'Name', factory })
  col.setExpand(true)
  return col
}

export function metaColumn(title: string, fmt: Formatter, rightAlign = false): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    const label = new Gtk.Label({ xalign: rightAlign ? 1 : 0, ellipsize: Pango.EllipsizeMode.END })
    label.addCssClass('dim-label')
    item.setChild(label)
  })
  factory.on('bind', (item: any) => item.getChild().setLabel(fmt(item.getItem())))
  const col = new Gtk.ColumnViewColumn({ title, factory })
  col.setResizable(true)
  return col
}

export const COLUMNS: Array<[string, Formatter, boolean]> = [
  ['Size', formatSize, true],
  ['Type', formatType, false],
  ['Modified', formatModified, false],
]
