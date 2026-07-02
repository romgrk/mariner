import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import { open } from 'node:fs/promises'
import { displayName, formatType, formatSize, formatModified, isDirectory } from '../core/format.ts'
import type { GFile, GFileInfo } from '../core/types.ts'

/* Per-content-type preview builders for Quick Look. Each returns a widget
 * synchronously; text renderers fill in asynchronously so a large file never
 * blocks. Pure UI — no app state. */

const MAX_TEXT_BYTES = 512 * 1024

/* content-types we render as plain text (beyond everything under text/*). */
const TEXT_TYPES = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/x-shellscript', 'application/x-desktop', 'application/toml',
  'application/x-yaml', 'application/yaml', 'application/sql',
])

function isTextType(ct: string): boolean {
  return ct.startsWith('text/') || TEXT_TYPES.has(ct) || ct.endsWith('+xml') || ct.endsWith('+json')
}

/* Build a preview widget for one entry. */
export function renderPreview(info: GFileInfo, file: GFile): any {
  const ct = info.getContentType() || ''
  const path = file.getPath()

  if (!isDirectory(info) && ct.startsWith('image/')) return imagePreview(file)
  if (!isDirectory(info) && (ct.startsWith('video/') || ct.startsWith('audio/'))) return mediaPreview(file)
  if (!isDirectory(info) && path && isTextType(ct)) return textPreview(path)
  return metadataCard(info, file)
}

function imagePreview(file: GFile): any {
  const pic = new Gtk.Picture({ hexpand: true, vexpand: true, canShrink: true })
  pic.setContentFit(Gtk.ContentFit.CONTAIN)
  try { pic.setFile(file) } catch { /* unreadable — leave blank */ }
  pic.addCssClass('preview-image')
  return pic
}

function mediaPreview(file: GFile): any {
  const video = Gtk.Video.newForFile(file)
  video.setAutoplay(false)
  video.setHexpand(true); video.setVexpand(true)
  return video
}

function textPreview(path: string): any {
  const buffer = new Gtk.TextBuffer()
  const tv = new Gtk.TextView({ buffer, editable: false, monospace: true, cursorVisible: false, hexpand: true, vexpand: true })
  tv.setWrapMode(Gtk.WrapMode.NONE)
  tv.setLeftMargin(12); tv.setRightMargin(12); tv.setTopMargin(8); tv.setBottomMargin(8)
  const scroller = new Gtk.ScrolledWindow({ child: tv, hexpand: true, vexpand: true })

  /* Bounded async read on the node side; hop back onto the GLib loop to touch
   * the buffer (node-gtk widgets must be mutated on the main loop). */
  readBounded(path).then(({ text, truncated }) => {
    GLib.idleAdd(GLib.PRIORITY_DEFAULT, () => {
      buffer.setText(text + (truncated ? '\n\n… (truncated)' : ''), -1)
      return false
    })
  }).catch(() => {})
  return scroller
}

async function readBounded(path: string): Promise<{ text: string; truncated: boolean }> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(MAX_TEXT_BYTES)
    const { bytesRead } = await fh.read(buf, 0, MAX_TEXT_BYTES, 0)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: bytesRead >= MAX_TEXT_BYTES }
  } finally {
    await fh.close()
  }
}

function metadataCard(info: GFileInfo, file: GFile): any {
  const page = new Adw.StatusPage({ title: displayName(info), hexpand: true, vexpand: true })
  const paintable = iconPaintable(info.getIcon?.())
  if (paintable) page.setPaintable(paintable)
  else page.setIconName(isDirectory(info) ? 'folder-symbolic' : 'text-x-generic-symbolic')
  const parts = [formatType(info)]
  if (!isDirectory(info)) parts.push(formatSize(info))
  const mod = formatModified(info)
  if (mod) parts.push(mod)
  const path = file.getPath()
  page.setDescription(parts.filter(Boolean).join(' · ') + (path ? `\n${path}` : ''))
  return page
}

/* A GdkPaintable for a GIcon at a comfortable preview size, or null. */
function iconPaintable(icon: any): any {
  if (!icon) return null
  const display = Gdk.Display.getDefault()
  if (!display) return null
  try {
    const theme = Gtk.IconTheme.getForDisplay(display)
    return theme.lookupByGicon(icon, 128, 1, Gtk.TextDirection.NONE, 0)
  } catch { return null }
}
