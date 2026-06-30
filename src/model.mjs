import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import {
  F, FILE_INFO_TYPE, ATTRS, isDirectory, displayName, modifiedUnix,
} from './util.mjs'

/* Backs a single location: a GListStore of GFileInfo, filtered + sorted,
 * kept fresh with a Gio.FileMonitor. No libuv handles (those are not serviced
 * under the GLib loop). */
export class DirModel {
  constructor() {
    this.store = Gio.ListStore.new(FILE_INFO_TYPE)
    this.all = []
    this.dir = null
    this.monitor = null
    this.onChanged = null
  }

  load(dir) {
    this.dir = dir
    this.all = []
    let en
    try {
      en = F.enumerateChildren(dir, ATTRS, Gio.FileQueryInfoFlags.NONE, null)
    } catch (e) {
      this.store.removeAll()
      throw e
    }
    let info
    while ((info = en.nextFile(null)) !== null) this.all.push(info)
    en.close(null)
  }

  apply({ showHidden, sortKey, sortDesc, search }) {
    let items = this.all
    if (!showHidden)
      items = items.filter(i => !i.getIsHidden() && !i.getIsBackup())
    if (search) {
      const needle = search.toLowerCase()
      items = items.filter(i => displayName(i).toLowerCase().includes(needle))
    }
    items = items.slice().sort(comparator(sortKey, sortDesc))
    this.store.removeAll()
    for (const it of items) this.store.append(it)
  }

  /* Resolve the GFile for a row (names are unique within a dir). */
  childFor(info) { return F.getChild(this.dir, info.getName()) }

  watch(cb) {
    this.unwatch()
    this.onChanged = cb
    try {
      this.monitor = F.monitorDirectory(this.dir, Gio.FileMonitorFlags.WATCH_MOVES, null)
      this.monitor.on('changed', () => {
        /* Coalesce bursts of fs events into a single reload. */
        if (this._pending) return
        this._pending = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 120, () => {
          this._pending = 0
          try { this.load(this.dir); cb() } catch { /* dir vanished */ }
          return false
        })
      })
    } catch { /* some backends (recent:) don't support monitors */ }
  }

  unwatch() {
    if (this._pending) { GLib.sourceRemove(this._pending); this._pending = 0 }
    if (this.monitor) { try { this.monitor.cancel() } catch {} this.monitor = null }
  }
}

function comparator(key, desc) {
  const dir = desc ? -1 : 1
  return (a, b) => {
    /* Folders always first, regardless of direction. */
    const ad = isDirectory(a), bd = isDirectory(b)
    if (ad !== bd) return ad ? -1 : 1
    let r = 0
    switch (key) {
      case 'size': r = a.getSize() - b.getSize(); break
      case 'type': r = collate(typeKey(a), typeKey(b)); break
      case 'modified': r = modifiedUnix(a) - modifiedUnix(b); break
      default: r = 0
    }
    if (r === 0) r = collate(displayName(a), displayName(b))
    return r * dir
  }
}

function typeKey(info) {
  return info.getContentType() || ''
}

function collate(a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase())
}
