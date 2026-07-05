import { isDirectory, displayName, modifiedUnix, sizeForSort } from './format.ts'
import type { GFileInfo, SortKey } from './types.ts'

export type Comparator = (a: GFileInfo, b: GFileInfo) => number

/* Attribute reads and string collation are the hot cost of sorted streaming
 * (a 5k-entry folder pays ~200k comparisons), so each entry's comparison keys
 * are computed once and cached on its info wrapper — node-gtk keeps the wrapper
 * and its JS props stable through the GListStore, and a listing's infos are
 * replaced wholesale on reload, so the cache can't go stale. Size is NOT
 * cached: for folders sizeForSort consults the live dir-sizes cache.
 * FileView._stamp pre-warms the cache as entries arrive, so a big load pays the
 * attribute reads spread across enumeration batches instead of concentrated in
 * the final sort. */
export function sortCache(info: GFileInfo) {
  return info._sort ??= {
    dir: isDirectory(info),
    name: displayName(info).toLowerCase(),
    mtime: modifiedUnix(info),
    type: (info.getContentType() || '').toLowerCase(),
  }
}

const collator = new Intl.Collator()

/* Comparator over two GFileInfo, folders-first. Usable for both a full sort and
 * merging sorted runs during streaming. (We avoid Gtk.CustomSorter: its JS
 * compare callback receives undefined args in node-gtk.) */
export function makeComparator(key: SortKey, desc: boolean): Comparator {
  const dir = desc ? -1 : 1
  return (a: GFileInfo, b: GFileInfo) => {
    const ka = sortCache(a), kb = sortCache(b)
    if (ka.dir !== kb.dir) return ka.dir ? -1 : 1   /* folders first, regardless of order */
    let r = 0
    switch (key) {
      case 'size': r = sizeForSort(a) - sizeForSort(b); break
      case 'type': r = collator.compare(ka.type, kb.type); break
      case 'modified': r = ka.mtime - kb.mtime; break
      default: r = 0
    }
    if (r === 0) r = collator.compare(ka.name, kb.name)
    return r * dir
  }
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
