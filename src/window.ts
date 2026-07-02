import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'
import Gdk from 'gi:Gdk-4.0'

import { Tab } from './tab.ts'
import { ACCELS, accelHint } from './accels.ts'
import { fileForPath, fileForUri, ATTRS } from './core/gio.ts'
import { HOME, locationName, isDirectory, displayName, tildePath } from './core/format.ts'
import { recentFolders } from './services/recent-folders.ts'
import { ClipboardService } from './services/clipboard-service.ts'
import { FileOperations, uniqueChild } from './services/file-operations.ts'
import { UndoService } from './services/undo-service.ts'
import { ArchiveService, isArchive } from './services/archive-service.ts'
import { archiveRootFile } from './core/archive-uri.ts'
import { loadWindowState, saveWindowState } from './services/window-state.ts'
import { promptText, confirm, chooseFolder, showProperties, aboutDialog } from './ui/dialogs.ts'
import { createSidebar } from './ui/sidebar.ts'
import { addBookmark, removeBookmark, isBookmarked } from './services/places-service.ts'
import { createToolbar } from './ui/toolbar.ts'
import { shortcutsDialog } from './ui/shortcuts.ts'
import { preferencesDialog } from './ui/preferences.ts'
import { batchRenameDialog } from './ui/batch-rename.ts'
import { compressDialog } from './ui/compress.ts'
import { openWithDialog } from './ui/open-with.ts'
import { buildContextMenu } from './ui/context-menu.ts'
import { columnChooserDialog } from './ui/column-chooser.ts'
import { loadViewPrefs, saveViewPrefs } from './services/view-prefs.ts'
import { QuickLook } from './ui/preview.ts'
import { OperationsQueue } from './ui/operations-queue.ts'
import { resolveConflicts, partitionConflicts } from './ui/conflict-dialog.ts'
import { fileClipboardProvider } from './ui/dnd.ts'
import { CommandPalette } from './ui/command-palette.ts'
import type { PaletteItem } from './ui/command-palette.ts'
import type { Prefs, GFile, GFileInfo, Entry, CopyItem, OpError } from './core/types.ts'

const MIN_ZOOM = 32, MAX_ZOOM = 128, ZOOM_STEP = 16, DEFAULT_ZOOM = 64

function boolValue(b: boolean): any {
  const v = new GObject.Value()
  v.init(GObject.typeFromName('gboolean'))
  v.setBoolean(b)
  return v
}

export class AppWindow {
  app: any
  prefs: Prefs = { showHidden: false, sortKey: 'name', sortDesc: false, iconSize: 64, ...loadViewPrefs() }
  tabs: Tab[] = []
  _activeTab: Tab | null = null
  searching = false
  clipboard = new ClipboardService()
  fileOps = new FileOperations()
  undo = new UndoService()
  archive = new ArchiveService()
  opsQueue = new OperationsQueue()
  _pasteTarget: GFile | null = null
  _ctxFile: GFile | null = null
  _cutUris = new Set<string>()
  _quicklook: QuickLook | null = null
  _palette: CommandPalette | null = null
  _actions: Record<string, any> = {}

  window!: any
  toastOverlay!: any
  split!: any
  sidebar!: any
  toolbar!: any
  tabView!: any
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
    this.window = new Adw.ApplicationWindow({ application: this.app })
    this.window.setTitle('Mariner')
    const st = loadWindowState()
    this.window.setDefaultSize(st.width, st.height)
    if (st.maximized) this.window.maximize()
    this.window.on('close-request', () => {
      this._saveState()
      /* When the last window closes, exit the process: node-gtk keeps it alive
       * even after the GTK loop winds down, so an explicit exit is needed. */
      if (this.app.getWindows().length <= 1) process.exit(0)
      return false
    })
    this.window.addCssClass('view')

    this.toastOverlay = new Adw.ToastOverlay()
    this.split = new Adw.OverlaySplitView({ maxSidebarWidth: 240, sidebarWidthFraction: 0.2, showSidebar: true })

