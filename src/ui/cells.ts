import Gtk from 'gi:Gtk-4.0'
import Pango from 'gi:Pango-1.0'
import { thumbnails } from '../services/thumbnail-service.ts'
import { tagsService } from '../services/tags-service.ts'
import { displayName } from '../core/format.ts'
import type { ColumnDef } from '../core/columns.ts'
import type { GFileInfo } from '../core/types.ts'

/* Maximum colored dots drawn on a cell; further tags collapse into "+n". */
const MAX_DOTS = 3

/* Repopulate a cell's tag-dots box: one colored dot per (colored) tag, a "+n"
 * overflow, and the full tag list as the tooltip. Text tags (no color) only
 * count toward the overflow — a grey dot for them would read as noise. */
function applyTagDots(dots: any, info: GFileInfo): void {
  let c
  while ((c = dots.getFirstChild()) !== null) dots.remove(c)
  const file = info._file
  const tags = file ? tagsService.tagObjectsOf(file.getUri()) : []
  if (!tags.length) { dots.setVisible(false); return }
  const colored = tags.filter(t => t.color).slice(0, MAX_DOTS)
  for (const t of colored) {
    const dot = new Gtk.Box({ valign: Gtk.Align.CENTER })
    dot.addCssClass('mariner-tag-dot')
    dot.addCssClass('tag-color-' + t.color)
    dots.append(dot)
  }
  const extra = tags.length - colored.length
  if (extra > 0) {
    const more = new Gtk.Label({ label: colored.length ? `+${extra}` : `${extra} tag${extra > 1 ? 's' : ''}` })
    more.addCssClass('mariner-tag-more')
    more.addCssClass('dim-label')
    dots.append(more)
  }
  dots.setTooltipText(tags.map(t => t.name).join(', '))
  dots.setVisible(true)
}

function makeDotsBox(halign: any): any {
  const dots = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, halign, valign: Gtk.Align.CENTER, visible: false })
  dots.addCssClass('mariner-tag-dots')
  return dots
}

/* Cell factories for the grid and list views. `ctx` provides the live icon size
 * and a hook to wire a right-click menu onto each cell. Factory/bind callbacks
 * in node-gtk receive a single arg: the GtkListItem. */
export interface CellContext {
  iconSize: () => number
  attachMenu: (widget: any, item: any) => void
  isCut: (info: GFileInfo) => boolean
}

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
  const path = file && file.getPath()
  if (!path) { image._thumbKey = null; return }
  const uri = file.getUri()
  const key = uri + '|' + info.getAttributeUint64('time::modified')
  image._thumbKey = key
  thumbnails.request({ key, path, uri, contentType: info.getContentType() || '', bytes: Number(info.getSize()) }, tex => {
    if (tex && image._thumbKey === key) image.setFromPaintable(tex)
  })
}

export function gridFactory(ctx: CellContext): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    /* Spacing/padding come from the .mariner-view-cell + gridview CSS. */
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 6,
      halign: Gtk.Align.CENTER, valign: Gtk.Align.START,
      widthRequest: 100,
    })
    box.addCssClass('mariner-view-cell')
    const image = new Gtk.Image({ pixelSize: ctx.iconSize() })
    image.addCssClass('mariner-image')
    box.append(image)
    box.append(new Gtk.Label({
      ellipsize: Pango.EllipsizeMode.END, wrap: true,
      wrapMode: Pango.WrapMode.WORD_CHAR, lines: 2,
      justify: Gtk.Justification.CENTER, maxWidthChars: 14,
    }))
    box.append(makeDotsBox(Gtk.Align.CENTER))
    item.setChild(box)
    ctx.attachMenu(box, item)
  })
  factory.on('bind', (item: any) => {
    const info = item.getItem()
    const box = item.getChild()
    const image = box.getFirstChild()
    const label = image.getNextSibling()
    image.setPixelSize(ctx.iconSize())
    const icon = info.getIcon()
    if (icon) image.setFromGicon(icon)
    else image.setFromIconName('text-x-generic')
    label.setLabel(displayName(info))
    applyTagDots(label.getNextSibling(), info)
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
    box.addCssClass('mariner-view-cell')
    const image = new Gtk.Image({ pixelSize: 16 })
    image.addCssClass('mariner-image')
    box.append(image)
    box.append(new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, xalign: 0 }))
    box.append(makeDotsBox(Gtk.Align.START))
    item.setChild(box)
    ctx.attachMenu(box, item)
  })
  factory.on('bind', (item: any) => {
    const info = item.getItem()
    const box = item.getChild()
    const image = box.getFirstChild()
    const label = image.getNextSibling()
    const icon = info.getIcon()
    if (icon) image.setFromGicon(icon)
    label.setLabel(displayName(info))
    applyTagDots(label.getNextSibling(), info)
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

/* A resizable text column driven by a registry ColumnDef (its label + pure
 * formatter). The FileView keeps its own ordered list of these to rebuild the
 * visible column set. The factory is exported separately so refreshCells can
 * rebind meta cells whose data lives outside the model (e.g. the Tags column). */
export function metaFactory(def: ColumnDef): any {
  const factory = new Gtk.SignalListItemFactory()
  factory.on('setup', (item: any) => {
    const label = new Gtk.Label({ xalign: def.rightAlign ? 1 : 0, ellipsize: Pango.EllipsizeMode.END })
    label.addCssClass('dim-label')
    label.addCssClass('mariner-meta-cell')
    item.setChild(label)
  })
  factory.on('bind', (item: any) => item.getChild().setLabel(def.format(item.getItem())))
  return factory
}

export function metaColumn(def: ColumnDef): any {
  const col = new Gtk.ColumnViewColumn({ title: def.label, factory: metaFactory(def) })
  col.setResizable(true)
  col._def = def   /* JS prop survives on the wrapper; used by refreshCells */
  return col
}
