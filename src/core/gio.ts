import Gio from 'gi:Gio-2.0'
import GObject from 'gi:GObject-2.0'
import type { GFile } from './types.ts'

/* Low-level Gio access. GFile (and other interface) methods live on the
 * interface prototype in node-gtk, not on the instance; route every call
 * through it via this proxy: F.getPath(file), F.enumerateChildren(file, …). */
const FILE_PROTO = Gio.File.prototype
export const F: Record<string, (...args: any[]) => any> = new Proxy({}, {
  get: (_t: any, m: string) => (file: any, ...args: any[]) => FILE_PROTO[m].call(file, ...args),
})

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
export function uriOf(file: GFile): string { return F.getUri(file) }
export function pathOf(file: GFile): string | null { return F.getPath(file) }
export function childOf(dir: GFile, name: string): GFile { return F.getChild(dir, name) }
export function parentOf(file: GFile): GFile | null { return F.getParent(file) }
export function basenameOf(file: GFile): string { return F.getBasename(file) }
export function exists(file: GFile): boolean { return F.queryExists(file, null) }