    /* Sidebar */
    this.sidebar = createSidebar(
      (file: GFile) => this.navigate(file),
      (file: GFile, widget: any, x: number, y: number) => this.showBookmarkMenu(file, widget, x, y),
    )
    const sidebarView = new Adw.ToolbarView()
    const sidebarHeader = new Adw.HeaderBar()
    sidebarHeader.setTitleWidget(new Adw.WindowTitle({ title: 'Mariner' }))
    sidebarHeader.packEnd(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', tooltipText: 'Main Menu', menuModel: this._appMenu() }))
    sidebarView.addTopBar(sidebarHeader)
    sidebarView.setContent(this.sidebar.widget)
    this.split.setSidebar(sidebarView)

    /* Content */
    this.toolbar = createToolbar({
      onNavigate: (file: GFile) => this.navigate(file),
      onOpenTab: (file: GFile) => this.openTab(file),
      onOpenWindow: (file: GFile) => new AppWindow(this.app, file),
      onProperties: (file: GFile) => this._propertiesFor(file),
      onLocationEntry: (text: string) => this.openPath(text),
      onLocationExit: () => { this.toolbar.showStack('pathbar'); this.activeTab?.view.widget.grabFocus() },
      onSearchChanged: (text: string) => this.activeTab?.setSearchQuery(text),
      onSearchFilter: (f) => this.activeTab?.setSearchFilter(f),
      onSearchExit: () => { if (this.searching) this._setSearch(false) },
      onSearchActivate: () => this.activeTab?.view.widget.grabFocus(),
    })
    this.toolbar.packTrailing(this.opsQueue.button)
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
    this.split.setContent(contentView)

    this.toastOverlay.setChild(this.split)
    this.window.setContent(this.toastOverlay)

    try {
      const bp = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 682sp') })
      bp.addSetter(this.split, 'collapsed', boolValue(true))
      this.window.addBreakpoint(bp)
    } catch { /* responsive collapse is optional */ }
  }

  _appMenu(): any {
    const menu = Gio.Menu.new()
    const s1 = Gio.Menu.new()
    s1.append('Command Palette', 'win.command-palette')
    s1.append('New Window', 'win.new-window')
    s1.append('New Tab', 'win.new-tab')
    s1.append('Split View', 'win.toggle-split')
    s1.append('Add to Bookmarks', 'win.add-bookmark')
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
    /* Long ops show per-op progress + cancel in the header operations queue. */
    this.opsQueue.bind(this.fileOps, 'f', (id: number) => this.fileOps.cancel(id))
    this.opsQueue.bind(this.archive, 'a')

    /* Quick-op success toasts are shown by the window methods that record undo,
     * so they can attach an "Undo" button; the service's 'notify' is unused. */
    this.fileOps.on('error', ({ title, message }: OpError) => this.toast(`${title} failed: ${message}`))
    this.undo.on('changed', () => {
      this.undoAction.setEnabled(this.undo.canUndo)
      this.redoAction.setEnabled(this.undo.canRedo)
    })

    /* Track cut files so the view can dim them until pasted. */
    this.clipboard.on('changed', () => {
      this._cutUris = new Set(this.clipboard.cut ? this.clipboard.files.map(f => f.getUri()) : [])
      for (const p of this.activeTab?.panes ?? []) p.view.refreshCells()
    })

    /* Archive ops also flow through the queue (indeterminate); toast on finish. */
    this.archive.on('done', ({ title }: { title: string }) => this.toast(`${title} — done`))
    this.archive.on('error', ({ title, message }: OpError) => this.toast(`${title} failed: ${message}`))
  }

