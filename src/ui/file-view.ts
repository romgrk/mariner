import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import { FILE_INFO_TYPE, uriOf } from '../core/gio.ts'
import { displayName, isDirectory, formatBytes } from '../core/format.ts'
import { makeComparator } from '../core/comparator.ts'
import type { Comparator } from '../core/comparator.ts'
import { gridFactory, nameColumn, nameCellFactory, metaColumn } from './cells.ts'
import type { CellContext } from './cells.ts'
import { fuzzyMatch } from '../core/fuzzy-match.ts'
import { COLUMN_DEF, TRASH_COLUMN, defaultColumnConfig } from '../core/columns.ts'
import { FloatingBar } from './floating-bar.ts'
import { globMatcher } from '../core/glob.ts'
import { makeDragSource, makeDropTarget } from './dnd.ts'
import type { ColumnConfig, Entry, GFile, GFileInfo, ViewConfig, ViewMode, EmptyKind } from '../core/types.ts'

type ActivateHandler = (info: GFileInfo, file: GFile) => void
type ContextMenuHandler = (widget: any, x: number, y: number, target: Entry | null) => void

/* Only fall back to the loading spinner if a load is slower than this; faster
 * loads (the common case) swap their results in without ever showing it. */
const SPINNER_DELAY = 300
/* Grace period before the floating "Searching…" bar appears, so a search that
 * finishes near-instantly never flashes it (mirrors nautilus's loading delay). */
const SEARCH_BAR_DELAY = 200

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

/* Bare modifier keysyms. Pressing one alone must NOT cancel the typeahead: you
 * hold Shift before a capital, Alt/Ctrl before a chord. Every other
 * non-printable key does cancel it. */
