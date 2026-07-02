import Gtk from 'gi:Gtk-4.0'
import { FileView } from './ui/file-view.ts'
import { createComputerView } from './ui/computer.ts'
import type { ComputerView } from './ui/computer.ts'
import { DirectoryService } from './services/directory-service.ts'
import { SearchService } from './services/search-service.ts'
import { COMPUTER_URI } from './services/places-service.ts'
import { History } from './core/navigation.ts'
import { recordFolderVisit } from './services/recent-folders.ts'
import { fileForUri } from './core/gio.ts'
import { archiveFileOf, isArchiveLocation } from './core/archive-uri.ts'
import type { Entry, GFile, GFileInfo, Prefs, ViewConfig, SearchFilter } from './core/types.ts'

/* A single browsing pane: binds a DirectoryService + SearchService to one
 * FileView, owns its navigation history and search state. Decoupled from the
 * window and tab — it reads global `prefs` (mutated in place elsewhere) and
 * routes user intents through injected callbacks the container wires up. A Tab
 * hosts one or two of these (dual-pane). */
export class Pane {
  prefs: Prefs
  view: FileView
  computer: ComputerView
  paneStack: any
  dir: DirectoryService
  search: SearchService
  history: History
  location: GFile | null = null
  searching = false
  searchQuery = ''
  searchFilter: SearchFilter = { category: 'all', since: 0, contents: false }
  _lastContentMode = false

  /* Injected by the container (Tab). Defaults are inert. */
  onActivate: (info: GFileInfo, file: GFile) => void = () => {}
  onContextMenu: (widget: any, x: number, y: number, target: Entry | null) => void = () => {}
  onDropFiles: (files: GFile[], targetDir?: GFile) => void = () => {}
  onPreview: () => void = () => {}
  onFocused: () => void = () => {}
  onChanged: () => void = () => {}
  onDriveContextMenu: (file: GFile, widget: any, x: number, y: number) => void = () => {}
  isCutFile: (file: GFile) => boolean = () => false

  /* The initial navigation is deferred to `navigate()` so the container can wire
   * callbacks (onChanged/onActivate/…) before the first load fires them. */
  constructor(prefs: Prefs) {
    this.prefs = prefs
    this.view = new FileView()
    this.view.onActivate = (info, f) => this.onActivate(info, f)
    this.view.onContextMenu = (w, x, y, target) => this.onContextMenu(w, x, y, target)
    this.view.onDropFiles = (files, targetDir) => this.onDropFiles(files, targetDir)
    this.view.onPreview = () => this.onPreview()
    this.view.onFocusIn = () => this.onFocused()
    this.view.isCutFile = f => this.isCutFile(f)

    /* The Computer interface (computer:///) lives alongside the file view in a
     * stack; navigation swaps between them. Activating a drive tile navigates
     * this pane into that drive's mount point. */
    this.computer = createComputerView()
    this.computer.onActivate = file => this.navigate(file)
    this.computer.onContextMenu = (file, w, x, y) => this.onDriveContextMenu(file, w, x, y)
    this.paneStack = new Gtk.Stack()
    this.paneStack.addNamed(this.view.widget, 'files')
    this.paneStack.addNamed(this.computer.widget, 'computer')

    this.dir = new DirectoryService()
    this.search = new SearchService()
    this.history = new History()

    this._wire()
  }

  get widget(): any { return this.paneStack }
  get canGoBack(): boolean { return this.history.canGoBack }
  get canGoForward(): boolean { return this.history.canGoForward }
  get parent(): GFile | null {
    const p = this.location.getParent()
    if (p) return p
    /* The Computer view sits above the filesystem root, so Up from "/" lands
     * there (and enables the Up button at "/"). */
    if (this.location && this.location.getPath() === '/') return fileForUri(COMPUTER_URI)
    /* Up from an archive's root leaves the archive, landing on the folder that
     * contains the archive file. */
    const archive = this.location && archiveFileOf(this.location)
    if (archive) return archive.getParent()
    return null
  }
  get searchActive(): boolean { return !!this.searchQuery || this.searchFilter.category !== 'all' || this.searchFilter.since > 0 }
  get isShowingSearch(): boolean { return this.searching && this.searchActive }

  _wire(): void {
    this.dir.on('loading', () => { this.view.configure(this._dirConfig()); this.view.beginLoading() })
    this.dir.on('items', (batch: GFileInfo[]) => this.view.addEntries(
      batch.map((info): Entry => ({ info, file: this.location.getChild(info.getName()) }))))
    this.dir.on('ready', () => this.view.finishLoading('folder'))
    this.dir.on('error', (msg: string) => this.view.showError(msg))
    this.dir.on('invalidated', () => { if (!this.isShowingSearch) this.dir.load(this.location) })

    this.search.on('start', () => { this.view.configure(this._searchConfig()); this.view.beginLoading() })
    this.search.on('result', (pair: Entry) => this.view.addEntries([pair]))
    this.search.on('end', () => { if (this.isShowingSearch) this.view.finishLoading('search') })
    this.search.on('error', (msg: string) => this.view.showError(msg))
  }

