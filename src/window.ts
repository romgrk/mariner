import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'
import Gdk from 'gi:Gdk-4.0'

import { Tab } from './tab.ts'
import { F, fileForPath, fileForUri } from './core/gio.ts'
import { HOME, locationName, isDirectory, displayName } from './core/format.ts'
import { ClipboardService } from './services/clipboard-service.ts'
import { FileOperations } from './services/file-operations.ts'
import { promptText, confirm, showProperties, aboutDialog } from './ui/dialogs.ts'
import { createSidebar } from './ui/sidebar.ts'
import { createToolbar } from './ui/toolbar.ts'
import type { Prefs, GFile, GFileInfo, Entry, OpError, OpNotify } from './core/types.ts'

const MIN_ZOOM = 32, MAX_ZOOM = 128, ZOOM_STEP = 16

function boolValue(b: boolean): any {
  const v = new GObject.Value()
  v.init(GObject.typeFromName('gboolean'))
  v.setBoolean(b)
  return v
}

export class AppWindow {
  app: any
  prefs: Prefs = { showHidden: false, sortKey: 'name', sortDesc: false, viewMode: 'grid', iconSize: 64 }
  tabs: Tab[] = []
  _activeTab: Tab | null = null
  searching = false
  clipboard = new ClipboardService()
  fileOps = new FileOperations()
  _pasteTarget: GFile | null = null

  window!: any
  toastOverlay!: any
  split!: any
  sidebar!: any
  toolbar!: any
  tabView!: any
  _progressBar!: any
  _progressLabel!: any
  _progressRevealer!: any
  backAction!: any
  forwardAction!: any
  upAction!: any
  sortActions: Record<string, any> = {}
  sortDescAction!: any
  hiddenAction!: any
  searchAction!: any

  constructor(app: any, startFile: GFile) {
    this.app = app
    this._buildUI()
    this._buildActions()
    this._wireFileOps()
    this.openTab(startFile)
    this.window.present()
  }

  get activeTab(): Tab | null { return this._activeTab }