const MODIFIER_KEYS = new Set<number>([
  Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
  Gdk.KEY_Control_L, Gdk.KEY_Control_R,
  Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
  Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
  Gdk.KEY_Super_L, Gdk.KEY_Super_R,
  Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
  Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock, Gdk.KEY_Num_Lock,
  Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift,
])

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
  onSearchStop: () => void = () => {}
  isCutFile: (file: GFile) => boolean = () => false

  gridView: any
  columnView: any
  nameCol: any
  _metaCols: any[] = []
  _columnsSig = ''
  gridScroller: any
  listScroller: any
  viewStack: any
  stack: any
  overlay: any
  floatingBar: FloatingBar
  _statusDirty = false
  _errorPage: any
  _loading = false
  _emptyKind: EmptyKind = 'folder'
  _typeahead = ''
  _typeaheadTimer = 0
  _wantFocus = false
  _pinTop = false
  _restoreScroll = -1
  _revealUris: Set<string> | null = null
  _pendingReset = false
  _spinnerTimer = 0
  _searchProgress = false
  _searchProgressTimer = 0
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
    this.setColumns(defaultColumnConfig())
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

    /* Overlay hosts the floating bar, pinned bottom-right like nautilus's
     * NautilusFloatingBar. One pill, shown at a time (see _refreshBar): the
     * "Searching…" status while a search runs, else the typeahead query while
     * typing, else the selection status ("12 items selected (348 MB)"). */
    this.floatingBar = new FloatingBar()
    this.floatingBar.onStop = () => this.onSearchStop()
    this.overlay = new Gtk.Overlay({ child: this.stack })
    this.overlay.addOverlay(this.floatingBar.widget)

    /* Accept files dropped from other apps (or this one) into the current view. */
    this.overlay.addController(makeDropTarget(files => this.onDropFiles(files)))

    /* Report focus entering this view's subtree, so a dual-pane container can
     * mark this pane active. */
    const focus = new Gtk.EventControllerFocus()
    focus.on('enter', () => this.onFocusIn())
    this.overlay.addController(focus)

    /* Keep the selection status current. Both signals fire in bursts (rubber-band
     * drag, incremental sorted-insert during a load), so the refresh is coalesced
     * onto the idle loop — one pass per frame, not per event. */
    this.selection.on('selection-changed', () => this._scheduleStatus())
    this.store.on('items-changed', () => this._scheduleStatus())
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
    const toInsert: GFileInfo[] = []
    for (const { info, file } of pairs) {
      this._stamp(info, file)
      this._incoming!.push({ info, file })
      if (!this.filter(info)) continue
      this._seen!.add(info._key)
      /* Already displayed → keep its widget (and selection); don't re-insert. */
      if (this._storeKeys!.has(info._key)) continue
      toInsert.push(info)
      this._storeKeys!.add(info._key)
    }
    this._bulkInsertSorted(toInsert)
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

  /* Drop every shown row now. Used when the search mode flips (name ↔ content):
   * the two yield unrelated result sets, so the previous mode's matches would
   * otherwise stay visible while the new search streams in. The following
   * beginLoading snapshots the now-empty store, so nothing stale can survive. */
  clearResults(): void {
    this.all = []
    this.store.removeAll()
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
    const toInsert: GFileInfo[] = []
    for (const { info, file } of pairs) {
      this._stamp(info, file)
      this.all.push({ info, file })
      if (this.filter(info)) toInsert.push(info)
    }
    this._bulkInsertSorted(toInsert)
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
    this._applyReveal()
  }

  /* Reveal-and-select: used when the view is opened to highlight specific items
   * (org.freedesktop.FileManager1 ShowItems / "Show in folder"). The targets are
   * matched by URI as the folder streams in, so items that arrive in a later
   * batch still get selected. Suppresses the pin-to-top so the view scrolls to
   * the revealed item instead. Cleared once the load settles (finishLoading). */
  setPendingReveal(uris: string[]): void {
    this._revealUris = uris.length ? new Set(uris) : null
    if (this._revealUris) { this._pinTop = false; this._applyReveal() }
  }

  /* Re-assert the reveal selection against the current store: select every row
   * whose URI is a target (the first match clears any prior selection, e.g. the
   * default cursor on item 0), then scroll it into view. Idempotent — re-running
   * on each incoming batch just re-selects the same items after sorted inserts
   * shift their positions. */
  _applyReveal(uris: Set<string> | null = this._revealUris): void {
    if (!uris || this.stack.getVisibleChildName() !== 'results') return
    const n = this.store.getNItems()
    let first = -1
    for (let i = 0; i < n; i++) {
      if (!uris.has(this.store.getItem(i)._key)) continue
      this.selection.selectItem(i, first < 0)
      if (first < 0) first = i
    }
    if (first >= 0) this._scrollItemIntoView(first, Gtk.ListScrollFlags.FOCUS)
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
     * pins so later user scrolling sticks. A pending reveal takes precedence:
     * it re-selects and scrolls to its targets, overriding pin/restore, and is
     * a one-shot — cleared here so a later refresh doesn't re-hijack selection. */
    const pinTop = this._pinTop, restore = this._restoreScroll, reveal = this._revealUris
    this._pinTop = false
    this._restoreScroll = -1
    this._revealUris = null
    if (this.store.getNItems() > 0 && (pinTop || restore >= 0 || reveal)) {
      GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (reveal) this._applyReveal(reveal)
        else if (pinTop) this._pinToTop()
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

  /* Rebuild the list view's meta columns (everything after the fixed Name
   * column) from `configs`: the visible ones, in order. In the Trash the
   * Original Location column is appended after them — it isn't part of the
   * persisted config, so it lives outside `configs` and only shows here. A
   * no-op when the visible set/order (and trash state) is unchanged, so it's
   * cheap to call on every pref sync. */
  setColumns(configs: ColumnConfig[], inTrash = false): void {
    const visible = configs.filter(c => c.visible && COLUMN_DEF[c.id]).map(c => COLUMN_DEF[c.id])
    if (inTrash) visible.push(TRASH_COLUMN)
    const sig = visible.map(d => d.id).join(',')
    if (sig === this._columnsSig) return
    this._columnsSig = sig
    for (const col of this._metaCols) this.columnView.removeColumn(col)
    this._metaCols = visible.map(def => {
      const col = metaColumn(def)
      this.columnView.appendColumn(col)
      return col
    })
  }

  setZoom(px: number): void {
    this.iconSize = px
    this.gridView.setFactory(gridFactory(this._cellContext()))
  }

  selectAll(): void { this.selection.selectAll() }

  /* Replace the selection with every row whose name matches the shell glob
   * `pattern` (*, ? wildcards), like nautilus's "Select Items Matching" (Ctrl+S).
   * Returns the match count; scrolls the first match into view. (Per-row toggling
   * rather than SelectionModel.set_selection, which node-gtk mis-marshals for a
   * pair of Bitset args — it applied only the first bit.) */
  selectPattern(pattern: string): number {
    const match = globMatcher(pattern)
    const n = this.store.getNItems()
    this.selection.unselectAll()
    let first = -1, count = 0
    for (let i = 0; i < n; i++) {
      if (!match(displayName(this.store.getItem(i)))) continue
      this.selection.selectItem(i, false)   // add to selection, keep earlier matches
      if (first < 0) first = i
      count++
    }
    /* Scroll the first match into view with FOCUS only — the SELECT flag would
     * re-select that row *exclusively*, collapsing the multi-selection we just
     * built back down to one item. */
    if (first >= 0) this._scrollItemIntoView(first, Gtk.ListScrollFlags.FOCUS)
    return count
  }

  /* Move keyboard focus into the visible view (e.g. to restore it after a dialog
   * that stole focus closes). */
  focusView(): void { this._focusVisibleView() }

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

  /* ---- Floating status bar (selection summary) ----
   * The one floating pill shows the typeahead query while you're typing and, the
   * rest of the time, the selection summary — like nautilus, which surfaces the
   * bar only when something is selected (no idle "N items" clutter). */

  /* Coalesce a refresh onto the idle loop: a single dirty flag collapses the
   * burst of signals from a load / rubber-band drag into one pass. */
  _scheduleStatus(): void {
    if (this._statusDirty) return
    this._statusDirty = true
    GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._statusDirty = false
      this._refreshBar()
      return false
    })
  }

  /* Resolve what the floating pill shows, most-important first: a running search
   * (spinner + Cancel) wins, then an active typeahead query, then the selection
   * summary, else nothing. */
  _refreshBar(): void {
    if (this._searchProgress) { this.floatingBar.show('Searching…', { spinner: true, stop: true }); return }
    if (this._typeahead) { this.floatingBar.show(this._typeahead); return }
    const text = this._selectionStatus()
    if (text) this.floatingBar.show(text)
    else this.floatingBar.hide()
  }

  /* nautilus-style summary of the current selection, or null if nothing is
   * selected. Files contribute their size (getSize is a BigInt under node-gtk);
   * folders don't, since their inode size isn't the recursive total. */
  _selectionStatus(): string | null {
    const n = this.store.getNItems()
    let files = 0, folders = 0, bytes = 0, firstName = ''
    for (let i = 0; i < n; i++) {
      if (!this.selection.isSelected(i)) continue
      const info = this.store.getItem(i)
      if (!firstName) firstName = displayName(info)
      if (isDirectory(info)) folders++
      else { files++; bytes += Number(info.getSize()) }
    }
    if (files + folders === 0) return null
    const size = formatBytes(bytes)
    if (files + folders === 1) return folders === 1 ? `“${firstName}” selected` : `“${firstName}” selected (${size})`
    if (files === 0) return `${folders} folders selected`
    if (folders === 0) return `${files} items selected (${size})`
    return `${folders} ${folders === 1 ? 'folder' : 'folders'} selected, ${files} other ${files === 1 ? 'item' : 'items'} selected (${size})`
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

  /* Merge a batch of already-filtered, not-yet-present infos into the sorted
   * store and apply it as a SINGLE splice that replaces the whole model, rather
   * than one insert per item. A GtkListView only re-realizes its visible rows on
   * items-changed, so one bulk replace costs ~the same whether it adds 1 row or
   * 10 000; but a per-item insert pays the selection-model + grid + column
   * items-changed cost once per row — which is what froze the UI for seconds
   * when a large search streamed thousands of scattered matches at once. Sorted
   * results are scattered across the list, so run-coalescing insert doesn't
   * help; replacing the model wholesale does. Selection is preserved by key. */
  _bulkInsertSorted(infos: GFileInfo[]): void {
    if (infos.length === 0) return
    infos.sort(this.cmp)
    const n = this.store.getNItems()
    const cur: GFileInfo[] = new Array(n)
    for (let k = 0; k < n; k++) cur[k] = this.store.getItem(k)
    /* Merge the two sorted runs (existing rows keep their order; a new row lands
     * after existing rows it ties with, matching the old per-item insert). */
    const merged: GFileInfo[] = new Array(n + infos.length)
    let a = 0, b = 0, m = 0
    while (a < n && b < infos.length) merged[m++] = this.cmp(cur[a], infos[b]) <= 0 ? cur[a++] : infos[b++]
    while (a < n) merged[m++] = cur[a++]
    while (b < infos.length) merged[m++] = infos[b++]
    const selected = this._selectedKeys()
    this.store.splice(0, n, merged)
    if (selected) this._reselectKeys(selected)
  }

  /* Keys of the currently-selected rows (null when the selection is empty, so
   * the common streaming case pays nothing). */
  _selectedKeys(): Set<string> | null {
    if (Number(this.selection.getSelection().getSize()) === 0) return null
    const keys = new Set<string>()
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) if (this.selection.isSelected(i)) keys.add(this.store.getItem(i)._key)
    return keys
  }

  _reselectKeys(keys: Set<string>): void {
    const n = this.store.getNItems()
    for (let i = 0; i < n; i++) if (keys.has(this.store.getItem(i)._key)) this.selection.selectItem(i, false)
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
   * Typing plain characters while the view is focused selects the item whose
   * name best fuzzy-matches the buffer; the buffer resets after a short idle. */
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
      if (dir !== undefined) { this._clearTypeahead(); return this._vimMove(dir) }
    }
    if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) { this._clearTypeahead(); return false }
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
    if (!ch || ch < 0x20 || ch === 0x7f) {   /* not a printable char (0x7f = Delete) */
      /* Any non-printable keystroke (Enter, Tab, arrows, …) cancels an
       * in-progress query; bare modifiers don't, so Shift+letter still types. */
      if (!MODIFIER_KEYS.has(keyval)) this._clearTypeahead()
      return false
    }
    const s = String.fromCodePoint(ch)
    /* Space with no active typeahead opens the preview (Quick Look), like nautilus. */
    if (!this._typeahead && s === ' ') { this.onPreview(); return true }
    this._typeahead += s
    this._armTypeaheadTimer()
    this._syncTypeaheadBar()
    this._typeaheadFind()
    return true
  }

  /* Reflect the current typeahead buffer in the floating indicator (falling back
   * to the selection summary once the buffer empties — see _refreshBar). */
  _syncTypeaheadBar(): void { this._refreshBar() }

  /* Show the "Searching…" pill (spinner + Cancel) once the search outlives a
   * short delay, so a quick search never flashes it. Called on each search
   * (re-)start; a no-op while one is already showing or pending. */
  showSearchProgress(): void {
    if (this._searchProgress || this._searchProgressTimer) return
    this._searchProgressTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, SEARCH_BAR_DELAY, () => {
      this._searchProgressTimer = 0
      this._searchProgress = true
      this._refreshBar()
      return false
    })
  }

  hideSearchProgress(): void {
    if (this._searchProgressTimer) { GLib.sourceRemove(this._searchProgressTimer); this._searchProgressTimer = 0 }
    if (!this._searchProgress) return
    this._searchProgress = false
    this._refreshBar()
  }

  /* Rank every row by fuzzy score (the same fzy scorer the command palette uses)
   * and select the best match. fzy strongly rewards prefix / consecutive runs,
   * so a literal "doc…" file still wins for the query "doc", while a scattered
   * subsequence ("myDocument") is matched too when nothing better exists — a
   * strict superset of the old prefix-then-substring scan.
   *
   * `ignoreTail` drops fzy's shorter-is-better bias, so two names that match
   * equally well tie; `> best` then keeps the first such row, resolving ties to
   * view (sorted) order — you land on the first matching row like a classic
   * file manager, not the shortest name, and the selection never wanders. */
  _typeaheadFind(): void {
    const query = this._typeahead
    const n = this.store.getNItems()
    let bestIndex = -1
    let bestScore = -Infinity
    for (let i = 0; i < n; i++) {
      const m = fuzzyMatch(query, displayName(this.store.getItem(i)), { ignoreTail: true })
      if (m && m.score > bestScore) { bestScore = m.score; bestIndex = i }
    }
    if (bestIndex < 0) return
    this.selection.selectItem(bestIndex, true)
    this._scrollItemIntoView(bestIndex, Gtk.ListScrollFlags.FOCUS | Gtk.ListScrollFlags.SELECT)
  }

  _armTypeaheadTimer(): void {
    if (this._typeaheadTimer) GLib.sourceRemove(this._typeaheadTimer)
    this._typeaheadTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 1000, () => {
      this._typeaheadTimer = 0
      this._typeahead = ''
      this._refreshBar()
      return false
    })
  }

  _clearTypeahead(): void {
    if (!this._typeahead && !this._typeaheadTimer) return
    if (this._typeaheadTimer) { GLib.sourceRemove(this._typeaheadTimer); this._typeaheadTimer = 0 }
    this._typeahead = ''
    this._refreshBar()
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
    /* Bitset.get_size is a guint64 → BigInt under node-gtk; coerce, or `=== 0` is
     * never true and an empty selection wrongly falls through to the edge math. */
    if (Number(sel.getSize()) === 0) {
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
