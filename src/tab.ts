import { FileView } from './ui/file-view.ts'
import { DirectoryService } from './services/directory-service.ts'
import { SearchService } from './services/search-service.ts'
import { History } from './core/navigation.ts'
import { F } from './core/gio.ts'
import { locationName } from './core/format.ts'
import type { AppWindow } from './window.ts'
import type { Entry, GFile, GFileInfo, ViewConfig } from './core/types.ts'

/* Per-tab controller: binds a DirectoryService + SearchService to a FileView,
 * owns navigation history and search state. Holds no widget construction beyond
 * the view it drives. */
export class Tab {
  win: AppWindow
  view: FileView
  dir: DirectoryService
  search: SearchService
  history: History
  location: GFile | null = null
  searching = false
  searchQuery = ''
  page: any

  constructor(win: AppWindow, file: GFile) {
    this.win = win
    this.view = new FileView()
    this.view.onActivate = (info, f) => win.onItemActivated(this, info, f)
    this.view.onContextMenu = (w, x, y, target) => win.showContextMenu(this, w, x, y, target)

    this.dir = new DirectoryService()
    this.search = new SearchService()
    this.history = new History()

    this._wire()
    this.page = win.tabView.append(this.view.widget)
    this.navigate(file, false)
  }

  get canGoBack(): boolean { return this.history.canGoBack }
  get canGoForward(): boolean { return this.history.canGoForward }
  get parent(): GFile | null { return F.getParent(this.location) }
  get isShowingSearch(): boolean { return this.searching && !!this.searchQuery }

  _wire(): void {
    this.dir.on('loading', () => { this.view.configure(this._dirConfig()); this.view.beginLoading() })
    this.dir.on('items', (batch: GFileInfo[]) => this.view.addEntries(
      batch.map((info): Entry => ({ info, file: F.getChild(this.location, info.getName()) }))))
    this.dir.on('ready', () => this.view.finishLoading('folder'))
    this.dir.on('error', (msg: string) => this.view.showError(msg))
    this.dir.on('invalidated', () => { if (!this.isShowingSearch) this.dir.load(this.location) })

    this.search.on('start', () => { this.view.configure(this._searchConfig()); this.view.beginLoading() })
    this.search.on('result', (pair: Entry) => this.view.addEntries([pair]))
    this.search.on('end', () => { if (this.isShowingSearch) this.view.finishLoading('search') })
    this.search.on('error', (msg: string) => this.view.showError(msg))
  }

  _dirConfig(): ViewConfig {
    const p = this.win.prefs
    return {
      sortKey: p.sortKey, sortDesc: p.sortDesc,
      filter: p.showHidden ? null : (info: GFileInfo) => !info.getIsHidden() && !info.getIsBackup(),
    }
  }
  _searchConfig(): ViewConfig {
    const p = this.win.prefs
    return { sortKey: p.sortKey, sortDesc: p.sortDesc, filter: null }
  }

  /* ---- navigation ---- */
  navigate(file: GFile, push = true): void {
    this._exitSearch()
    if (push && this.location) this.history.visit(this.location)
    this.location = file
    this.dir.load(file)
    this._afterChange()
  }

  back(): void { this._go(this.history.goBack(this.location)) }
  forward(): void { this._go(this.history.goForward(this.location)) }
  up(): void { const p = this.parent; if (p) this.navigate(p) }
  reload(): void { this.isShowingSearch ? this._runSearch() : this.dir.load(this.location) }

  _go(file: GFile | null): void {
    if (!file) return
    this._exitSearch()
    this.location = file
    this.dir.load(file)
    this._afterChange()
  }

  /* ---- search ---- */
  beginSearch(): void { this.searching = true; this.searchQuery = ''; this._runSearch() }
  setSearchQuery(q: string): void { if (!this.searching) return; this.searchQuery = q; this._runSearch() }
  endSearch(): void { if (!this.searching) return; this._exitSearch(); this.dir.load(this.location) }

  _exitSearch(): void { this.searching = false; this.searchQuery = ''; this.search.cancel() }

  _runSearch(): void {
    if (this.searchQuery) {
      this.dir.cancel()
      this.search.search(this.location, this.searchQuery, { showHidden: this.win.prefs.showHidden })
    } else {
      this.search.cancel()
      this.dir.load(this.location)   /* empty query → show the current folder */
    }
  }

  /* ---- prefs ---- */
  applyPrefs(): void {
    this.view.setMode(this.win.prefs.viewMode)
    this.view.setZoom(this.win.prefs.iconSize)
    if (this.isShowingSearch) {
      this._runSearch()
    } else {
      this.view.configure(this._dirConfig())
      this.view.rebuild()
    }
  }

  _afterChange(): void {
    this.view.setMode(this.win.prefs.viewMode)
    this.view.setZoom(this.win.prefs.iconSize)
    this.page.setTitle(locationName(this.location))
    this.win.onTabChanged(this)
  }

  destroy(): void { this.dir.cancel(); this.search.cancel() }
}