  /* ---- UI ---- */
  _buildUI(): void {
    this.window = new Adw.ApplicationWindow(this.app)
    this.window.setTitle('Files')
    this.window.setDefaultSize(890, 550)
    this.window.addCssClass('view')

    this.toastOverlay = new Adw.ToastOverlay()
    this.split = new Adw.OverlaySplitView({ maxSidebarWidth: 240, sidebarWidthFraction: 0.2, showSidebar: true })

    /* Sidebar */
    this.sidebar = createSidebar((file: GFile) => this.navigate(file))
    const sidebarView = new Adw.ToolbarView()
    const sidebarHeader = new Adw.HeaderBar()
    sidebarHeader.setTitleWidget(new Adw.WindowTitle({ title: 'Files' }))
    sidebarHeader.packEnd(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', tooltipText: 'Main Menu', menuModel: this._appMenu() }))
    sidebarView.addTopBar(sidebarHeader)
    sidebarView.setContent(this.sidebar.widget)
    this.split.setSidebar(sidebarView)

    /* Content */
    this.toolbar = createToolbar({
      onNavigate: (file: GFile) => this.navigate(file),
      onLocationEntry: (text: string) => this.openPath(text),
      onSearchChanged: (text: string) => this.activeTab?.setSearchQuery(text),
    })
    this.tabView = new Adw.TabView()
    this.tabView.on('notify::selected-page', () => this._onTabSwitched())
    this.tabView.on('close-page', (...a: any[]) => this._onClosePage(a[a.length - 1]))
    const tabBar = new Adw.TabBar({ view: this.tabView, autohide: true })

    const contentView = new Adw.ToolbarView()
    contentView.addTopBar(this.toolbar.header)
    contentView.addTopBar(tabBar)
    contentView.setContent(this.tabView)
    contentView.addBottomBar(this._buildProgressBar())
    this.split.setContent(contentView)

    this.toastOverlay.setChild(this.split)
    this.window.setContent(this.toastOverlay)

    try {
      const bp = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 682sp') })
      bp.addSetter(this.split, 'collapsed', boolValue(true))
      this.window.addBreakpoint(bp)
    } catch { /* responsive collapse is optional */ }
  }

  _buildProgressBar(): any {
    this._progressBar = new Gtk.ProgressBar({ pulseStep: 0.1, valign: Gtk.Align.CENTER, hexpand: true })
    this._progressLabel = new Gtk.Label({ cssClasses: ['dim-label'] })
    const box = new Gtk.Box({ spacing: 12, marginTop: 4, marginBottom: 4, marginStart: 8, marginEnd: 8 })
    box.append(this._progressLabel)
    box.append(this._progressBar)
    this._progressRevealer = new Gtk.Revealer({ child: box, revealChild: false })
    return this._progressRevealer
  }

  _appMenu(): any {
    const menu = Gio.Menu.new()
    const s1 = Gio.Menu.new()
    s1.append('New Window', 'win.new-window')
    s1.append('New Tab', 'win.new-tab')
    menu.appendSection(null, s1)
    const s2 = Gio.Menu.new()
    s2.append('About Files', 'win.about')
    s2.append('Quit', 'win.quit')
    menu.appendSection(null, s2)
    return menu
  }

  /* ---- File-operation feedback ---- */
  _wireFileOps(): void {
    this.fileOps.on('begin', (p: { title: string }) => {
      this._progressLabel.setLabel(p.title)
      this._progressBar.setFraction(0)
      this._progressRevealer.setRevealChild(true)
    })
    this.fileOps.on('progress', () => this._progressBar.pulse())
    this.fileOps.on('done', () => this._progressRevealer.setRevealChild(false))
    this.fileOps.on('notify', ({ message }: OpNotify) => this.toast(message))
    this.fileOps.on('error', ({ title, message }: OpError) => {
      this._progressRevealer.setRevealChild(false)
      this.toast(`${title} failed: ${message}`)
    })
  }

  /* ---- Actions ---- */
  _buildActions(): void {
    const add = (name: string, cb: () => void): any => {
      const a = Gio.SimpleAction.new(name, null)
      a.on('activate', cb)
      this.window.addAction(a)
      return a
    }
    const addToggle = (name: string, initial: boolean, cb: (a: any) => void): any => {
      const a = Gio.SimpleAction.newStateful(name, null, GLib.Variant.newBoolean(initial))
      a.on('change-state', () => cb(a))
      this.window.addAction(a)
      return a
    }

    this.backAction = add('back', () => this.activeTab?.back())
    this.forwardAction = add('forward', () => this.activeTab?.forward())
    this.upAction = add('up', () => this.activeTab?.up())
    add('reload', () => this.activeTab?.reload())

    add('new-tab', () => this.openTab(this.activeTab?.location ?? fileForPath(HOME)))
    add('new-window', () => new AppWindow(this.app, this.activeTab?.location ?? fileForPath(HOME)))
    add('close-tab', () => { if (this.activeTab) this.tabView.closePage(this.activeTab.page) })
    add('quit', () => this.window.close())
    add('about', () => aboutDialog(this.window))

    add('new-folder', () => this._newFolder())
    add('toggle-view', () => {
      this.prefs.viewMode = this.prefs.viewMode === 'grid' ? 'list' : 'grid'
      this.toolbar.setViewIcon(this.prefs.viewMode)
      this.activeTab?.applyPrefs()
    })
    add('zoom-in', () => this._zoom(ZOOM_STEP))
    add('zoom-out', () => this._zoom(-ZOOM_STEP))

    for (const key of ['name', 'size', 'type', 'modified'] as const) {
      this.sortActions[key] = addToggle('sort-' + key, key === this.prefs.sortKey, () => {
        this.prefs.sortKey = key
        this._syncSort()
        this.activeTab?.applyPrefs()
      })
    }
    this.sortDescAction = addToggle('sort-desc', false, () => {
      this.prefs.sortDesc = !this.prefs.sortDesc
      this.sortDescAction.setState(GLib.Variant.newBoolean(this.prefs.sortDesc))
      this.activeTab?.applyPrefs()
    })
    this.hiddenAction = addToggle('show-hidden', false, () => {
      this.prefs.showHidden = !this.prefs.showHidden
      this.hiddenAction.setState(GLib.Variant.newBoolean(this.prefs.showHidden))
      this.activeTab?.applyPrefs()
    })

    add('location', () => this._showLocationEntry())
    this.searchAction = addToggle('search', false, () => this._toggleSearch())
    this.toolbar.searchButton.setActionName('win.search')

    add('select-all', () => this.activeTab?.view.selectAll())
    add('open', () => this._openSelection())
    add('copy', () => this._clip(false))
    add('cut', () => this._clip(true))
    add('paste', () => this._paste())
    add('rename', () => this._rename())
    add('trash', () => this._trash())
    add('delete', () => this._delete())
    add('properties', () => this._properties())
    add('empty-trash', () => this._emptyTrash())
  }

  _syncSort(): void {
    for (const [key, a] of Object.entries(this.sortActions))
      a.setState(GLib.Variant.newBoolean(key === this.prefs.sortKey))
  }

  _zoom(delta: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.prefs.iconSize + delta))
    if (next === this.prefs.iconSize) return
    this.prefs.iconSize = next
    this.activeTab?.applyPrefs()
  }

  /* ---- Tabs / navigation ---- */
  openTab(file: GFile): Tab {
    const tab = new Tab(this, file)
    this.tabs.push(tab)
    this._activeTab = tab
    this.tabView.setSelectedPage(tab.page)
    this.refreshChrome(tab)
    return tab
  }

  navigate(file: GFile): void { this.activeTab?.navigate(file) }

  openPath(text: string): void {
    text = text.trim()
    if (!text) return
    let file: GFile
    if (text.startsWith('~')) file = fileForPath(HOME + text.slice(1))
    else if (/^[a-z]+:\/\//i.test(text)) file = fileForUri(text)
    else if (text.startsWith('/')) file = fileForPath(text)
    else file = F.getChild(this.activeTab!.location, text)

    if (F.queryExists(file, null)) { this.toolbar.showStack('pathbar'); this.navigate(file) }
    else this.toast('Location not found')
  }

  _onTabSwitched(): void {
    const page = this.tabView.getSelectedPage()
    if (!page) return
    const tab = this.tabs.find(t => t.page === page)
    if (!tab) return
    this._activeTab = tab
    if (this.searching) this._setSearch(false)
    this.refreshChrome(tab)
  }

  _onClosePage(page: any): boolean {
    const tab = this.tabs.find(t => t.page === page)
    if (tab) { tab.destroy(); this.tabs = this.tabs.filter(t => t !== tab) }
    this.tabView.closePageFinish(page, true)
    if (this.tabView.getNPages() === 0) this.window.close()
    return true
  }

  onTabChanged(tab: Tab): void { if (tab === this._activeTab) this.refreshChrome(tab) }

  refreshChrome(tab: Tab): void {
    this.toolbar.pathbar.setLocation(tab.location)
    this.toolbar.locationEntry.setText(F.getPath(tab.location) || F.getUri(tab.location))
    this.toolbar.setViewIcon(this.prefs.viewMode)
    this.window.setTitle(locationName(tab.location))
    this.backAction.setEnabled(tab.canGoBack)
    this.forwardAction.setEnabled(tab.canGoForward)
    this.upAction.setEnabled(!!tab.parent)
    this.sidebar.setActive(tab.location)
  }

  /* ---- Activation + context menu ---- */
  onItemActivated(tab: Tab, info: GFileInfo, file: GFile): void {
    if (isDirectory(info)) { tab.navigate(file); return }
    try { Gio.AppInfo.launchDefaultForUri(F.getUri(file), null) }
    catch { this.toast(`Could not open “${displayName(info)}”`) }
  }

  showContextMenu(tab: Tab, widget: any, x: number, y: number, target: Entry | null): void {
    const menu = Gio.Menu.new()
    if (target) {
      const s1 = Gio.Menu.new(); s1.append('Open', 'win.open'); menu.appendSection(null, s1)
      const s2 = Gio.Menu.new()
      s2.append('Cut', 'win.cut'); s2.append('Copy', 'win.copy')
      if (isDirectory(target.info) && !this.clipboard.isEmpty) s2.append('Paste Into Folder', 'win.paste')
      menu.appendSection(null, s2)
      const s3 = Gio.Menu.new()
      s3.append('Rename…', 'win.rename'); s3.append('Move to Trash', 'win.trash'); s3.append('Delete Permanently', 'win.delete')
      menu.appendSection(null, s3)
      const s4 = Gio.Menu.new(); s4.append('Properties', 'win.properties'); menu.appendSection(null, s4)
      this._pasteTarget = isDirectory(target.info) ? target.file : tab.location
    } else {
      const s1 = Gio.Menu.new(); s1.append('New Folder…', 'win.new-folder'); menu.appendSection(null, s1)
      const s2 = Gio.Menu.new()
      if (!this.clipboard.isEmpty) s2.append('Paste', 'win.paste')
      s2.append('Select All', 'win.select-all')
      menu.appendSection(null, s2)
      this._pasteTarget = tab.location
    }

    const pop = Gtk.PopoverMenu.newFromModel(menu)
    pop.setParent(widget)
    pop.setHasArrow(false)
    try {
      const r = new Gdk.Rectangle()
      r.x = Math.round(x); r.y = Math.round(y); r.width = 1; r.height = 1
      pop.setPointingTo(r)
    } catch {}
    pop.on('closed', () => pop.unparent())
    pop.popup()
  }

  /* ---- Operations ---- */
  _selected(): Entry[] { return this.activeTab ? this.activeTab.view.getSelected() : [] }
  _selectedFiles(): GFile[] { return this._selected().map(s => s.file) }

  async _newFolder(): Promise<void> {
    if (!this.activeTab) return
    const name = await promptText(this.window, { heading: 'New Folder', value: 'New Folder', okLabel: 'Create', selectBasename: true })
    if (name) this.fileOps.newFolder(this.activeTab.location, name)
  }

  _openSelection(): void {
    const sel = this._selected()
    if (sel[0]) this.onItemActivated(this.activeTab!, sel[0].info, sel[0].file)
  }

  _clip(cut: boolean): void {
    const files = this._selectedFiles()
    if (!files.length) return
    this.clipboard.set(files, cut)
    this.toast(`${files.length} item${files.length > 1 ? 's' : ''} ${cut ? 'cut' : 'copied'}`)
  }

  _paste(): void {
    const dest = this._pasteTarget || this.activeTab?.location
    if (!dest || this.clipboard.isEmpty) return
    if (this.clipboard.cut) { this.fileOps.move(this.clipboard.files, dest); this.clipboard.clear() }
    else this.fileOps.copy(this.clipboard.files, dest)
  }

  async _rename(): Promise<void> {
    const sel = this._selected()
    if (sel.length !== 1) return
    const current = displayName(sel[0].info)
    const name = await promptText(this.window, { heading: 'Rename', value: current, okLabel: 'Rename', selectBasename: true })
    if (name && name !== current) this.fileOps.rename(sel[0].file, name)
  }

  _trash(): void {
    const files = this._selectedFiles()
    if (files.length) this.fileOps.trash(files)
  }

  async _delete(): Promise<void> {
    const files = this._selectedFiles()
    if (!files.length) return
    const ok = await confirm(this.window, {
      heading: `Permanently delete ${files.length} item${files.length > 1 ? 's' : ''}?`,
      body: 'This action cannot be undone.', okLabel: 'Delete',
    })
    if (ok) this.fileOps.deletePermanently(files)
  }

  _properties(): void {
    const sel = this._selected()
    if (sel[0]) showProperties(this.window, sel[0].info, sel[0].file)
  }

  async _emptyTrash(): Promise<void> {
    const ok = await confirm(this.window, {
      heading: 'Empty all items from Trash?', body: 'All items will be permanently deleted.', okLabel: 'Empty Trash',
    })
    if (ok) this.fileOps.emptyTrash()
  }

  /* ---- Search / location ---- */
  _showLocationEntry(): void {
    this.toolbar.showStack('location')
    this.toolbar.locationEntry.grabFocus()
    this.toolbar.locationEntry.selectRegion(0, -1)
  }

  _toggleSearch(): void { this._setSearch(!this.searching) }

  _setSearch(on: boolean): void {
    this.searching = on
    this.searchAction.setState(GLib.Variant.newBoolean(on))
    if (on) {
      this.toolbar.showStack('search')
      this.toolbar.searchEntry.grabFocus()
      this.activeTab?.beginSearch()
    } else {
      this.toolbar.showStack('pathbar')
      this.toolbar.searchEntry.setText('')
      this.activeTab?.endSearch()
    }
  }

  toast(text: string): void { this.toastOverlay.addToast(new Adw.Toast({ title: text })) }
}
