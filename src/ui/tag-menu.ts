import Gtk from 'gi:Gtk-4.0'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { tagsService } from '../services/tags-service.ts'
import type { Tag } from '../services/tags-service.ts'
import { checkedSwatch, swatchBox } from './new-tag-dialog.ts'
import type { GFile } from '../core/types.ts'

/* Custom widgetry for the context menu's Tags section: an inline horizontal
 * row of color dots (toggle by clicking; the menu stays open for multi-
 * tagging), and — when more tags exist than fit inline — a "More Tags"
 * submenu listing every tag as dot + name + check. Both are Gtk.PopoverMenu
 * custom children (menu items with a `custom` attribute, filled in via
 * addChild); customMenuSupported() probes once whether node-gtk can do that,
 * and the context menu falls back to plain toggle items when it can't. */

/* How many dots fit an inline row at typical context-menu width. */
export const TAG_DOTS_FIT = 9

let _supported: boolean | null = null
export function customMenuSupported(): boolean {
  if (_supported != null) return _supported
  try {
    const menu = Gio.Menu.new()
    const item = Gio.MenuItem.new('probe', null)
    item.setAttributeValue('custom', GLib.Variant.newString('probe'))
    menu.appendItem(item)
    const pop = Gtk.PopoverMenu.newFromModel(menu)
    _supported = pop.addChild(new Gtk.Label({ label: '' }), 'probe') === true
  } catch { _supported = false }
  return _supported
}

/* A Gio.MenuItem placeholder to be filled with the custom widget `id`. */
export function customMenuItem(id: string): any {
  const item = Gio.MenuItem.new(id, null)
  item.setAttributeValue('custom', GLib.Variant.newString(id))
  return item
}

const allHave = (files: GFile[], name: string): boolean =>
  files.length > 0 && files.every(f => tagsService.tagsOf(f.getUri()).includes(name))

/* A clickable dot: the tag's swatch with a check overlay when every selected
 * file carries the tag. Clicking toggles and updates the check in place. */
function dotButton(tag: Tag, files: GFile[], onToggle: (name: string) => void): any {
  const btn = new Gtk.Button({ tooltipText: tag.name })
  btn.addCssClass('flat')
  btn.addCssClass('mariner-menu-dot')
  const swatch = checkedSwatch(tag.color, allHave(files, tag.name))
  btn.setChild(swatch)
  btn.on('clicked', () => {
    onToggle(tag.name)
    swatch._check.setVisible(allHave(files, tag.name))
  })
  return btn
}

/* The inline dots row: the first TAG_DOTS_FIT tags as dots, plus a "+" that
 * opens the New Tag dialog (via onNewTag, which also closes the menu). */
export function buildTagDotsRow(files: GFile[], onToggle: (name: string) => void, onNewTag: () => void): any {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 })
  row.addCssClass('mariner-menu-dot-row')
  for (const tag of tagsService.visibleTags().slice(0, TAG_DOTS_FIT))
    row.append(dotButton(tag, files, onToggle))
  const add = new Gtk.Button({ iconName: 'list-add-symbolic', tooltipText: 'New Tag…' })
  add.addCssClass('flat')
  add.addCssClass('mariner-menu-dot')
  add.on('clicked', onNewTag)
  row.append(add)
  return row
}

/* The submenu's full tag list: one row per tag — dot, name, trailing check —
 * toggling in place like the dots. */
export function buildTagListRows(files: GFile[], onToggle: (name: string) => void): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  for (const tag of tagsService.visibleTags()) {
    const btn = new Gtk.Button()
    btn.addCssClass('flat')
    btn.addCssClass('mariner-menu-tag-row')
    const h = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
    h.append(swatchBox(tag.color))
    h.append(new Gtk.Label({ label: tag.name, xalign: 0, hexpand: true, ellipsize: 3 /* END */ }))
    const check = new Gtk.Image({ iconName: 'object-select-symbolic', visible: allHave(files, tag.name) })
    h.append(check)
    btn.setChild(h)
    btn.on('clicked', () => {
      onToggle(tag.name)
      check.setVisible(allHave(files, tag.name))
    })
    box.append(btn)
  }
  return box
}