  /* ---- Actions ---- */
  _buildActions(): void {
    const add = (name: string, cb: () => void): any => {
      const a = Gio.SimpleAction.new(name, null)
      a.on('activate', cb)
      this.window.addAction(a)
      this._actions[name] = a
      return a
    }
    const addToggle = (name: string, initial: boolean, cb: (a: any) => void): any => {
      const a = Gio.SimpleAction.newStateful(name, null, GLib.Variant.newBoolean(initial))
      a.on('change-state', () => cb(a))
      this.window.addAction(a)
      this._actions[name] = a
      return a
    }

    this.backAction = add('back', () => this.activeTab?.back())
    this.forwardAction = add('forward', () => this.activeTab?.forward())
    this.upAction = add('up', () => this.activeTab?.up())
    add('reload', () => this.activeTab?.reload())
    add('go-home', () => this.navigate(fileForPath(HOME)))

    add('new-tab', () => this.openTab(this.activeTab?.location ?? fileForPath(HOME)))
    add('new-window', () => new AppWindow(this.app, this.activeTab?.location ?? fileForPath(HOME)))
    add('toggle-split', () => this.activeTab?.toggleSplit())
    add('focus-other-pane', () => this.activeTab?.focusOtherPane())
    add('command-palette', () => this._openPalette())
    add('copy-to-other-pane', () => this._copyToOtherPane(false))
    add('move-to-other-pane', () => this._copyToOtherPane(true))
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
    add('choose-columns', () => this._chooseColumns())
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
    add('select-pattern', () => this._selectPattern())
    add('preview', () => { if (this.activeTab) this.togglePreview(this.activeTab) })
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
    add('restore-to', () => this._restoreTo())
    add('extract-here', () => this._extractHere())
    add('compress', () => this._compress())
    add('disk-usage', () => this._diskUsage())

    /* Computer-view drive menu — these act on `_ctxFile` (the drive's mount
     * point), set when the menu is opened, since that view has no selection. */
    add('drive-open', () => { if (this._ctxFile) this.navigate(this._ctxFile) })
    add('drive-open-tab', () => { if (this._ctxFile) this.openTab(this._ctxFile) })
    add('drive-usage', () => { if (this._ctxFile) this._propertiesFor(this._ctxFile, { expandUsage: true }) })
    add('drive-properties', () => { if (this._ctxFile) this._propertiesFor(this._ctxFile) })

    /* Bookmarks. add-bookmark (menu/keyboard) targets the current folder;
     * ctx-add-bookmark and the open/remove entries act on `_ctxFile`, which the
     * file-view and sidebar context menus set to the folder under the cursor. */
    add('add-bookmark', () => this._addBookmark(this.activeTab?.location ?? null))
    add('ctx-add-bookmark', () => this._addBookmark(this._ctxFile))
    add('bookmark-open', () => { if (this._ctxFile) this.navigate(this._ctxFile) })
    add('bookmark-open-tab', () => { if (this._ctxFile) this.openTab(this._ctxFile) })
    add('remove-bookmark', () => this._removeBookmark(this._ctxFile))
  }

  /* Analyze disk usage of the selected folder (or the current location): opens
   * Properties with the "Disk Usage" chart pre-expanded. Local paths only. */
  _diskUsage(): void {
    const sel = this._selected()[0]
    if (sel && isDirectory(sel.info)) { showProperties(this.window, sel.info, sel.file, { expandUsage: true }); return }
    const loc = this.activeTab?.location
    if (loc && loc.getPath()) { this._propertiesFor(loc, { expandUsage: true }); return }
    this.toast('Disk usage is only available for local folders')
  }

  /* ---- Command palette ---- */
  _activate(name: string): void { this._actions[name]?.activate(null) }

  _openPalette(): void {
    if (!this._palette) this._palette = new CommandPalette(this.window)
    this._palette.open(this._paletteItems())
  }

  /* The inactive pane when split (destination for the dual-pane copy/move). */
  _otherPane(): any {
    const tab = this.activeTab
    if (!tab || !tab.isSplit) return null
    return tab.panes.find((p: any) => p !== tab.activePane) ?? null
  }

  /* Copy/move the selection into the other pane's folder (mirrors _paste). */
  async _copyToOtherPane(move: boolean): Promise<void> {
    const other = this._otherPane()
    const files = this._selectedFiles()
    if (!other?.location || !files.length) return
    const dest = other.location
    const plan = await this._resolvePlan(files, dest, move)
    if (!plan || !plan.length) return
    if (move) {
      const origParent = files[0].getParent()
      let dests = this.fileOps.moveItems(plan)
      if (origParent) this.undo.push({
        undo: () => { dests = this.fileOps.move(dests, origParent) },
        redo: () => { dests = this.fileOps.moveItems(plan) },
        undoLabel: 'Undo Move', redoLabel: 'Redo Move',
      })
    } else {
      let dests = this.fileOps.copyItems(plan)
      this.undo.push({
        undo: () => this.fileOps.trash(dests),
        redo: () => { dests = this.fileOps.copyItems(plan) },
        undoLabel: 'Undo Copy', redoLabel: 'Redo Copy',
      })
    }
  }

