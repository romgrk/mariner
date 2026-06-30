/* Shared domain types. GObject values are opaque (`any`) — see gi.d.ts. */

export type GFile = any
export type GFileInfo = any

/* A directory/search entry: a GFileInfo plus the GFile it refers to. The GFile
 * is also stashed on the info wrapper as `info._file` for retrieval from the
 * GListStore (node-gtk keeps wrapper identity + JS props stable). */
export interface Entry {
  info: GFileInfo
  file: GFile
}

/* A sidebar location. */
export interface Place {
  label: string
  icon: string
  file: GFile
  mount?: any
}

export type SortKey = 'name' | 'size' | 'type' | 'modified'
export type ViewMode = 'grid' | 'list'
export type EmptyKind = 'folder' | 'search'

export interface Prefs {
  showHidden: boolean
  sortKey: SortKey
  sortDesc: boolean
  viewMode: ViewMode
  iconSize: number
}

/* What the FileView needs to filter + order a dataset. */
export interface ViewConfig {
  sortKey: SortKey
  sortDesc: boolean
  filter: ((info: GFileInfo) => boolean) | null
}

/* File-operation feedback payloads. */
export interface OpProgress { title: string; done: number; total: number }
export interface OpDone { title: string; count: number }
export interface OpError { title: string; message: string }
export interface OpNotify { message: string }
