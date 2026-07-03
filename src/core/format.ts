import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { archiveName } from './archive-uri.ts'
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

/* Human-friendly timestamp: time only for today, "Yesterday" for the day
 * before, month/day + time within the current year, and the full date for
 * anything older. Shared by every date column (matches nautilus, which formats
 * modified/accessed/created alike). */
function humanTime(dt: any): string {
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

export function formatModified(info: GFileInfo): string {
  return humanTime(info.getModificationDateTime?.())
}

export function formatAccessed(info: GFileInfo): string {
  return humanTime(info.getAccessDateTime?.())
}

export function formatCreated(info: GFileInfo): string {
  return humanTime(info.getCreationDateTime?.())
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

/* Original containing folder of a trashed item (from trash::orig-path), with
 * $HOME abbreviated to `~`. Empty for non-trash entries. Drives the Trash
 * view's "Original Location" column. */
export function formatOrigLocation(info: GFileInfo): string {
  const orig = info.getAttributeByteString?.('trash::orig-path')
  if (!orig) return ''
  const slash = orig.lastIndexOf('/')
  const dir = slash > 0 ? orig.slice(0, slash) : '/'
  if (dir === HOME) return '~'
  if (dir.startsWith(HOME + '/')) return '~' + dir.slice(HOME.length)
  return dir
}

/* Path with $HOME abbreviated to `~` (for the command palette's folder list);
 * falls back to the URI for non-local locations (trash:, recent:, mounts). */
export function tildePath(file: GFile): string {
  const path = file.getPath()
  if (!path) return file.getUri()
  if (path === HOME) return '~'
  if (path.startsWith(HOME + '/')) return '~' + path.slice(HOME.length)
  return path
}

/* Human label for a location (tab title / window title). */
export function locationName(file: GFile): string {
  const path = file.getPath()
  if (path === HOME) return 'Home'
  const uri = file.getUri()
  /* Archive locations (archive://) are handled before the path check: the title
   * is set the moment we navigate — before the backend is mounted — so getPath()
   * is null then. Sub-folders keep their real basename; the root (basename "/")
   * shows the archive's filename. */
  if (uri.startsWith('archive://')) {
    const name = file.getBasename()
    return name && name !== '/' ? name : (archiveName(file) ?? '/')
  }
  if (path) return file.getBasename()
  if (uri.startsWith('trash:')) return 'Trash'
  if (uri.startsWith('recent:')) return 'Recent'
  if (uri.startsWith('network:')) return 'Network'
  if (uri.startsWith('computer:')) return 'Computer'
  /* tag:///<name> — title with the (decoded) tag name; the root is "Tags". */
  if (uri.startsWith('tag:')) {
    const m = /^tag:\/\/\/(.+)$/.exec(uri)
    if (!m) return 'Tags'
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  return file.getBasename() || uri
}
