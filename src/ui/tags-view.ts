import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'
import { tagsService, tagUri, HIDDEN_TAGS_URI } from '../services/tags-service.ts'
import type { Tag } from '../services/tags-service.ts'
import { fileForUri } from '../core/gio.ts'
import { confirm } from './dialogs.ts'
import { newTagDialog, editTagDialog, swatchBox } from './new-tag-dialog.ts'
import { makeDropTarget } from './dnd.ts'
import { tagIconName, dragHandle } from './tag-icons.ts'
import type { GFile } from '../core/types.ts'

/* The Tags overview — rendered at tag:/// ("All Tags") and tag:///,hidden
 * ("Hidden Tags"). A wide boxed list, one row per tag: color dot, name, file
 * count, and a "⋮" menu (Edit / Hide / Delete; Unhide on the hidden page).
 * Activating a row opens the tag's own location (same as the sidebar); rows
 * are drag-reorderable, and that order drives the sidebar and the context
 * menu. The title row holds "Hidden Tags" and "New Tag…". A pure view — the
 * pane wires onNavigate and calls setMode() + refresh() on navigation. */
export interface TagsView {
  widget: any
  refresh: () => void
  setMode: (hidden: boolean) => void
  onNavigate: (file: GFile) => void
}

const STRING_TYPE = GObject.typeFromName('gchararray')

function stringValue(s: string): any {
  const v = new GObject.Value()
  v.init(STRING_TYPE)
  v.setString(s)
  return v
}

/* The dropped value may arrive as a raw string or wrapped in a GValue. */
function droppedString(value: any): string | null {
  try {
    if (typeof value === 'string') return value
    if (value && typeof value.getString === 'function') return value.getString()
  } catch {}
  return null
}

