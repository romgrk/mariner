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
import { tagIconName } from './tag-icons.ts'
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

  const title = new Gtk.Label({ xalign: 0, hexpand: true })
  title.addCssClass('title-2')

  const hiddenBtn = new Gtk.Button({ label: 'Hidden Tags' })
  const newBtn = new Gtk.Button({ label: 'New Tag…' })
  newBtn.addCssClass('suggested-action')

  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
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
      subtitle: `${count} file${count === 1 ? '' : 's'}`,
      activatable: true,
    })
    r._file = fileForUri(tagUri(tag.name))
    r.addPrefix(swatchBox(tag.color))

    if (hiddenMode) {
      const unhide = new Gtk.Button({ label: 'Unhide', valign: Gtk.Align.CENTER })
      unhide.on('clicked', () => tagsService.setTagHidden(tag.name, false))
      r.addSuffix(unhide)
    }
    r.addSuffix(rowMenu(tag, count))

    /* Drop files on a row to tag them. */
    r.addController(makeDropTarget(files => tagsService.addTag(files, tag.name)))

    if (!hiddenMode) attachReorder(r, tag, tags, index)
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

  /* Drag a row onto another to reorder: dropping on the top half inserts
   * before that row, on the bottom half after it. */
  function attachReorder(r: any, tag: Tag, tags: Tag[], index: number): void {
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
    source.on('prepare', () => {
      try { return Gdk.ContentProvider.newForValue(stringValue(tag.name)) } catch { return null }
    })
    r.addController(source)

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
  }

  refresh()
  return api
}
