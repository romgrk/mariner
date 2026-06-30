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

export function formatType(info: GFileInfo): string {
  if (isDirectory(info)) return 'Folder'
  const ct = info.getContentType()
  if (!ct) return 'Unknown'
  return Gio.contentTypeGetDescription(ct) || ct
}

export function formatModified(info: GFileInfo): string {
  const dt = info.getModificationDateTime?.()
  if (!dt) return ''
  try {
    const out = dt.format('%-d %b %Y %H:%M')
    return Array.isArray(out) ? out[0] : out
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
