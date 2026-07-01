import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { F } from './gio.ts'
import type { GFile, GFileInfo } from './types.ts'

export const HOME: string = GLib.getHomeDir()

export function isDirectory(info: GFileInfo): boolean {
  return info.getFileType() === Gio.FileType.DIRECTORY
}

export function displayName(info: GFileInfo): string {
  return info.getDisplayName() || info.getName()
}

export function formatSize(info: GFileInfo): string {
  if (isDirectory(info)) return ''
  return GLib.formatSize(info.getSize())
}

export function formatBytes(bytes: number): string {
  return GLib.formatSize(bytes)
}

export function formatType(info: GFileInfo): string {
  if (isDirectory(info)) return 'Folder'
  const ct = info.getContentType()
  if (!ct) return 'Unknown'
  return Gio.contentTypeGetDescription(ct) || ct
}

/* GLib.DateTime.format returns the string, or a [string] tuple under node-gtk. */
function fmtDate(dt: any, pattern: string): string {
  try {
    const out = dt.format(pattern)
    return (Array.isArray(out) ? out[0] : out) ?? ''
  } catch { return '' }
}

/* Human-friendly modification time: time only for today, "Yesterday" for the
 * day before, month/day + time within the current year, and the full date for
 * anything older. */
export function formatModified(info: GFileInfo): string {
  const dt = info.getModificationDateTime?.()
  if (!dt) return ''
  try {
    const local = dt.toLocal?.() ?? dt
    const now = GLib.DateTime.newNowLocal()

    const dayStart = (d: any) => GLib.DateTime.newLocal(d.getYear(), d.getMonth(), d.getDayOfMonth(), 0, 0, 0)
    const DAY = 24 * 60 * 60 * 1000 * 1000 // microseconds (GLib.TimeSpan unit)
    // difference() is a gint64, surfaced as a BigInt by node-gtk.
    const daysAgo = Math.round(Number(dayStart(now).difference(dayStart(local))) / DAY)

    if (daysAgo === 0) return fmtDate(local, '%H:%M')
    if (daysAgo === 1) return 'Yesterday'
    if (local.getYear() === now.getYear()) return fmtDate(local, '%b %-d %H:%M')
    return fmtDate(local, '%b %-d, %Y')
  } catch { return '' }
}

export function modifiedUnix(info: GFileInfo): number {
  const dt = info.getModificationDateTime?.()
  if (!dt) return 0
  try { return dt.toUnix() } catch { return 0 }
}

/* Human label for a location (tab title / window title). */
export function locationName(file: GFile): string {
  const path = F.getPath(file)
  if (path === HOME) return 'Home'
  if (path) return F.getBasename(file)
  const uri = F.getUri(file)
  if (uri.startsWith('trash:')) return 'Trash'
  if (uri.startsWith('recent:')) return 'Recent'
  if (uri.startsWith('network:')) return 'Network'
  return F.getBasename(file) || uri
}
