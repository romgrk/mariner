import Gio from 'gi:Gio-2.0'
import GObject from 'gi:GObject-2.0'
import type { GFile } from './types.ts'

/* Low-level Gio helpers. GFile (and other interface) methods are available
 * directly on instances — call them as `file.getPath()` etc. */
export const FILE_INFO_TYPE = GObject.typeFromName('GFileInfo')

/* Attributes fetched per entry. */
export const ATTRS = [
  'standard::name', 'standard::display-name', 'standard::edit-name',
  'standard::icon', 'standard::symbolic-icon', 'standard::type',
  'standard::size', 'standard::content-type', 'standard::is-hidden',
  'standard::is-backup', 'standard::is-symlink', 'standard::target-uri',
  'time::modified', 'time::access', 'time::created',
  'owner::user', 'owner::group', 'unix::mode',
  'access::can-write', 'access::can-execute',
  'trash::orig-path', 'trash::deletion-date',
].join(',')

export function fileForPath(path: string): GFile { return Gio.File.newForPath(path) }
export function fileForUri(uri: string): GFile { return Gio.File.newForUri(uri) }
export function uriOf(file: GFile): string { return file.getUri() }
export function pathOf(file: GFile): string | null { return file.getPath() }
export function childOf(dir: GFile, name: string): GFile { return dir.getChild(name) }
export function parentOf(file: GFile): GFile | null { return file.getParent() }
export function basenameOf(file: GFile): string { return file.getBasename() }
export function exists(file: GFile): boolean { return file.queryExists(null) }
