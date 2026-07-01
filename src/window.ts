import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'
import Gdk from 'gi:Gdk-4.0'

import { Tab } from './tab.ts'
import { ACCELS } from './accels.ts'
import { F, fileForPath, fileForUri } from './core/gio.ts'
import { HOME, locationName, isDirectory, displayName } from './core/format.ts'
import { ClipboardService } from './services/clipboard-service.ts'
import { FileOperations } from './services/file-operations.ts'
import { UndoService } from './services/undo-service.ts'
import { ArchiveService, isArchive } from './services/archive-service.ts'
import { loadWindowState, saveWindowState } from './services/window-state.ts'
import { promptText, confirm, showProperties, aboutDialog } from './ui/dialogs.ts'
import { createSidebar } from './ui/sidebar.ts'
import { createToolbar } from './ui/toolbar.ts'
import { shortcutsDialog } from './ui/shortcuts.ts'
import { preferencesDialog } from './ui/preferences.ts'
import { batchRenameDialog } from './ui/batch-rename.ts'
import { compressDialog } from './ui/compress.ts'
import { openWithDialog } from './ui/open-with.ts'
import { buildContextMenu } from './ui/context-menu.ts'
import { fileClipboardProvider } from './ui/dnd.ts'
import type { Prefs, GFile, GFileInfo, Entry, OpError } from './core/types.ts'