  /* Build the palette's item list for the current context. `primary` items show
   * on an empty query — the selection's context actions (mirroring the context
   * menu) + dual-pane targets + recent folders (frecency-ranked). A broader
   * catalog of global commands is appended for typed queries. Every action runs
   * through its existing win.* GAction; folders navigate the active pane. */
  _paletteItems(): PaletteItem[] {
    const items: PaletteItem[] = []
    const added = new Set<string>()
    const act = (label: string, name: string, opts: { icon?: string; primary?: boolean } = {}): void => {
      if (added.has(name)) return
      added.add(name)
      items.push({
        label, group: 'action', search: label, icon: opts.icon, primary: !!opts.primary,
        detail: accelHint('win.' + name),
        run: () => this._activate(name),
      })
    }

    const sel = this._selected()
    const target = sel[0] ?? null
    const inTrash = this._inTrash()
    const clipEmpty = this.clipboard.isEmpty
    const tab = this.activeTab

    /* Context actions (primary) — same branching as buildContextMenu. */
    if (target && inTrash) {
      act('Restore From Trash', 'restore', { icon: 'edit-undo-symbolic', primary: true })
      act('Restore to…', 'restore-to', { icon: 'folder-symbolic', primary: true })
      act('Delete Permanently', 'delete', { icon: 'edit-delete-symbolic', primary: true })
      act('Properties', 'properties', { icon: 'document-properties-symbolic', primary: true })
    } else if (target) {
      const isDir = isDirectory(target.info)
      const isImage = (target.info.getContentType() || '').startsWith('image/')
      act('Open', 'open', { icon: 'document-open-symbolic', primary: true })
      if (isDir) act('Open in New Tab', 'open-new-tab', { icon: 'tab-new-symbolic', primary: true })
      else act('Open With…', 'open-with', { icon: 'emblem-system-symbolic', primary: true })
      act('Preview', 'preview', { icon: 'view-reveal-symbolic', primary: true })
      act('Cut', 'cut', { icon: 'edit-cut-symbolic', primary: true })
      act('Copy', 'copy', { icon: 'edit-copy-symbolic', primary: true })
      if (isDir && !clipEmpty) act('Paste Into Folder', 'paste', { icon: 'edit-paste-symbolic', primary: true })
      act('Rename…', 'rename', { icon: 'document-edit-symbolic', primary: true })
      act('Create Link', 'create-link', { icon: 'insert-link-symbolic', primary: true })
      act('Move to Trash', 'trash', { icon: 'user-trash-symbolic', primary: true })
      act('Delete Permanently', 'delete', { icon: 'edit-delete-symbolic', primary: true })
      if (isArchive(displayName(target.info))) act('Extract Here', 'extract-here', { icon: 'archive-extract-symbolic', primary: true })
      act('Compress…', 'compress', { icon: 'package-x-generic-symbolic', primary: true })
      if (isImage) act('Set as Wallpaper', 'set-wallpaper', { icon: 'preferences-desktop-wallpaper-symbolic', primary: true })
      if (isDir) act('Analyze Disk Usage', 'disk-usage', { icon: 'drive-harddisk-symbolic', primary: true })
      act('Properties', 'properties', { icon: 'document-properties-symbolic', primary: true })
    } else if (inTrash) {
      act('Empty Trash', 'empty-trash', { icon: 'user-trash-full-symbolic', primary: true })
      act('Select All', 'select-all', { icon: 'edit-select-all-symbolic', primary: true })
    } else {
      act('New Folder…', 'new-folder', { icon: 'folder-new-symbolic', primary: true })
      if (!clipEmpty) act('Paste', 'paste', { icon: 'edit-paste-symbolic', primary: true })
      act('Select All', 'select-all', { icon: 'edit-select-all-symbolic', primary: true })
      act('Open in Terminal', 'open-terminal', { icon: 'utilities-terminal-symbolic', primary: true })
      act('Analyze Disk Usage', 'disk-usage', { icon: 'drive-harddisk-symbolic', primary: true })
    }

    /* Bookmark the selected folder — or the current folder if none is selected —
     * toggling to "Remove Bookmark" when it's already bookmarked. */
    const bmFile = target && isDirectory(target.info) ? target.file : tab?.location ?? null
    if (bmFile && !inTrash && bmFile.getUri().startsWith('file://')) {
      if (isBookmarked(bmFile))
        items.push({ label: 'Remove Bookmark', group: 'action', search: 'Remove Bookmark', icon: 'user-bookmarks-symbolic', primary: true, run: () => this._removeBookmark(bmFile) })
      else
        items.push({ label: 'Add Bookmark', group: 'action', search: 'Add Bookmark', icon: 'bookmark-new-symbolic', primary: true, detail: accelHint('win.add-bookmark'), run: () => this._addBookmark(bmFile) })
    }

    /* Dual-pane targets (primary when split + selection). The search text carries
     * a "split pane" alias so a query for "split" surfaces them too. */
    if (tab?.isSplit && sel.length) {
      items.push({ label: 'Copy to Other Pane', group: 'action', search: 'Copy to Other Pane split', icon: 'edit-copy-symbolic', primary: true, detail: accelHint('win.copy-to-other-pane'), run: () => this._activate('copy-to-other-pane') })
      items.push({ label: 'Move to Other Pane', group: 'action', search: 'Move to Other Pane split', icon: 'go-next-symbolic', primary: true, detail: accelHint('win.move-to-other-pane'), run: () => this._activate('move-to-other-pane') })
    }

    /* Recent folders (primary), most-frecent first, excluding the current one. */
    const curUri = tab?.location ? tab.location.getUri() : undefined
    const recents = recentFolders(curUri)
    const maxScore = recents[0]?.score || 1
    for (const r of recents) {
      const file = fileForUri(r.uri)
      const label = locationName(file)
      const detail = tildePath(file)
      items.push({
        label, detail, group: 'folder', icon: 'folder-symbolic', primary: true,
        search: `${label} ${detail}`,
        frecencyBonus: (r.score / maxScore) * 0.25,
        run: () => this.navigate(file),
      })
    }

    /* Global commands (query-only) — the buried actions a palette surfaces. */
    act('New Tab', 'new-tab', { icon: 'tab-new-symbolic' })
    act('New Window', 'new-window', { icon: 'window-new-symbolic' })
    act('Reload', 'reload', { icon: 'view-refresh-symbolic' })
    act('Toggle Split View', 'toggle-split', { icon: 'view-dual-symbolic' })
    if (tab?.isSplit) act('Focus Other Pane', 'focus-other-pane', { icon: 'go-next-symbolic' })
    act('Search', 'search', { icon: 'system-search-symbolic' })
    act('Enter Location', 'location', { icon: 'go-jump-symbolic' })
    act('Go Home', 'go-home', { icon: 'go-home-symbolic' })
    act('Go Up', 'up', { icon: 'go-up-symbolic' })
    act('Back', 'back', { icon: 'go-previous-symbolic' })
    act('Forward', 'forward', { icon: 'go-next-symbolic' })
    act('Select All', 'select-all', { icon: 'edit-select-all-symbolic' })
    act('Select Items Matching…', 'select-pattern', { icon: 'edit-find-symbolic' })
    act('Invert Selection', 'invert-selection', { icon: 'edit-select-all-symbolic' })
    act('Show Hidden Files', 'show-hidden', { icon: 'view-reveal-symbolic' })
    act('Sort by Name', 'sort-name', { icon: 'view-sort-ascending-symbolic' })
    act('Sort by Size', 'sort-size', { icon: 'view-sort-ascending-symbolic' })
    act('Sort by Type', 'sort-type', { icon: 'view-sort-ascending-symbolic' })
    act('Sort by Modified', 'sort-modified', { icon: 'view-sort-ascending-symbolic' })
    act('Reverse Sort Order', 'sort-desc', { icon: 'view-sort-descending-symbolic' })
    act('List View', 'view-list', { icon: 'view-list-symbolic' })
    act('Grid View', 'view-grid', { icon: 'view-grid-symbolic' })
    act('Zoom In', 'zoom-in', { icon: 'zoom-in-symbolic' })
    act('Zoom Out', 'zoom-out', { icon: 'zoom-out-symbolic' })
    act('Reset Zoom', 'zoom-reset', { icon: 'zoom-original-symbolic' })
    act('New Folder…', 'new-folder', { icon: 'folder-new-symbolic' })
    act('Create Link', 'create-link', { icon: 'insert-link-symbolic' })
    act('Open in Terminal', 'open-terminal', { icon: 'utilities-terminal-symbolic' })
    act('Analyze Disk Usage', 'disk-usage', { icon: 'drive-harddisk-symbolic' })
    if (inTrash) act('Empty Trash', 'empty-trash', { icon: 'user-trash-full-symbolic' })
    act('Preferences', 'preferences', { icon: 'preferences-system-symbolic' })
    act('Keyboard Shortcuts', 'shortcuts', { icon: 'preferences-desktop-keyboard-symbolic' })
    act('About Files', 'about', { icon: 'help-about-symbolic' })

    return items
  }

