import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { TAG_COLOR } from '../services/tags-service.ts'

/* Adwaita has no guaranteed "tag" symbolic; prefer one when the theme provides
 * it, else fall back to the star (tags are the starred feature's successor). */
let _iconName: string | null = null
export function tagIconName(): string {
  if (_iconName) return _iconName
  try {
    const theme = Gtk.IconTheme.getForDisplay(Gdk.Display.getDefault())
    _iconName = theme.hasIcon('tag-symbolic') ? 'tag-symbolic' : 'starred-symbolic'
  } catch { _iconName = 'starred-symbolic' }
  return _iconName
}

/* The six-dot reorder handle. The themed icon when available, else a braille
 * ⠿ label that reads the same. */
export function dragHandle(): any {
  try {
    const theme = Gtk.IconTheme.getForDisplay(Gdk.Display.getDefault())
    if (theme.hasIcon('list-drag-handle-symbolic'))
      return new Gtk.Image({ iconName: 'list-drag-handle-symbolic' })
  } catch {}
  return new Gtk.Label({ label: '⠿' })
}

/* A GIcon of a small filled circle in the tag's color — the dot shown on the
 * context menu's tag toggle items. A tiny inline SVG via BytesIcon (rendered by
 * the gdk-pixbuf svg loader), cached per color. */
const circleIcons = new Map<string, any>()
export function tagColorIcon(colorKey: string | null): any | null {
  if (!colorKey || !TAG_COLOR[colorKey]) return null
  let icon = circleIcons.get(colorKey)
  if (!icon) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="${TAG_COLOR[colorKey].hex}"/></svg>`
    icon = Gio.BytesIcon.new(new GLib.Bytes(Buffer.from(svg, 'utf8')))
    circleIcons.set(colorKey, icon)
  }
  return icon
}
