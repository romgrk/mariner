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

export type SearchCategory = 'all' | 'folder' | 'document' | 'image' | 'audio' | 'video'
/* Rich-search refinements applied to matches (in the search service, where the
 * resolved GFileInfo is available). `since` is a unix-seconds floor (0 = any). */
export interface SearchFilter {
  category: SearchCategory
  since: number
  /* When true (and a query is present), search file *contents* via ripgrep
   * instead of matching names. */
  contents?: boolean
}

/* One list-view column's state: which column (by id, see core/columns.ts) and
 * whether it's shown. Ordered lists of these drive both the ColumnView and the
 * column chooser — order is significant. The Name column is implicit (always
 * shown first) and never appears here. */
export interface ColumnConfig {
  id: string
  visible: boolean
}

export interface Prefs {
  showHidden: boolean
  sortKey: SortKey
  sortDesc: boolean
  viewMode: ViewMode
  iconSize: number
  /* Ordered list-view columns (excluding the always-first Name column). */
  columns: ColumnConfig[]
}

/* What the FileView needs to filter + order a dataset. */
export interface ViewConfig {
  sortKey: SortKey
  sortDesc: boolean
  filter: ((info: GFileInfo) => boolean) | null
}

/* One planned copy/move: a source and its (already collision-resolved)
 * destination. `replace` overwrites an existing destination (delete-then-write);
 * otherwise the destination is assumed free (auto-renamed or user-confirmed). */
export interface CopyItem {
  src: GFile
  dest: GFile
  replace?: boolean
}

/* File-operation feedback payloads. Long ops carry an `id` so a concurrent
 * operations queue can track and cancel each independently. */
export interface OpBegin { id: number; title: string }
export interface OpProgress { id: number; title: string; done: number; total: number; paused?: boolean }
export interface OpDone { id: number; title: string; count: number; cancelled: boolean }
export interface OpError { id?: number; title: string; message: string }
export interface OpNotify { message: string }