  _inTrash(file: GFile | null = this.activeTab?.location ?? null): boolean {
    return !!file && file.getUri().startsWith('trash:')
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
    saveViewPrefs(this.prefs)
  }

  /* Open the "Visible Columns" chooser. Switches to the list view first so the
   * edits are visible as they apply (columns only affect the list). */
  _chooseColumns(): void {
    if (this.prefs.viewMode !== 'list') this._setViewMode('list')
    columnChooserDialog(this.window, this.prefs.columns, columns => {
      this.prefs.columns = columns
      this.activeTab?.applyColumns()
      saveViewPrefs(this.prefs)
    })
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
    else file = this.activeTab!.location.getChild(text)

    if (file.queryExists(null)) { this.toolbar.showStack('pathbar'); this.navigate(file) }
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

  /* Toggle Quick Look for the active pane: page through the entries the view is
   * showing, starting at the selection; keep the view's selection in sync. */
  togglePreview(tab: Tab): void {
    const view = tab.view
    const entries = view.entries()
    if (!entries.length) return
    if (!this._quicklook) this._quicklook = new QuickLook(this.window)
    this._quicklook.toggle(entries, view.selectedIndex(), i => view.selectIndex(i))
  }

  refreshChrome(tab: Tab): void {
    /* Navigating away (breadcrumb, sidebar, back/forward, opening a folder, …)
     * exits search: the pane already dropped its search on navigate, so here we
     * just tear down the search chrome. endSearch() is then a no-op, so the new
     * location that navigation just loaded is left intact. */
    if (this.searching && !tab.searching) this._setSearch(false)
    this.toolbar.pathbar.setLocation(tab.location)
    this.toolbar.locationEntry.setText(tab.location.getPath() || tab.location.getUri())
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
    /* Browse archives in place as a virtual folder (gvfs archive://), reusing
     * the normal view — no extraction. "Open With…" still launches a manager. */
    if (isArchive(displayName(info))) { tab.navigate(archiveRootFile(file)); return }
    try { Gio.AppInfo.launchDefaultForUri(file.getUri(), null) }
    catch { this.toast(`Could not open “${displayName(info)}”`) }
  }

  showContextMenu(tab: Tab, widget: any, x: number, y: number, target: Entry | null): void {
    const inTrash = this._inTrash(tab.location)
    this._pasteTarget = target && isDirectory(target.info) && !inTrash ? target.file : tab.location
    /* The bookmark entry acts on the folder under the cursor (`_ctxFile`); only
     * real folders outside the Trash can be bookmarked. */
    const bmFile = target && isDirectory(target.info) && !inTrash ? target.file : null
    this._ctxFile = bmFile
    const bookmark: 'add' | 'remove' | null = bmFile && bmFile.getUri().startsWith('file://')
      ? (isBookmarked(bmFile) ? 'remove' : 'add') : null
    this._popupMenu(buildContextMenu({ target, inTrash, clipboardEmpty: this.clipboard.isEmpty, isSplit: tab.isSplit, bookmark }), widget, x, y)
  }

  /* Context menu for a drive/partition row in the Computer view. Its actions
   * target `_ctxFile` (the drive's mount point), not a file-view selection. */
  showDriveMenu(file: GFile, widget: any, x: number, y: number): void {
    this._ctxFile = file
    const menu = Gio.Menu.new()
    const open = Gio.Menu.new()
    open.append('Open', 'win.drive-open')
    open.append('Open in New Tab', 'win.drive-open-tab')
    menu.appendSection(null, open)
    const info = Gio.Menu.new()
    info.append('Analyze Disk Usage', 'win.drive-usage')
    info.append('Properties', 'win.drive-properties')
    menu.appendSection(null, info)
    this._popupMenu(menu, widget, x, y)
  }

  /* Context menu for a bookmark row in the sidebar. Its actions target
   * `_ctxFile` (the bookmarked folder), set when the menu is opened. */
  showBookmarkMenu(file: GFile, widget: any, x: number, y: number): void {
    this._ctxFile = file
    const menu = Gio.Menu.new()
    const open = Gio.Menu.new()
    open.append('Open', 'win.bookmark-open')
    open.append('Open in New Tab', 'win.bookmark-open-tab')
    menu.appendSection(null, open)
    const edit = Gio.Menu.new()
    edit.append('Remove From Sidebar', 'win.remove-bookmark')
    menu.appendSection(null, edit)
    this._popupMenu(menu, widget, x, y)
  }

  _popupMenu(menu: any, widget: any, x: number, y: number): void {
    const pop = Gtk.PopoverMenu.newFromModel(menu)
    pop.setParent(widget)
    pop.setHasArrow(false)
    try {
      const r = new Gdk.Rectangle()
      r.x = Math.round(x); r.y = Math.round(y); r.width = 1; r.height = 1
      pop.setPointingTo(r)
    } catch {}
    /* Defer unparent: GtkPopoverMenu activates the chosen item's action *after*
     * it closes, so detaching synchronously here would strand the action group
     * and the action would never fire. */
    pop.on('closed', () => GLib.timeoutAdd(GLib.PRIORITY_DEFAULT_IDLE, 100, () => { try { pop.unparent() } catch {} return false }))
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
    const links = files.map(f => dest.getChild(f.getBasename()))
    this.undo.push({
      undo: () => this.fileOps.trash(links),
      redo: () => this.fileOps.link(files, dest),
      undoLabel: 'Undo Create Link', redoLabel: 'Redo Create Link',
    })
    this.toast(files.length > 1 ? 'Links created' : 'Link created')
  }

  /* ---- Bookmarks ---- */
  /* Bookmark `file`. Only real folders are bookmarkable — the virtual places
   * (Recent, Trash, Computer) already have their own permanent sidebar entries. */
  _addBookmark(file: GFile | null): void {
    if (!file) return
    if (!file.getUri().startsWith('file://')) { this.toast('Only folders can be bookmarked'); return }
    if (isBookmarked(file)) { this.toast(`“${locationName(file)}” is already bookmarked`); return }
    if (!addBookmark(file)) { this.toast('Could not save bookmark'); return }
    this.sidebar.refresh()
    this.sidebar.setActive(this.activeTab?.location ?? file)
    this.toast(`Bookmarked “${locationName(file)}”`)
  }

  _removeBookmark(file: GFile | null): void {
    if (!file || !removeBookmark(file)) return
    this.sidebar.refresh()
    this.sidebar.setActive(this.activeTab?.location ?? file)
    this.toast(`Removed “${locationName(file)}” from the sidebar`)
  }

  /* Select every item in the current folder whose name matches a shell glob
   * (nautilus's "Select Items Matching", Ctrl+S). */
  async _selectPattern(): Promise<void> {
    const view = this.activeTab?.view
    if (!view) return
    const pattern = await promptText(this.window, {
      heading: 'Select Items Matching',
      body: 'Use * and ? as wildcards (e.g. “*.png”).',
      placeholder: 'Pattern', okLabel: 'Select',
    })
    if (!pattern) return
    const count = view.selectPattern(pattern)
    view.focusView()
    this.toast(count > 0 ? `Selected ${count} item${count === 1 ? '' : 's'}` : 'No items match the pattern')
  }

  _openSelection(): void {
    const sel = this._selected()
    if (sel[0]) this.onItemActivated(this.activeTab!, sel[0].info, sel[0].file)
  }

  _openNewTab(): void {
    for (const s of this._selected()) if (isDirectory(s.info)) this.openTab(s.file)
  }

  _openTerminal(): void {
    const path = this.activeTab && this.activeTab.location.getPath()
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
      const uri = sel.file.getUri()
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
  async onDropFiles(tab: Tab, files: GFile[], targetDir?: GFile): Promise<void> {
    const dest = targetDir ?? tab.location
    const destUri = dest.getUri()
    const incoming = files.filter(f => { const p = f.getParent(); return !p || p.getUri() !== destUri })
    if (!incoming.length) return
    const plan = await this._resolvePlan(incoming, dest, !!targetDir)
    if (!plan || !plan.length) return
    if (targetDir) {
      const origParent = incoming[0].getParent()
      let dests = this.fileOps.moveItems(plan)
      if (origParent) this.undo.push({
        undo: () => { dests = this.fileOps.move(dests, origParent) },
        redo: () => { dests = this.fileOps.moveItems(plan) },
        undoLabel: 'Undo Move', redoLabel: 'Redo Move',
      })
    } else {
      let dests = this.fileOps.copyItems(plan)
      this.undo.push({
        undo: () => this.fileOps.trash(dests),
        redo: () => { dests = this.fileOps.copyItems(plan) },
        undoLabel: 'Undo Copy', redoLabel: 'Redo Copy',
      })
    }
  }

  /* Turn a set of sources + a destination into a runnable copy/move plan,
   * prompting for any name collisions (Replace / Skip / Keep Both). Returns null
   * if the user cancels the operation, or the (possibly empty) resolved plan.
   * `move` distinguishes cut/move from copy so pasting an item into its own
   * folder is handled sanely (see below) instead of prompting to overwrite it. */
  async _resolvePlan(files: GFile[], destDir: GFile, move = false): Promise<CopyItem[] | null> {
    const { free, conflicts } = partitionConflicts(files, destDir)
    const items: CopyItem[] = free.map(src => ({ src, dest: destDir.getChild(src.getBasename()) }))
    /* A collision where the destination *is* the source (pasting an item into
     * its own folder) is never a real overwrite: copy → duplicate ("keep both"),
     * move → no-op, so skip. Don't prompt. */
    const real = conflicts.filter(c => {
      if (!c.src.equal(c.dest)) return true
      if (!move) items.push({ src: c.src, dest: uniqueChild(destDir, c.name) })
      return false
    })
    if (real.length) {
      const res = await resolveConflicts(this.window, real, destDir)
      if (!res) return null
      for (const c of real) {
        const action = res.get(c.src)
        if (action === 'skip') continue
        if (action === 'replace') items.push({ src: c.src, dest: c.dest, replace: true })
        else items.push({ src: c.src, dest: uniqueChild(destDir, c.name) })
      }
    }
    return items
  }

  async _paste(): Promise<void> {
    const dest = this._pasteTarget || this.activeTab?.location
    if (!dest) return
    if (this.clipboard.isEmpty) { this._pasteFromSystem(dest); return }
    const files = this.clipboard.files.slice()
    const cut = this.clipboard.cut
    const plan = await this._resolvePlan(files, dest, cut)
    if (!plan || !plan.length) return
    if (cut) {
      const origParent = files[0].getParent()
      let dests = this.fileOps.moveItems(plan)
      this.clipboard.clear()
      if (origParent) this.undo.push({
        undo: () => { dests = this.fileOps.move(dests, origParent) },
        redo: () => { dests = this.fileOps.move(dests, dest) },
        undoLabel: 'Undo Move', redoLabel: 'Redo Move',
      })
    } else {
      let dests = this.fileOps.copyItems(plan)
      this.undo.push({
        undo: () => this.fileOps.trash(dests),
        redo: () => { dests = this.fileOps.copyItems(plan) },
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

  /* Properties for an arbitrary file (pathbar crumb menu, Computer drive menu). */
  _propertiesFor(file: GFile, opts?: { expandUsage?: boolean }): void {
    try {
      const info = file.queryInfo(ATTRS, Gio.FileQueryInfoFlags.NONE, null)
      showProperties(this.window, info, file, opts)
    } catch {}
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
    const base = files.length === 1 ? files[0].getBasename() : 'Archive'
    const res = await compressDialog(this.window, base)
    if (!res) return
    this.archive.compress(files, this.activeTab.location.getChild(res.name), res.format)
  }

  _restore(): void {
    const pairs = this._selected()
      .map(s => [s.file, s.info.getAttributeByteString('trash::orig-path')] as [GFile, string])
      .filter(p => !!p[1])
    if (pairs.length) this.fileOps.restore(pairs)
  }

  /* Restore the selected Trash items into a folder the user picks, rather than
   * their recorded original location (which may no longer exist, or where the
   * user simply doesn't want them). */
  async _restoreTo(): Promise<void> {
    const sel = this._selected()
    if (!sel.length) return
    const dir = await chooseFolder(this.window, { title: 'Restore to Folder' })
    if (!dir) return
    const items = sel.map(s => ({ file: s.file, name: displayName(s.info) }))
    if (this.fileOps.restoreTo(items, dir))
      this.toast(`Restored ${items.length} item${items.length > 1 ? 's' : ''} to “${locationName(dir)}”`)
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
