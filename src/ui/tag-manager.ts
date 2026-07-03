import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import GLib from 'gi:GLib-2.0'
import { tagsService, tagUri, TAG_COLORS } from '../services/tags-service.ts'
import { fileForUri } from '../core/gio.ts'
import { promptText, confirm } from './dialogs.ts'
import type { Tag } from '../services/tags-service.ts'
import type { GFile } from '../core/types.ts'

/* The tag manager ("All Tags…" / "New Tag…"): every tag as a row — color
 * swatch (click to recolor), name, file count, rename + delete — plus a
 * creation form. Activating a row navigates to the tag's virtual location.
 * Live: rebuilds on any tags-service change (including from other windows). */
export function tagManagerDialog(parent: any, onNavigate: (file: GFile) => void = () => {}): void {
  const dialog = new Adw.Dialog()
  dialog.setTitle('Tags')
  dialog.setContentWidth(440)

  const tv = new Adw.ToolbarView()
  tv.addTopBar(new Adw.HeaderBar())

  const page = new Adw.PreferencesPage()

  /* ---- color swatch helpers ---- */

  const swatchBox = (color: string | null): any => {
    const dot = new Gtk.Box({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
    dot.addCssClass('mariner-tag-swatch')
    if (color) dot.addCssClass('tag-color-' + color)
    else dot.addCssClass('no-color')
    return dot
  }

  /* A row of clickable swatches (the nine palette colors + "no color"). */
  const palette = (onPick: (color: string | null) => void): any => {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
    for (const color of [...TAG_COLORS.map(c => c.key), null]) {
      const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltipText: color ? (TAG_COLORS.find(c => c.key === color)?.label ?? color) : 'No color (text tag)' })
      b.addCssClass('flat')
      b.setChild(swatchBox(color))
      b.on('clicked', () => onPick(color))
      box.append(b)
    }
    return box
  }

  /* ---- tag rows ---- */

  const addTagRow = (group: any, tag: Tag, count: number): void => {
    const row = new Adw.ActionRow({
      title: GLib.markupEscapeText(tag.name, -1),
      subtitle: `${count} file${count === 1 ? '' : 's'}`,
      activatable: true,
    })

    /* Prefix swatch opens a recolor popover. */
    const pick = new Gtk.MenuButton({ valign: Gtk.Align.CENTER, tooltipText: 'Change Color' })
    pick.addCssClass('flat')
    pick.setChild(swatchBox(tag.color))
    const pop = new Gtk.Popover()
    const pal = palette(color => { pop.popdown(); tagsService.setTagColor(tag.name, color) })
    pal.setMarginTop(6); pal.setMarginBottom(6); pal.setMarginStart(6); pal.setMarginEnd(6)
    pop.setChild(pal)
    pick.setPopover(pop)
    row.addPrefix(pick)

    const rename = new Gtk.Button({ iconName: 'document-edit-symbolic', valign: Gtk.Align.CENTER, tooltipText: 'Rename' })
    rename.addCssClass('flat')
    rename.on('clicked', async () => {
      const name = await promptText(dialog, { heading: 'Rename Tag', value: tag.name, okLabel: 'Rename' })
      if (name && name !== tag.name) tagsService.renameTag(tag.name, name)
    })
    row.addSuffix(rename)

    const del = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltipText: 'Delete Tag' })
    del.addCssClass('flat')
    del.on('clicked', async () => {
      if (count > 0) {
        const ok = await confirm(dialog, {
          heading: `Delete the tag “${tag.name}”?`,
          body: `It will be removed from ${count} file${count === 1 ? '' : 's'}. The files themselves are not affected.`,
          okLabel: 'Delete',
        })
        if (!ok) return
      }
      tagsService.deleteTag(tag.name)
    })
    row.addSuffix(del)

    /* Activate → browse the tag's files. */
    row.on('activated', () => { dialog.close(); onNavigate(fileForUri(tagUri(tag.name))) })

    group.add(row)
  }

  /* ---- creation form ---- */

  let newColor: string | null = null
  const buildNewGroup = (): any => {
    const group = new Adw.PreferencesGroup({ title: 'New Tag' })
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })

    const entryRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
    const entry = new Gtk.Entry({ placeholderText: 'Tag name', hexpand: true, activatesDefault: false })
    const addBtn = new Gtk.Button({ label: 'Add' })
    addBtn.addCssClass('suggested-action')
    entryRow.append(entry)
    entryRow.append(addBtn)
    box.append(entryRow)

    /* Color choice: highlight the picked swatch; "no color" makes a text tag. */
    const swatches: Array<{ button: any; color: string | null }> = []
    const pal = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
    for (const color of [...TAG_COLORS.map(c => c.key), null]) {
      const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltipText: color ? (TAG_COLORS.find(c => c.key === color)?.label ?? color) : 'No color (text tag)' })
      b.addCssClass('flat')
      if (color === newColor) b.addCssClass('selected-swatch')
      b.setChild(swatchBox(color))
      b.on('clicked', () => {
        newColor = color
        for (const s of swatches) {
          if (s.color === color) s.button.addCssClass('selected-swatch')
          else s.button.removeCssClass('selected-swatch')
        }
      })
      swatches.push({ button: b, color })
      pal.append(b)
    }
    box.append(pal)

    const create = (): void => {
      const name = entry.getText().trim()
      if (!name) return
      if (tagsService.createTag(name, newColor)) entry.setText('')
      /* invalid/duplicate name: leave the text for the user to fix */
    }
    addBtn.on('clicked', create)
    entry.on('activate', create)

    group.add(box)
    return group
  }

  /* ---- assembly + live rebuild ---- */

  let listGroup: any = null
  let newGroup: any = null
  const rebuild = (): void => {
    if (listGroup) page.remove(listGroup)
    if (newGroup) page.remove(newGroup)
    listGroup = new Adw.PreferencesGroup({ title: 'Tags' })
    const counts = tagsService.counts()
    const tags = tagsService.tags()
    for (const tag of tags) addTagRow(listGroup, tag, counts.get(tag.name) ?? 0)
    if (!tags.length) listGroup.add(new Adw.ActionRow({ title: 'No tags yet', subtitle: 'Create one below' }))
    newGroup = buildNewGroup()
    page.add(listGroup)
    page.add(newGroup)
  }
  rebuild()

  const onChanged = (): void => rebuild()
  tagsService.on('changed', onChanged)
  dialog.on('closed', () => tagsService.off('changed', onChanged))

  tv.setContent(page)
  dialog.setChild(tv)
  dialog.present(parent)
}
