import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { F, fileForPath, fileForUri } from '../core/gio.ts'
import { HOME } from '../core/format.ts'
import type { Place } from '../core/types.ts'

const SPECIAL: Array<[any, string, string]> = [
  [GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'Documents', 'folder-documents-symbolic'],
  [GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'Downloads', 'folder-download-symbolic'],
  [GLib.UserDirectory.DIRECTORY_MUSIC, 'Music', 'folder-music-symbolic'],
  [GLib.UserDirectory.DIRECTORY_PICTURES, 'Pictures', 'folder-pictures-symbolic'],
  [GLib.UserDirectory.DIRECTORY_VIDEOS, 'Videos', 'folder-videos-symbolic'],
]

export function getPlaces(): Place[] {
  const places: Place[] = [
    { label: 'Recent', icon: 'document-open-recent-symbolic', file: fileForUri('recent:///') },
    { label: 'Home', icon: 'user-home-symbolic', file: fileForPath(HOME) },
  ]
  for (const [id, label, icon] of SPECIAL) {
    const path = GLib.getUserSpecialDir(id)
    if (path && path !== HOME && GLib.fileTest(path, GLib.FileTest.IS_DIR))
      places.push({ label, icon, file: fileForPath(path) })
  }
  places.push({ label: 'Trash', icon: 'user-trash-symbolic', file: fileForUri('trash:///') })
  return places
}

export function getBookmarks(): Place[] {
  const path = GLib.buildFilenamev([HOME, '.config', 'gtk-3.0', 'bookmarks'])
  if (!GLib.fileTest(path, GLib.FileTest.EXISTS)) return []
  let text = ''
  try {
    const res = GLib.fileGetContents(path)
    const data = Array.isArray(res) ? res[1] : res
    text = typeof data === 'string' ? data : new TextDecoder().decode(Uint8Array.from(data))
  } catch { return [] }

  const out: Place[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const sp = line.indexOf(' ')
    const uri = sp < 0 ? line : line.slice(0, sp)
    const label = sp < 0 ? '' : line.slice(sp + 1)
    const file = fileForUri(uri)
    if (!F.queryExists(file, null)) continue
    out.push({ label: label || F.getBasename(file), icon: 'folder-symbolic', file })
  }
  return out
}

export function getDevices(): Place[] {
  let mounts: any[] = []
  try { mounts = Gio.VolumeMonitor.get().getMounts() } catch { return [] }
  return mounts.map((mount: any) => ({
    label: mount.getName(),
    icon: 'drive-harddisk-symbolic',
    file: mount.getRoot(),
    mount,
  }))
}
