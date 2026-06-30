import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'

/* GFile (and other interface) methods live on the interface prototype in
 * node-gtk, not on the instance. Route every call through the prototype. */
const FP = Gio.File.prototype
export const F = new Proxy({}, {
  get: (_t, m) => (file, ...args) => FP[m].call(file, ...args),
})

export const FILE_INFO_TYPE = GObject.typeFromName('GFileInfo')

export const HOME = GLib.getHomeDir()

/* Attributes we read for each entry. */
export const ATTRS = [
  'standard::name', 'standard::display-name', 'standard::edit-name',
  'standard::icon', 'standard::symbolic-icon', 'standard::type',
  'standard::size', 'standard::content-type', 'standard::is-hidden',
  'standard::is-backup', 'standard::is-symlink', 'standard::target-uri',
  'time::modified', 'access::can-write', 'access::can-execute',
].join(',')

export function fileForPath(path) { return Gio.File.newForPath(path) }
export function fileForUri(uri) { return Gio.File.newForUri(uri) }

export function uriOf(file) { return F.getUri(file) }
export function pathOf(file) { return F.getPath(file) }

/* Display label for a location (used in tabs / window title). */
export function locationName(file) {
  const path = F.getPath(file)
  if (path === HOME) return 'Home'
  if (path) return F.getBasename(file)
  const uri = F.getUri(file)
  if (uri.startsWith('trash:')) return 'Trash'
  if (uri.startsWith('recent:')) return 'Recent'
  if (uri.startsWith('network:')) return 'Network'
  return F.getBasename(file) || uri
}

export function isDirectory(info) {
  return info.getFileType() === Gio.FileType.DIRECTORY
}

export function displayName(info) {
  return info.getDisplayName() || info.getName()
}

export function formatSize(info) {
  if (isDirectory(info)) return ''
  return GLib.formatSize(info.getSize())
}

export function formatType(info) {
  if (isDirectory(info)) return 'Folder'
  const ct = info.getContentType()
  if (!ct) return 'Unknown'
  return Gio.contentTypeGetDescription(ct) || ct
}

export function formatModified(info) {
  const dt = info.getModificationDateTime?.()
  if (!dt) return ''
  try {
    const out = dt.format('%-d %b %Y %H:%M')
    return Array.isArray(out) ? out[0] : out
  } catch { return '' }
}

/* GLib.DateTime backing for sort comparisons. */
export function modifiedUnix(info) {
  const dt = info.getModificationDateTime?.()
  if (!dt) return 0
  try { return dt.toUnix() } catch { return 0 }
}

/* User special directories, in nautilus sidebar order. */
const SPECIAL = [
  [GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'Documents', 'folder-documents-symbolic'],
  [GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'Downloads', 'folder-download-symbolic'],
  [GLib.UserDirectory.DIRECTORY_MUSIC, 'Music', 'folder-music-symbolic'],
  [GLib.UserDirectory.DIRECTORY_PICTURES, 'Pictures', 'folder-pictures-symbolic'],
  [GLib.UserDirectory.DIRECTORY_VIDEOS, 'Videos', 'folder-videos-symbolic'],
]

export function specialDirs() {
  const out = []
  for (const [id, label, icon] of SPECIAL) {
    const path = GLib.getUserSpecialDir(id)
    if (path && path !== HOME && GLib.fileTest(path, GLib.FileTest.IS_DIR))
      out.push({ label, icon, file: fileForPath(path) })
  }
  return out
}
