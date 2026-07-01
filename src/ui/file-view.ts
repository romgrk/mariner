import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import { FILE_INFO_TYPE } from '../core/gio.ts'
import { displayName, isDirectory } from '../core/format.ts'
import { makeComparator } from '../core/comparator.ts'
import type { Comparator } from '../core/comparator.ts'
import { gridFactory, nameColumn, nameCellFactory, metaColumn, COLUMNS } from './cells.ts'
import type { CellContext } from './cells.ts'
import { FloatingBar } from './floating-bar.ts'
import { makeDragSource, makeDropTarget } from './dnd.ts'
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
  onDropFiles: (files: GFile[], targetDir?: GFile) => void = () => {}
  isCutFile: (file: GFile) => boolean = () => false

  gridView: any
  columnView: any
  nameCol: any
  gridScroller: any
  listScroller: any
  viewStack: any
  stack: any
  overlay: any
  floatingBar: FloatingBar
  _errorPage: any
  _loading = false
  _emptyKind: EmptyKind = 'folder'
  _typeahead = ''
  _typeaheadTimer = 0
  _wantFocus = false
  _wantScrollTop = false
  _pressedOnItem = false

  constructor() {
    this.store = Gio.ListStore.new(FILE_INFO_TYPE)
    this.selection = Gtk.MultiSelection.new(this.store)

    const ctx = this._cellContext()

    this.gridView = new Gtk.GridView({ model: this.selection, factory: gridFactory(ctx), minColumns: 1, maxColumns: 24, vexpand: true, enableRubberband: true })
    this.gridView.on('activate', (...a: any[]) => this._activate(a[a.length - 1]))

    this.columnView = new Gtk.ColumnView({ model: this.selection, vexpand: true, enableRubberband: true })
    this.columnView.addCssClass('rich-list')
    this.nameCol = nameColumn(ctx)
    this.columnView.appendColumn(this.nameCol)
    for (const [title, fmt, right] of COLUMNS) this.columnView.appendColumn(metaColumn(title, fmt, right))
    this.columnView.on('activate', (...a: any[]) => this._activate(a[a.length - 1]))

    this.gridScroller = scrolled(this.gridView)
    this.gridScroller.addCssClass('nautilus-grid-view')
    this.listScroller = scrolled(this.columnView)
    this.listScroller.addCssClass('nautilus-list-view')

    this.viewStack = new Gtk.Stack()
    this.viewStack.addNamed(this.gridScroller, 'grid')
    this.viewStack.addNamed(this.listScroller, 'list')

    this._addBackgroundMenu(this.gridView)
    this._addBackgroundMenu(this.columnView)
    this._addBackgroundClick(this.gridView)
    this._addBackgroundClick(this.columnView)
    this._installTypeahead(this.gridView)
    this._installTypeahead(this.columnView)

    this._errorPage = new Adw.StatusPage({ iconName: 'dialog-error-symbolic', title: 'Unable to Load Location' })

    this.stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE })
    this.stack.addNamed(this.viewStack, 'results')
    this.stack.addNamed(loadingPage(), 'loading')
    this.stack.addNamed(new Adw.StatusPage({ iconName: 'folder-symbolic', title: 'Folder is Empty' }), 'empty-folder')
    this.stack.addNamed(new Adw.StatusPage({ iconName: 'system-search-symbolic', title: 'No Results Found', description: 'Try a different search term.' }), 'empty-search')
    this.stack.addNamed(this._errorPage, 'error')

    /* Overlay hosts the transient floating bar (typeahead indicator), pinned to
     * the bottom-right like nautilus's NautilusFloatingBar. */
    this.floatingBar = new FloatingBar()
    this.overlay = new Gtk.Overlay({ child: this.stack })
    this.overlay.addOverlay(this.floatingBar.widget)

    /* Accept files dropped from other apps (or this one) into the current view. */
    this.overlay.addController(makeDropTarget(files => this.onDropFiles(files)))
  }

  get widget(): any { return this.overlay }

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
    if (this._loading && this.store.getNItems() > 0) {
      this.stack.setVisibleChildName('results')
      this._applyPending()
    }
  }

  /* Signal an upcoming directory change: reset scroll to top and move focus into
   * the view once results appear (so typeahead/selection keys work immediately). */
  prepareForNavigation(): void {
    this._wantFocus = true
    this._wantScrollTop = true
  }

  _applyPending(): void {
    if (this.stack.getVisibleChildName() !== 'results') return
    if (this._wantScrollTop) { this._scrollTop(); this._wantScrollTop = false }
    if (this._wantFocus) { this._focusVisibleView(); this._wantFocus = false }
  }

  _scrollTop(): void {
    const sw = this.viewStack.getVisibleChildName() === 'list' ? this.listScroller : this.gridScroller
    const adj = sw?.getVadjustment?.()
    if (adj) adj.setValue(0)
  }

  _focusVisibleView(): void {
    const view = this.viewStack.getVisibleChildName() === 'list' ? this.columnView : this.gridView
    view.grabFocus()
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

  invertSelection(): void {
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) {
      if (this.selection.isSelected(i)) this.selection.unselectItem(i)
      else this.selection.selectItem(i, false)
    }
  }

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

  /* Re-run the cell factories to reflect state that isn't in the model (e.g. the
   * cut/clipboard dimming). Rebinds visible cells; selection is preserved. */
  refreshCells(): void {
    this.gridView.setFactory(gridFactory(this._cellContext()))
    this.nameCol.setFactory(nameCellFactory(this._cellContext()))
  }

  /* ---- internals ---- */
  _cellContext(): CellContext {
    return {
      iconSize: () => this.iconSize,
      attachMenu: (w, item) => this._attachMenu(w, item),
      isCut: info => this.isCutFile(info._file),
    }
  }

  _settle(): void {
    if (this.store.getNItems() > 0) { this.stack.setVisibleChildName('results'); this._applyPending() }
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

    /* Drag out the selection (or just this item if it isn't selected). */
    widget.addController(makeDragSource(() => {
      const pos = item.getPosition()
      const file = this.store.getItem(pos)?._file
      const selected = this.getSelected().map(s => s.file)
      if (file && selected.includes(file)) return selected
      return file ? [file] : []
    }))

    /* Drop onto a folder cell moves the dropped files into that folder. */
    widget.addController(makeDropTarget(files => {
      const info = this.store.getItem(item.getPosition())
      if (info && isDirectory(info)) this.onDropFiles(files, info._file)
    }))

    /* Disable rubberband while an item is pressed so item-drag starts a DnD drag
     * rather than a rubberband (GTK issue 5670); re-enable on release/stop so
     * empty-space drag rubberbands. Non-claiming: normal click-to-select stays. */
    const press = new Gtk.GestureClick({ button: 1 })
    press.on('pressed', () => { this._pressedOnItem = true; this._setRubberband(false) })
    press.on('released', () => this._setRubberband(true))
    press.on('stopped', () => this._setRubberband(true))
    widget.addController(press)
  }

  /* Primary click on empty view space clears the selection and moves focus into
   * the view (so keyboard actions work and the search entry blurs). Item presses
   * set `_pressedOnItem` first (bubble: cell before view), so they're skipped. */
  _addBackgroundClick(view: any): void {
    const gesture = new Gtk.GestureClick({ button: 1 })
    gesture.on('pressed', () => {
      if (!this._pressedOnItem) { this.selection.unselectAll(); view.grabFocus() }
      this._pressedOnItem = false
    })
    view.addController(gesture)
  }

  _setRubberband(on: boolean): void {
    this.gridView.setEnableRubberband(on)
    this.columnView.setEnableRubberband(on)
  }

  _addBackgroundMenu(view: any): void {
    const gesture = new Gtk.GestureClick({ button: 3 })
    gesture.on('pressed', (...a: any[]) => {
      const [x, y] = a.slice(-2)
      this.onContextMenu(view, x, y, null)
    })
    view.addController(gesture)
  }

  /* ---- Typeahead (type-to-select) ----
   * Typing plain characters while the view is focused selects the first item
   * whose name matches; the buffer resets after a short idle. */
  _installTypeahead(view: any): void {
    const controller = new Gtk.EventControllerKey()
    controller.on('key-pressed', (...a: any[]) => this._onTypeaheadKey(view, a[0], a[2]))
    view.addController(controller)
  }

  _onTypeaheadKey(view: any, keyval: number, state: number): boolean {
    if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) return false
    if (keyval === Gdk.KEY_Escape) { this._clearTypeahead(); return false }

    if (keyval === Gdk.KEY_BackSpace) {
      if (!this._typeahead) return false
      this._typeahead = this._typeahead.slice(0, -1)
      this._armTypeaheadTimer()
      this._syncTypeaheadBar()
      if (this._typeahead) this._typeaheadFind(view)
      return true
    }

    const ch = Gdk.keyvalToUnicode(keyval)
    if (!ch || ch < 0x20 || ch === 0x7f) return false   /* not a printable char (0x7f = Delete) */
    const s = String.fromCodePoint(ch)
    if (!this._typeahead && s === ' ') return false   /* leading space is a no-op */
    this._typeahead += s
    this._armTypeaheadTimer()
    this._syncTypeaheadBar()
    this._typeaheadFind(view)
    return true
  }

  /* Reflect the current typeahead buffer in the floating indicator. */
  _syncTypeaheadBar(): void {
    if (this._typeahead) this.floatingBar.show(this._typeahead)
    else this.floatingBar.hide()
  }

  _typeaheadFind(view: any): void {
    const needle = this._typeahead.toLowerCase()
    const n = this.store.getNItems()
    const scan = (test: (name: string) => boolean): number => {
      for (let i = 0; i < n; i++)
        if (test(displayName(this.store.getItem(i)).toLowerCase())) return i
      return -1
    }
    /* Prefer a prefix match, fall back to substring. */
    let match = scan(name => name.startsWith(needle))
    if (match < 0) match = scan(name => name.includes(needle))
    if (match < 0) return
    this.selection.selectItem(match, true)
    view.scrollTo(match, Gtk.ListScrollFlags.FOCUS | Gtk.ListScrollFlags.SELECT, null)
  }

  _armTypeaheadTimer(): void {
    if (this._typeaheadTimer) GLib.sourceRemove(this._typeaheadTimer)
    this._typeaheadTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 1000, () => {
      this._typeaheadTimer = 0
      this._typeahead = ''
      this.floatingBar.hide()
      return false
    })
  }

  _clearTypeahead(): void {
    if (this._typeaheadTimer) { GLib.sourceRemove(this._typeaheadTimer); this._typeaheadTimer = 0 }
    this._typeahead = ''
    this.floatingBar.hide()
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
