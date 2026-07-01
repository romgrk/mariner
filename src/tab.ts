import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { Pane } from './pane.ts'
import { F } from './core/gio.ts'
import { locationName } from './core/format.ts'
import type { AppWindow } from './window.ts'
import type { GFile, SearchFilter } from './core/types.ts'

/* Per-tab controller: hosts one or two Panes (dual-pane) in an Adw.Bin that is
 * the tab page's child. Tracks which pane is active and delegates the browsing
 * surface (view / location / navigation / search) to it, so the window keeps
 * driving `activeTab.*` largely unchanged. When split, panes sit in a Gtk.Paned;
 * unsplit, the single pane fills the Bin directly. */
export class Tab {
  win: AppWindow
  container: any
  paned: any = null
  panes: Pane[] = []
  activePane!: Pane
  page: any

  constructor(win: AppWindow, file: GFile) {
    this.win = win
    this.container = new Adw.Bin()
    this.page = win.tabView.append(this.container)

    const pane = this._makePane()
    this.panes = [pane]
    this.activePane = pane
    this.container.setChild(pane.widget)
    pane.navigate(file, false)
  }

  /* ---- delegation to the active pane ---- */
  get view(): any { return this.activePane.view }
  get location(): GFile | null { return this.activePane.location }
  get canGoBack(): boolean { return this.activePane.canGoBack }
  get canGoForward(): boolean { return this.activePane.canGoForward }
  get parent(): GFile | null { return this.activePane.parent }
  get isShowingSearch(): boolean { return this.activePane.isShowingSearch }
  get isSplit(): boolean { return this.panes.length > 1 }

  navigate(file: GFile, push = true): void { this.activePane.navigate(file, push) }
  back(): void { this.activePane.back() }
  forward(): void { this.activePane.forward() }
  up(): void { this.activePane.up() }
  reload(): void { this.activePane.reload() }

  beginSearch(): void { this.activePane.beginSearch() }
  setSearchQuery(q: string): void { this.activePane.setSearchQuery(q) }
  setSearchFilter(f: SearchFilter): void { this.activePane.setSearchFilter(f) }
  endSearch(): void { this.activePane.endSearch() }

  /* Prefs (view mode, sort, hidden, zoom) are global — apply to every pane. */
  applyPrefs(): void { for (const p of this.panes) p.applyPrefs() }

  /* Just the list-view columns changed (column chooser) — apply to every pane. */
  applyColumns(): void { for (const p of this.panes) p.applyColumns() }

  /* ---- pane lifecycle / wiring ---- */
  _makePane(): Pane {
    const pane = new Pane(this.win.prefs)
    pane.onActivate = (info, f) => { this.setActivePane(pane); this.win.onItemActivated(this, info, f) }
    pane.onContextMenu = (w, x, y, target) => { this.setActivePane(pane); this.win.showContextMenu(this, w, x, y, target) }
    pane.onDropFiles = (files, targetDir) => { this.setActivePane(pane); this.win.onDropFiles(this, files, targetDir) }
    pane.onPreview = () => { this.setActivePane(pane); this.win.togglePreview(this) }
    pane.onDriveContextMenu = (file, w, x, y) => { this.setActivePane(pane); this.win.showDriveMenu(file, w, x, y) }
    pane.onFocused = () => this.setActivePane(pane)
    pane.isCutFile = f => this.win._cutUris.has(F.getUri(f))
    pane.onChanged = () => {
      pane.syncView()
      if (pane === this.activePane) { this.page.setTitle(locationName(pane.location)); this.win.onTabChanged(this) }
    }
    return pane
  }

  setActivePane(pane: Pane): void {
    if (pane === this.activePane) return
    this.activePane = pane
    this._updatePaneChrome()
    this.win.onTabChanged(this)
  }

  /* Highlight the active pane when split (a subtle frame), so it's obvious which
   * side keyboard/toolbar actions target. */
  _updatePaneChrome(): void {
    if (!this.isSplit) return
    for (const p of this.panes) p.widget.removeCssClass('active-pane')
    this.activePane.widget.addCssClass('active-pane')
  }

  /* ---- split ---- */
  toggleSplit(): void { this.isSplit ? this._unsplit() : this._split() }

  _split(): void {
    if (this.isSplit) return
    const start = this.activePane
    const other = this._makePane()
    this.panes = [start, other]
    /* Re-child: the surviving pane widget must be unparented from the Bin before
     * it can join the Paned. */
    this.container.setChild(null)
    this.paned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL, wideHandle: true })
    this.paned.setStartChild(start.widget)
    this.paned.setEndChild(other.widget)
    this.paned.setResizeStartChild(true)
    this.paned.setResizeEndChild(true)
    this.container.setChild(this.paned)
    /* Centre the divider once, on the first allocation (max-position notifies
     * when the paned is sized). Later resizes keep the user's chosen split. */
    let centred = false
    this.paned.on('notify::max-position', () => {
      if (centred || !this.paned) return
      const w = this.paned.getWidth()
      if (w > 1) { this.paned.setPosition(Math.floor(w / 2)); centred = true }
    })
    other.navigate(start.location!, false)
    this._updatePaneChrome()
  }

  _unsplit(): void {
    if (!this.isSplit) return
    const keep = this.activePane
    const drop = this.panes.find(p => p !== keep)!
    this.paned.setStartChild(null)
    this.paned.setEndChild(null)
    this.container.setChild(keep.widget)
    keep.widget.removeCssClass('active-pane')
    this.paned = null
    this.panes = [keep]
    drop.destroy()
    keep.syncView()
  }

  /* Move focus/active to the other pane (F6). */
  focusOtherPane(): void {
    if (!this.isSplit) return
    const other = this.panes.find(p => p !== this.activePane)
    if (other) { this.setActivePane(other); other.view.widget.grabFocus() }
  }

  destroy(): void { for (const p of this.panes) p.destroy() }
}
