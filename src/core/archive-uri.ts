import GLib from 'gi:GLib-2.0'
import { fileForUri } from './gio.ts'
import type { GFile } from './types.ts'

/* Helpers for browsing an archive as a virtual folder through gvfs's `archive://`
 * backend (gvfsd-archive, libarchive) — no extraction, no temp files.
 *
 * The backend keys its mount on the *doubly* percent-escaped URI of the archive
 * file. Once escaped gives the mount's `host`; `g_file_new_for_uri()` unescapes
 * the authority a second time when parsing, so the URI string must carry the
 * escaping twice to survive the round-trip. e.g. /tmp/a.zip →
 *   file:///tmp/a.zip → file%3A%2F%2F%2Ftmp%2Fa.zip → file%253A%252F…%252Fa.zip
 *   → archive://file%253A%252F…%252Fa.zip/ */

const SCHEME = 'archive://'

/* The archive:// virtual-folder root for a (usually local) archive file. */
export function archiveRootFile(archive: GFile): GFile {
  return fileForUri(`${SCHEME}${escapeUri(escapeUri(archive.getUri()))}/`)
}

export function isArchiveLocation(file: GFile): boolean {
  return file.getUri().startsWith(SCHEME)
}

/* The archive file backing an archive:// location (decoding the mount host),
 * or null when `file` is not an archive location. */
export function archiveFileOf(file: GFile): GFile | null {
  const uri = file.getUri()
  if (!uri.startsWith(SCHEME)) return null
  const host = uri.slice(SCHEME.length).split('/', 1)[0]
  const once = unescapeUri(host)
  const fileUri = once ? unescapeUri(once) : null
  return fileUri ? fileForUri(fileUri) : null
}

/* Display name for an archive:// location's root: the archive's basename
 * (the root itself reports a basename of "/"). */
export function archiveName(file: GFile): string | null {
  const archive = archiveFileOf(file)
  return archive ? archive.getBasename() : null
}

function escapeUri(s: string): string { return GLib.uriEscapeString(s, null, false) }
function unescapeUri(s: string): string | null { return GLib.uriUnescapeString(s, null) }
