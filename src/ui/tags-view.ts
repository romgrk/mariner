import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { tagsService, TAG_COLORS } from '../services/tags-service.ts'
import type { Tag } from '../services/tags-service.ts'
import { ATTRS, fileForUri } from '../core/gio.ts'
import { displayName, formatSize, formatModified } from '../core/format.ts'
import { promptText, confirm } from './dialogs.ts'
import { newTagDialog, swatchBox } from './new-tag-dialog.ts'
import { makeDropTarget } from './dnd.ts'
import { tagIconName } from './tag-icons.ts'
import type { GFile } from '../core/types.ts'

/* The Tags overview — the tag:/// location ("All Tags"), after the whiteboard
 * #332 "all tags" page: one collapsible, accent-tinted section per tag listing
 * its files (name, size, modified), and a bottom bar with "New Tag…" and an
 * "Edit Tags" toggle that swaps in per-tag controls (pin to sidebar, rename,
 * recolor, delete). Activating a file reveals it in its folder. A pure view —
 * the pane wires onOpenEntry and calls refresh() on navigation/tag changes. */
export interface TagsView {
  widget: any
  refresh: () => void
  onOpenEntry: (file: GFile) => void
}

export function createTagsView(): TagsView {
  const sections = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, valign: Gtk.Align.START })

  const clamp = new Adw.Clamp({ maximumSize: 860, child: sections, marginTop: 18, marginBottom: 18, marginStart: 12, marginEnd: 12 })
  const scroller = new Gtk.ScrolledWindow({ child: clamp, vexpand: true, hexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER })

  const bar = new Gtk.ActionBar()
  const editBtn = new Gtk.ToggleButton({ label: 'Edit Tags' })
  const newBtn = new Gtk.Button({ label: 'New Tag…' })
  newBtn.addCssClass('suggested-action')
  bar.packEnd(editBtn)
  bar.packEnd(newBtn)

  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  root.append(scroller)
  root.append(bar)

  const api: TagsView = { widget: root, refresh, onOpenEntry: () => {} }

  /* Per-tag expansion survives refreshes for the lifetime of the view. */
  const expanded = new Set<string>()
  let generation = 0
  let firstRefresh = true

  newBtn.on('clicked', () => newTagDialog(root))
  editBtn.on('toggled', refresh)

  function refresh(): void {
    generation++
    let c
    while ((c = sections.getFirstChild()) !== null) sections.remove(c)
    const counts = tagsService.counts()
    const tags = tagsService.tags()
    /* Open the first non-empty section on first show (like the mockup), so the
     * page doesn't read as a wall of collapsed bars. */
    if (firstRefresh) {
      firstRefresh = false
      const first = tags.find(t => (counts.get(t.name) ?? 0) > 0)
      if (first) expanded.add(first.name)
    }
    for (const tag of tags) sections.append(section(tag, counts.get(tag.name) ?? 0))
    if (!tags.length) {
      const empty = new Adw.StatusPage({ iconName: tagIconName(), title: 'No Tags', description: 'Create a tag to organize files across folders.' })
      sections.append(empty)
    }
  }

  function section(tag: Tag, count: number): any {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    const isOpen = expanded.has(tag.name)

    /* Header: an accent-tinted bar. A Box (not a Button) so the edit-mode
     * controls can be real buttons inside it — they claim their own clicks,
     * everywhere else the click gesture toggles expansion. */
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
    header.addCssClass('mariner-tag-section')
    if (tag.color) header.addCssClass('tag-section-' + tag.color)

    header.append(new Gtk.Image({ iconName: isOpen ? 'pan-down-symbolic' : 'pan-end-symbolic' }))
    const name = new Gtk.Label({ label: tag.name, xalign: 0, ellipsize: 3 /* END */ })
    name.addCssClass('mariner-tag-section-name')
    header.append(name)
    const countLabel = new Gtk.Label({ label: `${count} file${count === 1 ? '' : 's'}`, hexpand: true, xalign: 0 })
    countLabel.addCssClass('dim-label')
    header.append(countLabel)

    if (editBtn.getActive()) {
      for (const w of editControls(tag, count)) header.append(w)
    }

    const gesture = new Gtk.GestureClick({ button: 1 })
    gesture.on('released', () => {
      if (expanded.has(tag.name)) expanded.delete(tag.name)
      else expanded.add(tag.name)
      refresh()
    })
    header.addController(gesture)

    /* Drop files on the header to tag them. */
    header.addController(makeDropTarget(files => tagsService.addTag(files, tag.name)))

    box.append(header)
    if (isOpen) box.append(fileList(tag))
    return box
  }

  /* Edit-mode controls: pin-to-sidebar toggle, recolor, rename, delete. */
  function editControls(tag: Tag, count: number): any[] {
    const pin = new Gtk.ToggleButton({ iconName: 'view-pin-symbolic', active: tag.pinned, valign: Gtk.Align.CENTER, tooltipText: tag.pinned ? 'Shown in sidebar' : 'Hidden from sidebar' })
    pin.addCssClass('flat')
    pin.on('toggled', () => tagsService.setTagPinned(tag.name, pin.getActive()))

    const recolor = new Gtk.MenuButton({ valign: Gtk.Align.CENTER, tooltipText: 'Change Color' })
    recolor.addCssClass('flat')
    recolor.setChild(swatchBox(tag.color))
    const pop = new Gtk.Popover()
    const pal = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 })
    for (const c of [...TAG_COLORS.map(x => x.key), null]) {
      const b = new Gtk.Button({ valign: Gtk.Align.CENTER })
      b.addCssClass('flat')
      b.setChild(swatchBox(c))
      b.on('clicked', () => { pop.popdown(); tagsService.setTagColor(tag.name, c) })
      pal.append(b)
    }
    pop.setChild(pal)
    recolor.setPopover(pop)

    const rename = new Gtk.Button({ iconName: 'document-edit-symbolic', valign: Gtk.Align.CENTER, tooltipText: 'Rename' })
    rename.addCssClass('flat')
    rename.on('clicked', async () => {
      const next = await promptText(root, { heading: 'Rename Tag', value: tag.name, okLabel: 'Rename' })
      if (next && next !== tag.name) tagsService.renameTag(tag.name, next)
    })

    const del = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltipText: 'Delete Tag' })
    del.addCssClass('flat')
    del.on('clicked', async () => {
      if (count > 0) {
        const ok = await confirm(root, {
          heading: `Delete the tag “${tag.name}”?`,
          body: `It will be removed from ${count} file${count === 1 ? '' : 's'}. The files themselves are not affected.`,
          okLabel: 'Delete',
        })
        if (!ok) return
      }
      tagsService.deleteTag(tag.name)
    })

    return [pin, recolor, rename, del]
  }

  /* The expanded body: this tag's files, resolved asynchronously and sorted by
   * name. Missing files are pruned from the index as they're discovered. */
  function fileList(tag: Tag): any {
    const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE })
    list.addCssClass('mariner-tag-files')
    list.setActivateOnSingleClick(false)
    list.on('row-activated', (...a: any[]) => {
      const row = a[a.length - 1]
      if (row?._file) api.onOpenEntry(row._file)
    })

    const uris = tagsService.filesWith(tag.name)
    if (!uris.length) {
      const empty = new Gtk.Label({ label: 'No files with this tag', xalign: 0, marginStart: 12, marginTop: 8, marginBottom: 8 })
      empty.addCssClass('dim-label')
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
      box.append(empty)
      return box
    }

    const gen = generation
    const resolved: Array<{ file: GFile; info: any }> = []
    let pending = uris.length
    const settle = (): void => {
      if (--pending > 0 || gen !== generation) return
      resolved.sort((a, b) => displayName(a.info).localeCompare(displayName(b.info)))
      for (const { file, info } of resolved) list.append(entryRow(file, info))
    }
    for (const uri of uris) {
      const file = fileForUri(uri)
      file.queryInfoAsync(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (_src: any, res: any) => {
        try { resolved.push({ file, info: file.queryInfoFinish(res) }) }
        catch { tagsService.dropUri(uri) }
        settle()
      })
    }
    return list
  }

  function entryRow(file: GFile, info: any): any {
    const row = new Gtk.ListBoxRow({ activatable: true })
    row._file = file
    const b = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10, marginStart: 12, marginEnd: 12, marginTop: 5, marginBottom: 5 })
    const image = new Gtk.Image({ pixelSize: 16 })
    const icon = info.getIcon()
    if (icon) image.setFromGicon(icon)
    b.append(image)
    b.append(new Gtk.Label({ label: displayName(info), xalign: 0, hexpand: true, ellipsize: 3 }))
    const size = new Gtk.Label({ label: formatSize(info), xalign: 1 })
    size.addCssClass('dim-label')
    b.append(size)
    const modified = new Gtk.Label({ label: formatModified(info), xalign: 1, widthChars: 12 })
    modified.addCssClass('dim-label')
    b.append(modified)
    row.setChild(b)
    return row
  }

  refresh()
  return api
}