  _dirConfig(): ViewConfig {
    const p = this.prefs
    return {
      sortKey: p.sortKey, sortDesc: p.sortDesc,
      filter: p.showHidden ? null : (info: GFileInfo) => !info.getIsHidden() && !info.getIsBackup(),
    }
  }
  _searchConfig(): ViewConfig {
    const p = this.prefs
    return { sortKey: p.sortKey, sortDesc: p.sortDesc, filter: null }
  }

  /* ---- navigation ---- */
  get isComputer(): boolean { return !!this.location && this.location.getUri().startsWith('computer:') }

  navigate(file: GFile, push = true): void {
    this._exitSearch()
    if (push && this.location) this.history.visit(this.location)
    this.location = file
    this._recordVisit(file)
    this._load(file)
    this.onChanged()
  }

  /* Archive:// mounts are transient (and their double-escaped URIs unsightly),
   * so keep them out of the recent-folders / "jump to folder" history. */
  _recordVisit(file: GFile): void {
    if (!isArchiveLocation(file)) recordFolderVisit(file.getUri())
  }

  back(): void { this._go(this.history.goBack(this.location)) }
  forward(): void { this._go(this.history.goForward(this.location)) }
  up(): void { const p = this.parent; if (p) this.navigate(p) }
  reload(): void {
    if (this.isComputer) this.computer.refresh()
    else this.isShowingSearch ? this._runSearch() : this.dir.load(this.location)
  }

  _go(file: GFile | null): void {
    if (!file) return
    this._exitSearch()
    this.location = file
    this._recordVisit(file)
    this._load(file)
    this.onChanged()
  }

  /* Show the location: the Computer interface for computer:///, otherwise load
   * the directory into the file view. */
  _load(file: GFile): void {
    if (file.getUri().startsWith('computer:')) {
      this.computer.refresh()
      this.paneStack.setVisibleChildName('computer')
    } else {
      this.paneStack.setVisibleChildName('files')
      this.view.prepareForNavigation()
      this.dir.load(file)
    }
  }

  /* ---- search ---- */
  beginSearch(): void { this.searching = true; this.searchQuery = ''; this._runSearch() }
  setSearchQuery(q: string): void { if (!this.searching) return; this.searchQuery = q; this._runSearch() }
  setSearchFilter(f: SearchFilter): void { this.searchFilter = f; if (this.searching) this._runSearch() }
  /* prepareForNavigation so the folder reload swaps in cleanly and moves focus
   * into the file view once its rows appear — exiting search (Escape / toggle
   * off) should land on the panel, not the header. */
  endSearch(): void { if (!this.searching) return; this._exitSearch(); this.view.prepareForNavigation(); this.dir.load(this.location) }

  _exitSearch(): void { this.searching = false; this.searchQuery = ''; this.search.cancel() }

  _runSearch(): void {
    if (this.searchActive) {
      this.dir.cancel()
      /* Prune non-matching rows immediately so name-search-as-you-type narrows
       * at once; the search then reconciles (adds deeper matches, drops any
       * over-kept rows) without flicker. Content matches can't be predicted
       * from names, so that mode keeps the plain merge. */
      const contentMode = !!(this.searchQuery && this.searchFilter.contents)
      /* Flipping name↔content produces an unrelated result set, so drop the old
       * mode's rows now rather than letting them linger while the new (possibly
       * slow, ripgrep) search streams in. */
      if (contentMode !== this._lastContentMode) this.view.clearResults()
      this._lastContentMode = contentMode
      if (this.searchQuery && !this.searchFilter.contents) this.view.narrowByName(this.searchQuery)
      this.search.search(this.location, this.searchQuery, { showHidden: this.prefs.showHidden, filter: this.searchFilter })
    } else {
      this.search.cancel()
      this.dir.load(this.location)   /* empty query + no filter → show the current folder */
    }
  }

  /* ---- prefs ---- */
  applyPrefs(): void {
    this.view.setMode(this.prefs.viewMode)
    this.view.setZoom(this.prefs.iconSize)
    this.view.setColumns(this.prefs.columns)
    if (this.isShowingSearch) {
      this._runSearch()
    } else {
      this.view.configure(this._dirConfig())
      this.view.rebuild()
    }
  }

  /* Just the list-view columns (called when the column chooser applies). */
  applyColumns(): void { this.view.setColumns(this.prefs.columns) }

  /* Re-apply view mode + zoom + columns (called after navigation / when made
   * active) so a tab that wasn't focused when a pref changed catches up. */
  syncView(): void {
    this.view.setMode(this.prefs.viewMode)
    this.view.setZoom(this.prefs.iconSize)
    this.view.setColumns(this.prefs.columns)
  }

  destroy(): void { this.dir.cancel(); this.search.cancel() }
}
