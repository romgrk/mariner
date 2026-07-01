import Gtk from 'gi:Gtk-4.0'
import Pango from 'gi:Pango-1.0'
import { F } from '../core/gio.ts'
import { thumbnails } from '../services/thumbnail-service.ts'
import { displayName, formatSize, formatType, formatModified } from '../core/format.ts'
import type { GFileInfo } from '../core/types.ts'

/* Cell factories for the grid and list views. `ctx` provides the live icon size
 * and a hook to wire a right-click menu onto each cell. Factory/bind callbacks
 * in node-gtk receive a single arg: the GtkListItem. */
export interface CellContext {
  iconSize: () => number
  attachMenu: (widget: any, item: any) => void
  isCut: (info: GFileInfo) => boolean
}

type Formatter = (info: GFileInfo) => string

/* Dim hidden/backup files (styled by `.view .hidden-file` in style.css). */
function toggleHidden(widget: any, info: GFileInfo): void {
  const hidden = info.getIsHidden() || info.getIsBackup()
  if (hidden) widget.addCssClass('hidden-file')
  else widget.removeCssClass('hidden-file')
}

/* Fade cells whose file is on the clipboard as a cut (nautilus dims cut files
 * until they're pasted). Applied on the cell box so icon + label both dim. */
function applyCut(box: any, info: GFileInfo, ctx: CellContext): void {
  box.setOpacity(ctx.isCut(info) ? 0.45 : 1)
}

/* Swap in a thumbnail once resolved. Guards against cell recycling by tagging
 * the image with the key it is currently displaying. */
function applyThumbnail(image: any, info: GFileInfo): void {
  const file = info._file
  const path = file && F.getPath(file)
  if (!path) { image._thumbKey = null; return }
  const uri = F.getUri(file)
  const key = uri + '|' + info.getAttributeUint64('time::modified')
  image._thumbKey = key
  thumbnails.request({ key, path, uri, contentType: info.getContentType() || '', bytes: Number(info.getSize()) }, tex => {
    if (tex && image._thumbKey === key) image.setFromPaintable(tex)
  })
}

export function gridFactory(ctx: CellContext): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    /* Spacing/padding come from the .nautilus-view-cell + gridview CSS. */
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 6,
      halign: Gtk.Align.CENTER, valign: Gtk.Align.START,
      widthRequest: 100,
    })
    box.addCssClass('nautilus-view-cell')
    const image = new Gtk.Image({ pixelSize: ctx.iconSize() })
    image.addCssClass('nautilus-image')
    box.append(image)
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
    toggleHidden(box, info)
    applyCut(box, info, ctx)
    applyThumbnail(image, info)
  })
  return factory
}

export function nameCellFactory(ctx: CellContext): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
    box.addCssClass('nautilus-view-cell')
    const image = new Gtk.Image({ pixelSize: 16 })
    image.addCssClass('nautilus-image')
    box.append(image)
    box.append(new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, xalign: 0 }))
    item.setChild(box)
    ctx.attachMenu(box, item)
  })
  factory.on('bind', (item: any) => {
    const info = item.getItem()
    const box = item.getChild()
    const image = box.getFirstChild()
    const icon = info.getIcon()
    if (icon) image.setFromGicon(icon)
    box.getLastChild().setLabel(displayName(info))
    toggleHidden(box, info)
    applyCut(box, info, ctx)
    applyThumbnail(image, info)
  })
  return factory
}

export function nameColumn(ctx: CellContext): any {
  const col = new Gtk.ColumnViewColumn({ title: 'Name', factory: nameCellFactory(ctx) })
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
