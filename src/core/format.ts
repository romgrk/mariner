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

/* Format a GLib.DateTime (or nothing) as nautilus does its date columns. */
function formatDateTime(dt: any): string {
  if (!dt) return ''
  try {
    const out = dt.format('%-d %b %Y %H:%M')
    return Array.isArray(out) ? out[0] : out
  } catch { return '' }
}

export function formatModified(info: GFileInfo): string {
  return formatDateTime(info.getModificationDateTime?.())
}

export function formatAccessed(info: GFileInfo): string {
  return formatDateTime(info.getAccessDateTime?.())
}

export function formatCreated(info: GFileInfo): string {
  return formatDateTime(info.getCreationDateTime?.())
}

export function formatOwner(info: GFileInfo): string {
  return info.getAttributeString?.('owner::user') || ''
}

export function formatGroup(info: GFileInfo): string {
  return info.getAttributeString?.('owner::group') || ''
}

/* One rwx triplet from the low 3 bits of a permission nibble. */
function rwx(bits: number): string {
  return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-')
}

/* Unix permissions as a 10-char string (e.g. "drwxr-xr-x"), like `ls -l` and
 * nautilus's Permissions column. Empty when the mode isn't known (remote FS). */
export function formatPermissions(info: GFileInfo): string {
  if (!info.hasAttribute?.('unix::mode')) return ''
  const mode = info.getAttributeUint32('unix::mode')
  const type = isDirectory(info) ? 'd' : info.getIsSymlink?.() ? 'l' : '-'
  return type + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
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
