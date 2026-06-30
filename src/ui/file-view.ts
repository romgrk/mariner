import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import { FILE_INFO_TYPE } from '../core/gio.ts'
import { makeComparator } from '../core/comparator.ts'
import type { Comparator } from '../core/comparator.ts'
import { gridFactory, nameColumn, metaColumn, COLUMNS } from './cells.ts'
import type { CellContext } from './cells.ts'
import type { Entry, GFile, GFileInfo, ViewConfig, ViewMode, EmptyKind } from '../core/types.ts'

type ActivateHandler = (info: GFileInfo, file: GFile) => void
type ContextMenuHandler = (widget: any, x: number, y: number, target: Entry | null) => void

/* Presents a stream of {info, file} entries as a grid or list, with explicit
 * loading / empty / error states. Entries arrive incrementally (addEntries) and
 * are kept sorted via binary-search insert; pref changes trigger a full rebuild.
 * The GFile for a row is stashed on the GFileInfo wrapper as `_file` (node-gtk
 * keeps wrapper identity + JS props stable through a GListStore). */
export class FileView {
  store: any
  selection: any
  iconSize = 64
  all: Entry[] = []
  filter: (info: GFileInfo) => boolean = () => true
  cmp: Comparator = makeComparator('name', false)
  onActivate: ActivateHandler = () => {}
  onContextMenu: ContextMenuHandler = () => {}

  gridView: any
  columnView: any
  viewStack: any
  stack: any
  _errorPage: any
  _loading = false
  _emptyKind: EmptyKind = 'folder'

  constructor() {
    this.store = Gio.ListStore.new(FILE_INFO_TYPE)
    this.selection = Gtk.MultiSelection.new(this.store)

    const ctx = this._cellContext()

    this.gridView = new Gtk.GridView({ model: this.selection, factory: gridFactory(ctx), minColumns: 1, maxColumns: 24, vexpand: true })
    this.gridView.on('activate', (...a: any[]) => this._activate(a[a.length - 1]))

    this.columnView = new Gtk.ColumnView({ model: this.selection, vexpand: true })
    this.columnView.addCssClass('rich-list')
    this.columnView.appendColumn(nameColumn(ctx))
    for (const [title, fmt, right] of COLUMNS) this.columnView.appendColumn(metaColumn(title, fmt, right))
    this.columnView.on('activate', (...a: any[]) => this._activate(a[a.length - 1]))

    this.viewStack = new Gtk.Stack()
    this.viewStack.addNamed(scrolled(this.gridView), 'grid')
    this.viewStack.addNamed(scrolled(this.columnView), 'list')

    this._addBackgroundMenu(this.gridView)
    this._addBackgroundMenu(this.columnView)

    this._errorPage = new Adw.StatusPage({ iconName: 'dialog-error-symbolic', title: 'Unable to Load Location' })

    this.stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE })
    this.stack.addNamed(this.viewStack, 'results')
    this.stack.addNamed(loadingPage(), 'loading')
    this.stack.addNamed(new Adw.StatusPage({ iconName: 'folder-symbolic', title: 'Folder is Empty' }), 'empty-folder')
    this.stack.addNamed(new Adw.StatusPage({ iconName: 'system-search-symbolic', title: 'No Results Found', description: 'Try a different search term.' }), 'empty-search')
    this.stack.addNamed(this._errorPage, 'error')
  }

  get widget(): any { return this.stack }

  configure({ sortKey, sortDesc, filter }: ViewConfig): void {
    this.cmp = makeComparator(sortKey, sortDesc)
    this.filter = filter || (() => true)
  }

  beginLoading(): void {
    this._loading = true
    this.all = []
    this.store.removeAll()
    this.stack.setVisibleChildName('loading')
  }

  addEntries(pairs: Entry[]): void {
    for (const { info, file } of pairs) {
      info._file = file
      this.all.push({ info, file })
      if (this.filter(info)) this._insertSorted(info)
    }
    if (this._loading && this.store.getNItems() > 0) this.stack.setVisibleChildName('results')
  }

  finishLoading(emptyKind: EmptyKind = 'folder'): void {
    this._loading = false
    this._emptyKind = emptyKind
    this._settle()
  }

  showError(message: string): void {
    this._loading = false
    this._errorPage.setDescription(message || 'The location could not be read.')
    this.stack.setVisibleChildName('error')
  }

  /* Re-apply filter + sort to the retained dataset (on pref change). */
  rebuild(): void {
    this.store.removeAll()
    const sorted = this.all.map(p => p.info).filter(this.filter).sort(this.cmp)
    for (const info of sorted) this.store.append(info)
    if (!this._loading) this._settle()
  }

  setMode(mode: ViewMode): void { this.viewStack.setVisibleChildName(mode === 'list' ? 'list' : 'grid') }

  setZoom(px: number): void {
    this.iconSize = px
    this.gridView.setFactory(gridFactory(this._cellContext()))
  }

  selectAll(): void { this.selection.selectAll() }

  getSelected(): Entry[] {
    const out: Entry[] = []
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) {
      if (this.selection.isSelected(i)) {
        const info = this.store.getItem(i)
        out.push({ info, file: info._file })
      }
    }
    return out
  }

  /* ---- internals ---- */
  _cellContext(): CellContext {
    return { iconSize: () => this.iconSize, attachMenu: (w, item) => this._attachMenu(w, item) }
  }

  _settle(): void {
    if (this.store.getNItems() > 0) this.stack.setVisibleChildName('results')
    else this.stack.setVisibleChildName(this._emptyKind === 'search' ? 'empty-search' : 'empty-folder')
  }

  _insertSorted(info: GFileInfo): void {
    let lo = 0, hi = this.store.getNItems()
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cmp(this.store.getItem(mid), info) <= 0) lo = mid + 1
      else hi = mid
    }
    this.store.insert(lo, info)
  }

  _activate(pos: number): void {
    const info = this.store.getItem(pos)
    if (info) this.onActivate(info, info._file)
  }

  _attachMenu(widget: any, item: any): void {
    const gesture = new Gtk.GestureClick({ button: 3 })
    gesture.on('pressed', (...a: any[]) => {
      const [x, y] = a.slice(-2)
      const pos = item.getPosition()
      if (!this.selection.isSelected(pos)) this.selection.selectItem(pos, true)
      const info = this.store.getItem(pos)
      gesture.setState(Gtk.EventSequenceState.CLAIMED)
      this.onContextMenu(widget, x, y, { info, file: info._file })
    })
    widget.addController(gesture)
  }

  _addBackgroundMenu(view: any): void {
    const gesture = new Gtk.GestureClick({ button: 3 })
    gesture.on('pressed', (...a: any[]) => {
      const [x, y] = a.slice(-2)
      this.onContextMenu(view, x, y, null)
    })
    view.addController(gesture)
  }
}

function scrolled(child: any): any {
  return new Gtk.ScrolledWindow({ child, hexpand: true, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER })
}

function loadingPage(): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
  box.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }))
  box.append(new Gtk.Label({ label: 'Loading…', cssClasses: ['dim-label'] }))
  return box
}
