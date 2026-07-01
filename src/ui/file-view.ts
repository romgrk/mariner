import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import { FILE_INFO_TYPE, uriOf } from '../core/gio.ts'
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

/* Only fall back to the loading spinner if a load is slower than this; faster
 * loads (the common case) swap their results in without ever showing it. */
const SPINNER_DELAY = 300

/* Chord modifiers we discriminate on (lock/scroll bits are ignored). */
const MODIFIER_MASK = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK
  | Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.SUPER_MASK

/* Alt + h/j/k/l → arrow-key directions for cursor movement (vim-inspired). */
const VIM_DIRS: Record<number, 'left' | 'down' | 'up' | 'right'> = {
  [Gdk.KEY_h]: 'left',
  [Gdk.KEY_j]: 'down',
  [Gdk.KEY_k]: 'up',
  [Gdk.KEY_l]: 'right',
}

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
  onPreview: () => void = () => {}
  onFocusIn: () => void = () => {}
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
  _pinTop = false
  _restoreScroll = -1
  _pendingReset = false
  _spinnerTimer = 0
  _merge = false
  _seen: Set<string> | null = null
  _storeKeys: Set<string> | null = null
  _incoming: Entry[] | null = null
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
    this.gridScroller.addCssClass('mariner-grid-view')
    this.listScroller = scrolled(this.columnView)
    this.listScroller.addCssClass('mariner-list-view')

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

    /* Report focus entering this view's subtree, so a dual-pane container can
     * mark this pane active. */
    const focus = new Gtk.EventControllerFocus()
    focus.on('enter', () => this.onFocusIn())
    this.overlay.addController(focus)
  }

  get widget(): any { return this.overlay }

  configure({ sortKey, sortDesc, filter }: ViewConfig): void {
    this.cmp = makeComparator(sortKey, sortDesc)
    this.filter = filter || (() => true)
  }

  beginLoading(): void {
    /* Don't blank the view. Two modes, chosen by whether this is a fresh
     * navigation (see prepareForNavigation → _pinTop):
     *  - navigation: keep the old folder shown until the new one's first item
     *    arrives (see _resetIfPending), then swap in one step;
     *  - refresh / search re-run: reconcile the visible items in place (see
     *    _beginMerge) so unchanged rows keep their widgets and selection — no
     *    flicker when a keystroke yields the same (or similar) results.
     * The spinner only appears if the load is slower than SPINNER_DELAY with
     * nothing useful to show (see _armSpinner). A refresh/search keeps its
     * scroll offset; a navigation pins to the top. */
    this._restoreScroll = this._pinTop ? -1 : this._currentScroll()
    this._loading = true
    if (this._pinTop) { this._merge = false; this._pendingReset = true }
    else { this._pendingReset = false; this._beginMerge() }
    this._armSpinner()
  }

  /* ---- navigation (reset) ---- */

  /* Clear the previous listing right before the first item of the new one is
   * shown, so the swap is a single step (old → new) with no intermediate blank.
   * A no-op after the first call of a load. */
  _resetIfPending(): void {
    if (!this._pendingReset) return
    this._pendingReset = false
    this.all = []
    this.store.removeAll()
  }

  /* ---- refresh / search (in-place merge) ---- */

  /* Snapshot the keys currently in the store; incoming items are then merged
   * against it (mark-and-sweep) instead of clearing and repopulating. */
  _beginMerge(): void {
    this._merge = true
    this._seen = new Set()
    this._storeKeys = new Set()
    this._incoming = []
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) this._storeKeys!.add(this.store.getItem(i)._key)
  }

  _mergeEntries(pairs: Entry[]): void {
    for (const { info, file } of pairs) {
      this._stamp(info, file)
      this._incoming!.push({ info, file })
      if (!this.filter(info)) continue
      this._seen!.add(info._key)
      /* Already displayed → keep its widget (and selection); don't re-insert. */
      if (this._storeKeys!.has(info._key)) continue
      this._insertSorted(info)
      this._storeKeys!.add(info._key)
    }
    if (this._loading && this.store.getNItems() > 0) {
      this._cancelSpinner()
      this.stack.setVisibleChildName('results')
      this._applyPending()
    }
  }

  /* Sweep: drop the rows that weren't in the new result set, adopt the new full
   * dataset, and end the merge. */
  _endMerge(): void {
    this._removeWhere(info => !this._seen!.has(info._key))
    this.all = this._incoming!
    this._merge = false
    this._seen = this._storeKeys = this._incoming = null
  }

  /* Prompt narrowing for name-search-as-you-type: immediately drop visible rows
   * whose name can't contain `query` (keeping matching rows and their widgets),
   * so extending the query filters the list at once instead of leaving stale
   * rows visible until the new search finishes streaming. A wrongly-dropped row
   * (if display-name ≠ on-disk name) is re-added by the search's merge, so this
   * can only ever be optimistic — it never loses a real match. */
  narrowByName(query: string): void {
    if (!query) return
    const q = query.toLowerCase()
    this._removeWhere(info => !displayName(info).toLowerCase().includes(q))
  }

  /* Remove every row for which `shouldRemove` is true, coalescing contiguous
   * runs into one splice each (one items-changed) so bulk removals stay cheap. */
  _removeWhere(shouldRemove: (info: any) => boolean): void {
    let i = this.store.getNItems() - 1
    while (i >= 0) {
      if (!shouldRemove(this.store.getItem(i))) { i--; continue }
      const hi = i
      while (i >= 0 && shouldRemove(this.store.getItem(i))) i--
      this.store.splice(i + 1, hi - i, [])   // remove rows [i+1 .. hi]
    }
  }

  /* Show the spinner only if, after the delay, there's still nothing useful on
   * screen: a navigation whose first item hasn't arrived (the visible items
   * belong to the folder we're leaving), or an empty view (e.g. a search that
   * hasn't matched yet). A refresh/search with items already showing keeps
   * them. */
  _armSpinner(): void {
    this._cancelSpinner()
    this._spinnerTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, SPINNER_DELAY, () => {
      this._spinnerTimer = 0
      if (!this._loading) return false
      if (this._pinTop) {
        if (!this._pendingReset) return false
        this._pendingReset = false
        this.all = []
        this.store.removeAll()
        this.stack.setVisibleChildName('loading')
      } else if (this.store.getNItems() === 0) {
        this.stack.setVisibleChildName('loading')
      }
      return false
    })
  }

  _cancelSpinner(): void {
    if (this._spinnerTimer) { GLib.sourceRemove(this._spinnerTimer); this._spinnerTimer = 0 }
  }

  /* Stash the GFile and a stable identity key on the info wrapper (both survive
   * a round-trip through the GListStore). */
  _stamp(info: GFileInfo, file: GFile): void {
    info._file = file
    info._key = uriOf(file)
  }

  addEntries(pairs: Entry[]): void {
    if (this._merge) { this._mergeEntries(pairs); return }
    this._resetIfPending()
    for (const { info, file } of pairs) {
      this._stamp(info, file)
      this.all.push({ info, file })
      if (this.filter(info)) this._insertSorted(info)
    }
    if (this._loading && this.store.getNItems() > 0) {
      this._cancelSpinner()
      this.stack.setVisibleChildName('results')
      this._applyPending()
    }
  }

  /* Signal an upcoming directory change: pin the view to the top with the first
   * item as the cursor, and move focus into the view once results appear (so
   * typeahead/selection keys work immediately). The pin is held for the whole
   * incremental load — see _applyPending. */
  prepareForNavigation(): void {
    this._wantFocus = true
    this._pinTop = true
  }

  /* Called after every incremental batch (and at finishLoading). Grabs focus
   * once, then re-asserts the load's target position: entries arrive over many
   * batches and are sorted-inserted, so without re-asserting, GTK scrolls the
   * view to follow the cursor as items land above it — leaving a freshly-opened
   * folder scrolled partway down instead of at its first item. */
  _applyPending(): void {
    if (this.stack.getVisibleChildName() !== 'results') return
    if (this._wantFocus) { this._focusVisibleView(); this._wantFocus = false }
    if (this._pinTop) this._pinToTop()
    else if (this._restoreScroll >= 0) this._scrollTo(this._restoreScroll)
  }

  /* Scroll to the top and put the cursor on the first item (like nautilus when
   * you enter a folder). */
  _pinToTop(): void {
    if (this.store.getNItems() === 0) return
    this._scrollItemIntoView(0, Gtk.ListScrollFlags.FOCUS)
    this._scrollTop()
  }

  _scrollAdjustment(): any {
    const sw = this.viewStack.getVisibleChildName() === 'list' ? this.listScroller : this.gridScroller
    return sw?.getVadjustment?.()
  }

  _scrollTop(): void { const adj = this._scrollAdjustment(); if (adj) adj.setValue(0) }
  _currentScroll(): number { const adj = this._scrollAdjustment(); return adj ? adj.getValue() : 0 }

  _scrollTo(value: number): void {
    const adj = this._scrollAdjustment()
    if (adj) adj.setValue(Math.max(0, Math.min(value, adj.getUpper() - adj.getPageSize())))
  }

  /* GridView.scroll_to(pos, flags, scroll); ColumnView.scroll_to(pos, column,
   * flags, scroll) — different arities, so dispatch on the visible view. */
  _scrollItemIntoView(pos: number, flags: any): void {
    if (this.viewStack.getVisibleChildName() === 'list') this.columnView.scrollTo(pos, null, flags, null)
    else this.gridView.scrollTo(pos, flags, null)
  }

  _focusVisibleView(): void {
    const view = this.viewStack.getVisibleChildName() === 'list' ? this.columnView : this.gridView
    view.grabFocus()
  }

  finishLoading(emptyKind: EmptyKind = 'folder'): void {
    this._loading = false
    this._cancelSpinner()
    /* Finalise the load: merge → sweep the rows that are gone; reset → if
     * nothing arrived at all (empty folder / no matches), drop the old listing
     * now so _settle can show the empty state instead of stale items. */
    if (this._merge) this._endMerge()
    else this._resetIfPending()
    this._emptyKind = emptyKind
    this._settle()
    /* Re-assert the final position once more after the full model has been laid
     * out (the adjustment's range isn't final until then), then release the
     * pins so later user scrolling sticks. */
    const pinTop = this._pinTop, restore = this._restoreScroll
    this._pinTop = false
    this._restoreScroll = -1
    if (this.store.getNItems() > 0 && (pinTop || restore >= 0)) {
      GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (pinTop) this._pinToTop()
        else this._scrollTo(restore)
        return false
      })
    }
  }

  showError(message: string): void {
    this._loading = false
    this._cancelSpinner()
    this._pendingReset = false
    this._merge = false
    this._seen = this._storeKeys = this._incoming = null
    this.all = []
    this.store.removeAll()
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

  /* All currently-displayed entries in view order (for the preview to page
   * through), and the index of the first selected one (0 if none). */
  entries(): Entry[] {
    const out: Entry[] = []
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) { const info = this.store.getItem(i); out.push({ info, file: info._file }) }
    return out
  }

  selectedIndex(): number {
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) if (this.selection.isSelected(i)) return i
    return 0
  }

  /* Select + scroll to a row by index (used to keep the view in sync with the
   * preview as it pages through entries). */
  selectIndex(i: number): void {
    if (i < 0 || i >= this.store.getNItems()) return
    this.selection.selectItem(i, true)
    this._scrollItemIntoView(i, Gtk.ListScrollFlags.FOCUS | Gtk.ListScrollFlags.SELECT)
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
    /* CAPTURE phase: intercept keys before the grid/column view's built-in
     * keynav. Space in particular is claimed by the view for selection-toggle at
     * the target phase, so a bubble-phase handler never sees it (Space→preview
     * would just deselect). Keys we don't consume (arrows/Enter/Ctrl chords) are
     * returned unhandled and propagate to the view as usual. */
    controller.setPropagationPhase(Gtk.PropagationPhase.CAPTURE)
    controller.on('key-pressed', (...a: any[]) => this._onTypeaheadKey(view, a[0], a[2]))
    view.addController(controller)
  }

  _onTypeaheadKey(view: any, keyval: number, state: number): boolean {
    /* Alt+h/j/k/l move the cursor like the arrow keys (vim-inspired). Alt alone,
     * so Alt+u (go up) and other Alt chords still fall through to the window's
     * shortcut controller. */
    if ((state & MODIFIER_MASK) === Gdk.ModifierType.ALT_MASK) {
      const dir = VIM_DIRS[Gdk.keyvalToLower(keyval)]
      if (dir !== undefined) return this._vimMove(dir)
    }
    if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) return false
    if (keyval === Gdk.KEY_Escape) { this._clearTypeahead(); return false }

    if (keyval === Gdk.KEY_BackSpace) {
      if (!this._typeahead) return false
      this._typeahead = this._typeahead.slice(0, -1)
      this._armTypeaheadTimer()
      this._syncTypeaheadBar()
      if (this._typeahead) this._typeaheadFind()
      return true
    }

    const ch = Gdk.keyvalToUnicode(keyval)
    if (!ch || ch < 0x20 || ch === 0x7f) return false   /* not a printable char (0x7f = Delete) */
    const s = String.fromCodePoint(ch)
    /* Space with no active typeahead opens the preview (Quick Look), like nautilus. */
    if (!this._typeahead && s === ' ') { this.onPreview(); return true }
    this._typeahead += s
    this._armTypeaheadTimer()
    this._syncTypeaheadBar()
    this._typeaheadFind()
    return true
  }

  /* Reflect the current typeahead buffer in the floating indicator. */
  _syncTypeaheadBar(): void {
    if (this._typeahead) this.floatingBar.show(this._typeahead)
    else this.floatingBar.hide()
  }

  _typeaheadFind(): void {
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
    this._scrollItemIntoView(match, Gtk.ListScrollFlags.FOCUS | Gtk.ListScrollFlags.SELECT)
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

  /* ---- Vim-style cursor movement (Alt+h/j/k/l) ----
   * Move the selection one step in `dir`, mirroring arrow-key navigation: a
   * single item is selected + focused and scrolled into view. The anchor is the
   * current selection's edge in the direction of travel (exact for a lone
   * selection); grid geometry comes from the live column count. */
  _vimMove(dir: 'left' | 'down' | 'up' | 'right'): boolean {
    const n = this.store.getNItems()
    if (n === 0) return true
    const isList = this.viewStack.getVisibleChildName() === 'list'
    /* A flat list has no columns, so left/right have nowhere to move. */
    if (isList && (dir === 'left' || dir === 'right')) return true

    const forward = dir === 'down' || dir === 'right'
    const sel = this.selection.getSelection()
    let target: number
    if (sel.getSize() === 0) {
      target = forward ? 0 : n - 1
    } else {
      const cols = isList ? 1 : this._gridColumns()
      const anchor = forward ? sel.getMaximum() : sel.getMinimum()
      const step = dir === 'up' || dir === 'down' ? cols : 1
      target = forward ? anchor + step : anchor - step
      if (target < 0 || target >= n) return true   /* at an edge — stay put */
    }
    this.selection.selectItem(target, true)
    this._scrollItemIntoView(target, Gtk.ListScrollFlags.FOCUS | Gtk.ListScrollFlags.SELECT)
    return true
  }

  /* Count items in the grid's first realized row (they share a top offset) to
   * get the live column count. Falls back to 1 (linear movement) if unavailable. */
  _gridColumns(): number {
    try {
      let child = this.gridView.getFirstChild()
      if (!child) return 1
      const top = child.getAllocation().y
      let cols = 0
      while (child && child.getAllocation().y === top) {
        cols++
        child = child.getNextSibling()
      }
      return Math.max(1, cols)
    } catch {
      return 1
    }
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