const MIN_ZOOM = 32, MAX_ZOOM = 128, ZOOM_STEP = 16, DEFAULT_ZOOM = 64

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
  undo = new UndoService()
  archive = new ArchiveService()
  _pasteTarget: GFile | null = null
  _pulseTimer = 0

  window!: any
  toastOverlay!: any
  split!: any
  sidebar!: any
  toolbar!: any
  tabView!: any
  _progressBar!: any
  _progressLabel!: any
  _progressRevealer!: any
  _trashBanner!: any
  backAction!: any
  forwardAction!: any
  upAction!: any
  undoAction!: any
  redoAction!: any
  sortActions: Record<string, any> = {}
  sortDescAction!: any
  hiddenAction!: any
  searchAction!: any

  constructor(app: any, startFile: GFile) {
    this.app = app
    this._buildUI()
    this._buildActions()
    this._installShortcuts()
    this._wireFileOps()
    this.openTab(startFile)
    this.window.present()
  }

  get activeTab(): Tab | null { return this._activeTab }

  _saveState(): void {
    const maximized = this.window.isMaximized()
    const [width, height] = this.window.getDefaultSize()
    saveWindowState({ width, height, maximized })
  }

  /* Explicit shortcut controller for the win.* actions. App-level accelerators
   * (main.ts) weren't firing under node-gtk; this bubble-phase controller does,
   * while still letting a focused text entry consume Ctrl+C/V/A for its text. */
  _installShortcuts(): void {
    const controller = new Gtk.ShortcutController()
    controller.setPropagationPhase(Gtk.PropagationPhase.BUBBLE)
    for (const [action, accels] of Object.entries(ACCELS))
      for (const accel of accels) {
        const trigger = Gtk.ShortcutTrigger.parseString(accel)
        if (trigger) controller.addShortcut(new Gtk.Shortcut({ trigger, action: Gtk.NamedAction.new(action) }))
      }
    this.window.addController(controller)
  }

  /* ---- UI ---- */
  _buildUI(): void {
    this.window = new Adw.ApplicationWindow(this.app)
    this.window.setTitle('Files')
    const st = loadWindowState()
    this.window.setDefaultSize(st.width, st.height)
    if (st.maximized) this.window.maximize()
    this.window.on('close-request', () => { this._saveState(); return false })
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
      onSearchFilter: (f) => this.activeTab?.setSearchFilter(f),
      onSearchExit: () => { if (this.searching) this._setSearch(false) },
    })
    this.tabView = new Adw.TabView()
    this.tabView.on('notify::selected-page', () => this._onTabSwitched())
    this.tabView.on('close-page', (...a: any[]) => this._onClosePage(a[a.length - 1]))
    const tabBar = new Adw.TabBar({ view: this.tabView, autohide: true })

    this._trashBanner = new Adw.Banner({ title: 'Items in the Trash will be permanently deleted after 30 days', buttonLabel: 'Empty Trash', revealed: false })
    this._trashBanner.on('button-clicked', () => this._emptyTrash())

    const contentView = new Adw.ToolbarView()
    contentView.addTopBar(this.toolbar.header)
    contentView.addTopBar(tabBar)
    contentView.addTopBar(this._trashBanner)
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
    s2.append('Undo', 'win.undo')
    s2.append('Redo', 'win.redo')
    menu.appendSection(null, s2)
    const s3 = Gio.Menu.new()
    s3.append('Preferences', 'win.preferences')
    s3.append('Keyboard Shortcuts', 'win.shortcuts')
    s3.append('About Files', 'win.about')
    s3.append('Quit', 'win.quit')
    menu.appendSection(null, s3)
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
    /* Quick-op success toasts are shown by the window methods that record undo,
     * so they can attach an "Undo" button; the service's 'notify' is unused. */
    this.fileOps.on('error', ({ title, message }: OpError) => {
      this._progressRevealer.setRevealChild(false)
      this.toast(`${title} failed: ${message}`)
    })
    this.undo.on('changed', () => {
      this.undoAction.setEnabled(this.undo.canUndo)
      this.redoAction.setEnabled(this.undo.canRedo)
    })

    /* Archive ops report begin/done/error; drive the same progress bar with a
     * pulse (no byte-level progress from the CLI tools). */
    this.archive.on('begin', ({ title }: { title: string }) => this._startPulse(title))
    this.archive.on('done', ({ title }: { title: string }) => { this._stopPulse(); this.toast(`${title} — done`) })
    this.archive.on('error', ({ title, message }: OpError) => { this._stopPulse(); this.toast(`${title} failed: ${message}`) })
  }

  _startPulse(title: string): void {
    this._progressLabel.setLabel(title)
    this._progressBar.setFraction(0)
    this._progressRevealer.setRevealChild(true)
    if (this._pulseTimer) GLib.sourceRemove(this._pulseTimer)
    this._pulseTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => { this._progressBar.pulse(); return true })
  }

  _stopPulse(): void {
    if (this._pulseTimer) { GLib.sourceRemove(this._pulseTimer); this._pulseTimer = 0 }
    this._progressRevealer.setRevealChild(false)
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
    add('go-home', () => this.navigate(fileForPath(HOME)))

    add('new-tab', () => this.openTab(this.activeTab?.location ?? fileForPath(HOME)))
    add('new-window', () => new AppWindow(this.app, this.activeTab?.location ?? fileForPath(HOME)))
    add('close-tab', () => { if (this.activeTab) this.tabView.closePage(this.activeTab.page) })
    add('tab-prev', () => this.tabView.selectPreviousPage())
    add('tab-next', () => this.tabView.selectNextPage())
    add('quit', () => this.window.close())
    add('about', () => aboutDialog(this.window))
    add('shortcuts', () => shortcutsDialog().present(this.window))
    add('preferences', () => preferencesDialog(this.window, this))

    this.undoAction = add('undo', () => this.undo.undo())
    this.redoAction = add('redo', () => this.undo.redo())
    this.undoAction.setEnabled(false)
    this.redoAction.setEnabled(false)

    add('new-folder', () => this._newFolder())
    add('create-link', () => this._link())
    add('toggle-view', () => this._setViewMode(this.prefs.viewMode === 'grid' ? 'list' : 'grid'))
    add('view-grid', () => this._setViewMode('grid'))
    add('view-list', () => this._setViewMode('list'))
    add('zoom-in', () => this._zoom(ZOOM_STEP))
    add('zoom-out', () => this._zoom(-ZOOM_STEP))
    add('zoom-reset', () => this._zoom(DEFAULT_ZOOM - this.prefs.iconSize))
    add('invert-selection', () => this.activeTab?.view.invertSelection())

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
    add('open-new-tab', () => this._openNewTab())
    add('open-with', () => { const s = this._selected()[0]; if (s) openWithDialog(this.window, s.info, s.file) })
    add('open-terminal', () => this._openTerminal())
    add('set-wallpaper', () => this._setWallpaper())
    add('copy', () => this._clip(false))
    add('cut', () => this._clip(true))
    add('paste', () => this._paste())
    add('rename', () => this._renameSelected())
    add('trash', () => this._trash())
    add('delete', () => this._delete())
    add('properties', () => this._properties())
    add('empty-trash', () => this._emptyTrash())
    add('restore', () => this._restore())
    add('extract-here', () => this._extractHere())
    add('compress', () => this._compress())
  }

  _inTrash(file: GFile | null = this.activeTab?.location ?? null): boolean {
    return !!file && F.getUri(file).startsWith('trash:')
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

  _setViewMode(mode: 'grid' | 'list'): void {
    this.prefs.viewMode = mode
    this.toolbar.setViewIcon(mode)
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
    this._trashBanner.setRevealed(this._inTrash(tab.location))
  }

  /* ---- Activation + context menu ---- */
  onItemActivated(tab: Tab, info: GFileInfo, file: GFile): void {
    if (isDirectory(info)) { tab.navigate(file); return }
    try { Gio.AppInfo.launchDefaultForUri(F.getUri(file), null) }
    catch { this.toast(`Could not open “${displayName(info)}”`) }
  }

  showContextMenu(tab: Tab, widget: any, x: number, y: number, target: Entry | null): void {
    const inTrash = this._inTrash(tab.location)
    this._pasteTarget = target && isDirectory(target.info) && !inTrash ? target.file : tab.location
    const menu = buildContextMenu({ target, inTrash, clipboardEmpty: this.clipboard.isEmpty })

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
    if (!name) return
    const dir = this.activeTab.location
    const folder = this.fileOps.newFolder(dir, name)
    this.undo.push({
      undo: () => this.fileOps.trash([folder]),
      redo: () => this.fileOps.newFolder(dir, name),
      undoLabel: 'Undo Create Folder', redoLabel: 'Redo Create Folder',
    })
    this.toast(`Created “${name}”`)
  }

  _link(): void {
    const files = this._selectedFiles()
    if (!files.length || !this.activeTab) return
    const dest = this.activeTab.location
    if (!this.fileOps.link(files, dest)) return
    const links = files.map(f => F.getChild(dest, F.getBasename(f)))
    this.undo.push({
      undo: () => this.fileOps.trash(links),
      redo: () => this.fileOps.link(files, dest),
      undoLabel: 'Undo Create Link', redoLabel: 'Redo Create Link',
    })
    this.toast(files.length > 1 ? 'Links created' : 'Link created')
  }

  _openSelection(): void {
    const sel = this._selected()
    if (sel[0]) this.onItemActivated(this.activeTab!, sel[0].info, sel[0].file)
  }

  _openNewTab(): void {
    for (const s of this._selected()) if (isDirectory(s.info)) this.openTab(s.file)
  }

  _openTerminal(): void {
    const path = this.activeTab && F.getPath(this.activeTab.location)
    if (!path) return
    const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE)
    launcher.setCwd(path)
    for (const term of ['ptyxis', 'kgx', 'gnome-terminal', 'konsole', 'alacritty', 'foot', 'xterm']) {
      try { launcher.spawnv([term]); return } catch { /* not installed — try next */ }
    }
    this.toast('No terminal application found')
  }

  _setWallpaper(): void {
    const sel = this._selected()[0]
    if (!sel) return
    try {
      const settings = new Gio.Settings({ schemaId: 'org.gnome.desktop.background' })
      const uri = F.getUri(sel.file)
      settings.setString('picture-uri', uri)
      settings.setString('picture-uri-dark', uri)
      this.toast('Wallpaper set')
    } catch { this.toast('Could not set wallpaper') }
  }

  _clip(cut: boolean): void {
    const files = this._selectedFiles()
    if (!files.length) return
    this.clipboard.set(files, cut)
    try { this.window.getClipboard().setContent(fileClipboardProvider(files, cut)) } catch { /* system clipboard best-effort */ }
    this.toast(`${files.length} item${files.length > 1 ? 's' : ''} ${cut ? 'cut' : 'copied'}`)
  }

  /* Paste files copied in another app: read the system clipboard's uri-list and
   * copy them into dest (best-effort; used when the in-app clipboard is empty). */
  _pasteFromSystem(dest: GFile): void {
    try {
      const cb = this.window.getClipboard()
      cb.readTextAsync(null, (...a: any[]) => {
        let text
        try { text = cb.readTextFinish(a[1]) } catch { return }
        if (Array.isArray(text)) text = text[0]
        const files = String(text || '').split(/\r?\n/).filter(u => u.startsWith('file://')).map(u => fileForUri(u))
        if (files.length) this.fileOps.copy(files, dest)
      })
    } catch { /* no system clipboard */ }
  }

  /* Files dropped into a view. Dropping onto a folder cell (targetDir) moves
   * them into it; dropping onto the background copies them into the current
   * folder (the cross-app case). Files already in the destination are skipped. */
  onDropFiles(tab: Tab, files: GFile[], targetDir?: GFile): void {
    const dest = targetDir ?? tab.location
    const destUri = F.getUri(dest)
    const incoming = files.filter(f => { const p = F.getParent(f); return !p || F.getUri(p) !== destUri })
    if (!incoming.length) return
    if (targetDir) {
      const origParent = F.getParent(incoming[0])
      let dests = this.fileOps.move(incoming, dest)
      if (origParent) this.undo.push({
        undo: () => { dests = this.fileOps.move(dests, origParent) },
        redo: () => { dests = this.fileOps.move(incoming, dest) },
        undoLabel: 'Undo Move', redoLabel: 'Redo Move',
      })
    } else {
      const dests = this.fileOps.copy(incoming, dest)
      this.undo.push({
        undo: () => this.fileOps.trash(dests),
        redo: () => this.fileOps.copy(incoming, dest),
        undoLabel: 'Undo Copy', redoLabel: 'Redo Copy',
      })
    }
  }

  _paste(): void {
    const dest = this._pasteTarget || this.activeTab?.location
    if (!dest) return
    if (this.clipboard.isEmpty) { this._pasteFromSystem(dest); return }
    const files = this.clipboard.files.slice()
    if (this.clipboard.cut) {
      const origParent = F.getParent(files[0])
      let dests = this.fileOps.move(files, dest)
      this.clipboard.clear()
      if (origParent) this.undo.push({
        undo: () => { dests = this.fileOps.move(dests, origParent) },
        redo: () => { dests = this.fileOps.move(dests, dest) },
        undoLabel: 'Undo Move', redoLabel: 'Redo Move',
      })
    } else {
      let dests = this.fileOps.copy(files, dest)
      this.undo.push({
        undo: () => this.fileOps.trash(dests),
        redo: () => { dests = this.fileOps.copy(files, dest) },
        undoLabel: 'Undo Copy', redoLabel: 'Redo Copy',
      })
    }
  }

  /* Route Rename to single-item or batch based on selection size. */
  _renameSelected(): void {
    const sel = this._selected()
    if (sel.length > 1) this._batchRename(sel)
    else this._rename()
  }

  async _batchRename(sel: Entry[]): Promise<void> {
    const plan = await batchRenameDialog(this.window, sel)
    if (!plan || !plan.length) return
    const items = plan
      .map(p => ({ from: p.from, to: p.to, cur: this.fileOps.rename(p.file, p.to) }))
      .filter(x => x.cur)
    if (!items.length) return
    this.undo.push({
      undo: () => items.forEach(x => { const b = this.fileOps.rename(x.cur, x.from); if (b) x.cur = b }),
      redo: () => items.forEach(x => { const f = this.fileOps.rename(x.cur, x.to); if (f) x.cur = f }),
      undoLabel: 'Undo Rename', redoLabel: 'Redo Rename',
    })
    this.toast(`Renamed ${items.length} file${items.length > 1 ? 's' : ''}`)
  }

  async _rename(): Promise<void> {
    const sel = this._selected()
    if (sel.length !== 1) return
    const oldName = displayName(sel[0].info)
    const newName = await promptText(this.window, { heading: 'Rename', value: oldName, okLabel: 'Rename', selectBasename: true })
    if (!newName || newName === oldName) return
    let cur = this.fileOps.rename(sel[0].file, newName)
    if (!cur) return
    this.undo.push({
      undo: () => { const back = this.fileOps.rename(cur, oldName); if (back) cur = back },
      redo: () => { const fwd = this.fileOps.rename(cur, newName); if (fwd) cur = fwd },
      undoLabel: 'Undo Rename', redoLabel: 'Redo Rename',
    })
    this.toast(`Renamed to “${newName}”`)
  }

  _trash(): void {
    const files = this._selectedFiles()
    if (!files.length || !this.fileOps.trash(files)) return
    this.undo.push({
      undo: () => this.fileOps.restoreFromTrash(files),
      redo: () => this.fileOps.trash(files),
      undoLabel: 'Undo Move to Trash', redoLabel: 'Redo Move to Trash',
    })
    const n = files.length
    this.toast(`Moved ${n} item${n > 1 ? 's' : ''} to Trash`, { label: 'Undo', name: 'win.undo' })
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

  _extractHere(): void {
    if (!this.activeTab) return
    const dest = this.activeTab.location
    for (const s of this._selected())
      if (isArchive(displayName(s.info))) this.archive.extract(s.file, dest)
  }

  async _compress(): Promise<void> {
    const files = this._selectedFiles()
    if (!files.length || !this.activeTab) return
    const base = files.length === 1 ? F.getBasename(files[0]) : 'Archive'
    const res = await compressDialog(this.window, base)
    if (!res) return
    this.archive.compress(files, F.getChild(this.activeTab.location, res.name), res.format)
  }

  _restore(): void {
    const pairs = this._selected()
      .map(s => [s.file, s.info.getAttributeByteString('trash::orig-path')] as [GFile, string])
      .filter(p => !!p[1])
    if (pairs.length) this.fileOps.restore(pairs)
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

  toast(text: string, action?: { label: string; name: string }): void {
    const t = new Adw.Toast({ title: text })
    if (action) { t.setButtonLabel(action.label); t.setActionName(action.name) }
    this.toastOverlay.addToast(t)
  }
}