export function createTagsView(): TagsView {
  let hiddenMode = false

  const titleIcon = new Gtk.Image({ iconName: tagIconName() })
  const title = new Gtk.Label({ xalign: 0, hexpand: true })
  title.addCssClass('title-2')

  const hiddenBtn = new Gtk.Button({ label: 'Hidden Tags' })
  const newBtn = new Gtk.Button()
  newBtn.setChild(new Adw.ButtonContent({ iconName: 'list-add-symbolic', label: 'New Tag…' }))
  newBtn.addCssClass('suggested-action')

  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
  header.append(titleIcon)
  header.append(title)
  header.append(hiddenBtn)
  header.append(newBtn)

  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE })
  list.addCssClass('boxed-list')
  list.setActivateOnSingleClick(true)
  list.on('row-activated', (...a: any[]) => {
    const row = a[a.length - 1]
    if (row?._file) api.onNavigate(row._file)
  })

  const emptyAll = new Adw.StatusPage({ iconName: tagIconName(), title: 'No Tags', description: 'Create a tag to organize files across folders.' })
  const emptyHidden = new Gtk.Label({ label: 'No hidden tags', marginTop: 24 })
  emptyHidden.addCssClass('dim-label')

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 14 })
  content.append(header)
  content.append(list)
  content.append(emptyAll)
  content.append(emptyHidden)

  const clamp = new Adw.Clamp({ maximumSize: 860, child: content, marginTop: 24, marginBottom: 24, marginStart: 12, marginEnd: 12 })
  const scroller = new Gtk.ScrolledWindow({ child: clamp, vexpand: true, hexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER })

  const api: TagsView = { widget: scroller, refresh, setMode, onNavigate: () => {} }

  hiddenBtn.on('clicked', () => api.onNavigate(fileForUri(HIDDEN_TAGS_URI)))
  newBtn.on('clicked', () => newTagDialog(scroller))

  function setMode(hidden: boolean): void { hiddenMode = hidden }

  function refresh(): void {
    title.setLabel(hiddenMode ? 'Hidden Tags' : 'All Tags')
    hiddenBtn.setVisible(!hiddenMode)
    newBtn.setVisible(!hiddenMode)

    let c
    while ((c = list.getFirstChild()) !== null) list.remove(c)
    const counts = tagsService.counts()
    const tags = hiddenMode ? tagsService.hiddenTags() : tagsService.visibleTags()
    tags.forEach((tag, i) => list.append(row(tag, counts.get(tag.name) ?? 0, tags, i)))

    list.setVisible(tags.length > 0)
    emptyAll.setVisible(!hiddenMode && tags.length === 0)
    emptyHidden.setVisible(hiddenMode && tags.length === 0)
  }

  function row(tag: Tag, count: number, tags: Tag[], index: number): any {
    const r = new Adw.ActionRow({
      title: GLib.markupEscapeText(tag.name, -1),
      activatable: true,
    })
    r._file = fileForUri(tagUri(tag.name))
    /* add_prefix prepends, so the LAST-added prefix is leftmost: swatch first,
     * then the drag handle so it leads the whole row. */
    r.addPrefix(swatchBox(tag.color))
    if (!hiddenMode) r.addPrefix(reorderHandle(r, tag, tags, index))

    if (hiddenMode) {
      const unhide = new Gtk.Button({ label: 'Unhide', valign: Gtk.Align.CENTER })
      unhide.on('clicked', () => tagsService.setTagHidden(tag.name, false))
      r.addSuffix(unhide)
    }
    /* Trailing: count, then a chevron (rows navigate to the tag's own
     * listing), then a separator setting the ⋮ menu apart. */
    const countLabel = new Gtk.Label({ label: `${count} file${count === 1 ? '' : 's'}` })
    countLabel.addCssClass('dim-label')
    r.addSuffix(countLabel)
    const chevron = new Gtk.Image({ iconName: 'go-next-symbolic', valign: Gtk.Align.CENTER })
    chevron.addCssClass('dim-label')
    r.addSuffix(chevron)
    r.addSuffix(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, marginTop: 14, marginBottom: 14 }))
    r.addSuffix(rowMenu(tag, count))

    /* Drop files on a row to tag them. */
    r.addController(makeDropTarget(files => tagsService.addTag(files, tag.name)))

    return r
  }

  /* The "⋮" menu: Edit (name + color in one dialog), Hide/Unhide, Delete. */
  function rowMenu(tag: Tag, count: number): any {
    const menu = new Gtk.MenuButton({ iconName: 'view-more-symbolic', valign: Gtk.Align.CENTER })
    menu.addCssClass('flat')
    const pop = new Gtk.Popover()
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, marginTop: 4, marginBottom: 4 })

    const item = (label: string, cb: () => void, destructive = false): void => {
      const b = new Gtk.Button({ label, halign: Gtk.Align.FILL })
      b.addCssClass('flat')
      b.getChild()?.setXalign?.(0)
      if (destructive) b.addCssClass('destructive-action')
      b.on('clicked', () => { pop.popdown(); cb() })
      box.append(b)
    }

    item('Edit…', () => editTagDialog(scroller, tag))
    item(tag.hidden ? 'Unhide' : 'Hide', () => tagsService.setTagHidden(tag.name, !tag.hidden))
    item('Delete', async () => {
      if (count > 0) {
        const ok = await confirm(scroller, {
          heading: `Delete the tag “${tag.name}”?`,
          body: `It will be removed from ${count} file${count === 1 ? '' : 's'}. The files themselves are not affected.`,
          okLabel: 'Delete',
        })
        if (!ok) return
      }
      tagsService.deleteTag(tag.name)
    }, true)

    pop.setChild(box)
    menu.setPopover(pop)
    return menu
  }

  /* Reorder by dragging the six-dot handle onto another row: dropping on the
   * top half inserts before that row, on the bottom half after it. The drag
   * starts from the handle only, so plain row clicks stay activations; the
   * whole row is the drop target. */
  function reorderHandle(r: any, tag: Tag, tags: Tag[], index: number): any {
    const handle = dragHandle()
    handle.setValign(Gtk.Align.CENTER)
    handle.addCssClass('dim-label')
    handle.addCssClass('mariner-drag-handle')
    handle.setTooltipText('Drag to reorder')
    try { handle.setCursor(Gdk.Cursor.newFromName('grab', null)) } catch {}

    const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
    source.on('prepare', () => {
      try { return Gdk.ContentProvider.newForValue(stringValue(tag.name)) } catch { return null }
    })
    /* Show the whole row as the drag icon, grabbed roughly at the handle. */
    source.on('drag-begin', (...a: any[]) => {
      try { Gtk.DragIcon.setFromPaintable(a[a.length - 1], new Gtk.WidgetPaintable({ widget: r }), 16, 16) } catch {}
    })
    handle.addController(source)

    const target = Gtk.DropTarget.new(STRING_TYPE, Gdk.DragAction.MOVE)
    target.on('drop', (...a: any[]) => {
      const dragged = droppedString(a[0])
      if (!dragged || dragged === tag.name || !tagsService.getTag(dragged)) return false
      const y = a[2] ?? 0
      const after = y > r.getAllocatedHeight() / 2
      const before = after ? (tags[index + 1]?.name ?? null) : tag.name
      /* Dropping right where it already sits is a no-op. */
      if (before !== dragged) tagsService.moveTagBefore(dragged, before)
      return true
    })
    r.addController(target)

    return handle
  }

  refresh()
  return api
}
