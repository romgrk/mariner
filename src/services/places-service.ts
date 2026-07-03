import GLib from 'gi:GLib-2.0'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileForPath, fileForUri } from '../core/gio.ts'
import { HOME } from '../core/format.ts'
import { volumeMonitor } from './volume-monitor.ts'
import type { Place, GFile } from '../core/types.ts'

/* Virtual location backing the Computer interface (the drives/partitions page).
 * The pane renders a ComputerView for this URI instead of a directory listing. */
export const COMPUTER_URI = 'computer:///'

const SPECIAL: Array<[any, string, string]> = [
  [GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'Documents', 'folder-documents-symbolic'],
  [GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'Downloads', 'folder-download-symbolic'],
  [GLib.UserDirectory.DIRECTORY_MUSIC, 'Music', 'folder-music-symbolic'],
  [GLib.UserDirectory.DIRECTORY_PICTURES, 'Pictures', 'folder-pictures-symbolic'],
  [GLib.UserDirectory.DIRECTORY_VIDEOS, 'Videos', 'folder-videos-symbolic'],
]

/* Every show/hide-able sidebar entry, in sidebar order: the fixed places
 * individually, plus the dynamic groups (Bookmarks, Devices) toggled as whole
 * sections. Drives the Preferences dialog's Sidebar group and the validation
 * of the persisted hidden-list (view-prefs.ts). */
export const SIDEBAR_ITEMS: Array<{ id: string; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'home', label: 'Home' },
  ...SPECIAL.map(([, label]) => ({ id: label.toLowerCase(), label })),
  { id: 'trash', label: 'Trash' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'tags', label: 'Tags' },
  { id: 'computer', label: 'Computer' },
  { id: 'devices', label: 'Devices' },
]

export function getPlaces(): Place[] {
  const places: Place[] = [
    { id: 'recent', label: 'Recent', icon: 'document-open-recent-symbolic', file: fileForUri('recent:///') },
    { id: 'home', label: 'Home', icon: 'user-home-symbolic', file: fileForPath(HOME) },
  ]
  for (const [id, label, icon] of SPECIAL) {
    const path = GLib.getUserSpecialDir(id)
    if (path && path !== HOME && GLib.fileTest(path, GLib.FileTest.IS_DIR))
      places.push({ id: label.toLowerCase(), label, icon, file: fileForPath(path) })
  }
  places.push({ id: 'trash', label: 'Trash', icon: 'user-trash-symbolic', file: fileForUri('trash:///') })
  return places
}

/* The Computer entry — its own sidebar section (see the sidebar's build()). */
export function getComputer(): Place {
  return { id: 'computer', label: 'Computer', icon: 'computer-symbolic', file: fileForUri(COMPUTER_URI) }
}

/* GTK stores user bookmarks as one "URI [ custom label]" line per bookmark;
 * nautilus, the GTK file chooser and this app all read/write the same file. */
const BOOKMARKS_DIR = GLib.buildFilenamev([HOME, '.config', 'gtk-3.0'])
const BOOKMARKS_FILE = GLib.buildFilenamev([BOOKMARKS_DIR, 'bookmarks'])

/* Non-empty lines of the bookmarks file (a URI, optionally + ' Custom Label'). */
function readBookmarkLines(): string[] {
  if (!GLib.fileTest(BOOKMARKS_FILE, GLib.FileTest.EXISTS)) return []
  try {
    const res = GLib.fileGetContents(BOOKMARKS_FILE)
    const data = Array.isArray(res) ? res[1] : res
    const text = typeof data === 'string' ? data : new TextDecoder().decode(Uint8Array.from(data))
    return text.split('\n').filter(l => l.trim())
  } catch { return [] }
}

function writeBookmarkLines(lines: string[]): boolean {
  try {
    mkdirSync(BOOKMARKS_DIR, { recursive: true })
    writeFileSync(BOOKMARKS_FILE, lines.length ? lines.join('\n') + '\n' : '')
    return true
  } catch { return false }
}

/* The URI part of a bookmark line, before any custom label. */
function bookmarkUri(line: string): string {
  const sp = line.indexOf(' ')
  return sp < 0 ? line : line.slice(0, sp)
}

export function getBookmarks(): Place[] {
  const out: Place[] = []
  for (const line of readBookmarkLines()) {
    const uri = bookmarkUri(line)
    const label = line.slice(uri.length).trim()
    const file = fileForUri(uri)
    /* Only stat local bookmarks. getPath() is null for gvfs/remote URIs
     * (sftp://, smb://, …); querying those would block on the gvfs daemon, and
     * we can't cheaply verify remote availability here anyway — keep them and
     * let the user click through. */
    if (file.getPath() != null && !file.queryExists(null)) continue
    out.push({ label: label || file.getBasename(), icon: 'folder-symbolic', file })
  }
  return out
}

export function isBookmarked(file: GFile): boolean {
  const uri = file.getUri()
  return readBookmarkLines().some(line => bookmarkUri(line) === uri)
}

/* Append `file` to the bookmarks (no custom label — the sidebar falls back to
 * the folder's basename). Returns false if already bookmarked or the write failed. */
export function addBookmark(file: GFile): boolean {
  const uri = file.getUri()
  const lines = readBookmarkLines()
  if (lines.some(line => bookmarkUri(line) === uri)) return false
  lines.push(uri)
  return writeBookmarkLines(lines)
}

/* Drop every bookmark pointing at `file`. Returns false if none matched. */
export function removeBookmark(file: GFile): boolean {
  const uri = file.getUri()
  const lines = readBookmarkLines()
  const kept = lines.filter(line => bookmarkUri(line) !== uri)
  if (kept.length === lines.length) return false
  return writeBookmarkLines(kept)
}

export function getDevices(): Place[] {
  const mon = volumeMonitor()
  if (!mon) return []
  let mounts: any[] = []
  try { mounts = mon.getMounts() } catch { return [] }
  return mounts.map((mount: any) => ({
    label: mount.getName(),
    icon: 'drive-harddisk-symbolic',
    file: mount.getRoot(),
    mount,
  }))
}
