import { isDirectory, displayName, modifiedUnix, sizeForSort } from './format.ts'
import type { GFileInfo, SortKey } from './types.ts'

export type Comparator = (a: GFileInfo, b: GFileInfo) => number

/* Comparator over two GFileInfo, folders-first. Pure — usable for both a full
 * sort and binary-search sorted-insert during streaming. (We avoid
 * Gtk.CustomSorter: its JS compare callback receives undefined args in node-gtk.) */
export function makeComparator(key: SortKey, desc: boolean): Comparator {
  const dir = desc ? -1 : 1
  return (a: GFileInfo, b: GFileInfo) => {
    const ad = isDirectory(a), bd = isDirectory(b)
    if (ad !== bd) return ad ? -1 : 1   /* folders first, regardless of order */
    let r = 0
    switch (key) {
      case 'size': r = sizeForSort(a) - sizeForSort(b); break
      case 'type': r = collate(a.getContentType() || '', b.getContentType() || ''); break
      case 'modified': r = modifiedUnix(a) - modifiedUnix(b); break
      default: r = 0
    }
    if (r === 0) r = collate(displayName(a), displayName(b))
    return r * dir
  }
}

function collate(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase())
}

/* First index in `sorted` where `item` should be inserted to stay ordered. */
export function sortedIndex<T>(sorted: T[], item: T, cmp: (a: T, b: T) => number): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmp(sorted[mid], item) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}
