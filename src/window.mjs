import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'
import Gdk from 'gi:Gdk-4.0'

function boolValue(b) {
  const v = new GObject.Value()
  v.init(GObject.typeFromName('gboolean'))
  v.setBoolean(b)
  return v
}

import { Tab } from './tab.mjs'
import {
  F, HOME, fileForPath, fileForUri, locationName, isDirectory, displayName,
} from './util.mjs'
import * as ops from './ops.mjs'
import {
  promptText, confirm, showProperties, aboutDialog,
} from './ui/dialogs.mjs'
import { createSidebar } from './ui/sidebar.mjs'
import { createToolbar } from './ui/toolbar.mjs'

const MIN_ZOOM = 32, MAX_ZOOM = 128, ZOOM_STEP = 16

export class AppWindow {
  constructor(app, startFile) {
    this.app = app
    this.prefs = { showHidden: false, sortKey: 'name', sortDesc: false, viewMode: 'grid', iconSize: 64 }
    this.tabs = []
    this._activeTab = null
    this.clipboard = { files: [], cut: false }

    this._buildUI()
    this._buildActions()
    this.openTab(startFile)
    this.window.present()
  }

  get activeTab() { return this._activeTab }

  /* ---- UI ---- */
  _buildUI() {
    this.window = new Adw.ApplicationWindow(this.app)
    this.window.setTitle('Files')
    this.window.setDefaultSize(890, 550)
    this.window.addCssClass('view')

    this.toastOverlay = new Adw.ToastOverlay()
    this.split = new Adw.OverlaySplitView({
      maxSidebarWidth: 240, sidebarWidthFraction: 0.2, showSidebar: true,
    })

    /* Sidebar pane */
    this.sidebar = createSidebar(file => this.navigate(file))
    const sidebarView = new Adw.ToolbarView()
    const sidebarHeader = new Adw.HeaderBar()
    sidebarHeader.setTitleWidget(new Adw.WindowTitle({ title: 'Files' }))
    const menuButton = new Gtk.MenuButton({
      iconName: 'open-menu-symbolic', tooltipText: 'Main Menu', menuModel: this._appMenu(),
    })
    sidebarHeader.packEnd(menuButton)
    sidebarView.addTopBar(sidebarHeader)
    sidebarView.setContent(this.sidebar.widget)
    this.split.setSidebar(sidebarView)

    /* Content pane */
    this.toolbar = createToolbar({
      onNavigate: file => this.navigate(file),
      onLocationEntry: text => this.openPath(text),
      onSearchChanged: text => this.activeTab?.setSearch(text),
    })
    this.tabView = new Adw.TabView()
    this.tabView.on('notify::selected-page', () => this._onTabSwitched())
    this.tabView.on('close-page', (...a) => this._onClosePage(a[a.length - 1]))
    const tabBar = new Adw.TabBar({ view: this.tabView, autohide: true })

    const contentView = new Adw.ToolbarView()
    contentView.addTopBar(this.toolbar.header)
    contentView.addTopBar(tabBar)
    contentView.setContent(this.tabView)
    this.split.setContent(contentView)

    this.toastOverlay.setChild(this.split)
    this.window.setContent(this.toastOverlay)

    /* Responsive: collapse the sidebar on narrow windows. */
    try {
      const bp = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 682sp') })
      bp.addSetter(this.split, 'collapsed', boolValue(true))
      this.window.addBreakpoint(bp)
    } catch (e) { /* responsive collapse is optional */ }
  }

  _appMenu() {
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

  /* ---- Actions ---- */
  _buildActions() {
    const add = (name, cb) => {
      const a = Gio.SimpleAction.new(name, null)
      a.on('activate', cb)
      this.window.addAction(a)
      return a
    }
    const addToggle = (name, initial, cb) => {
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

    /* Sort radio (mutually-exclusive booleans; never read the signal variant). */
    this.sortActions = {}
    for (const key of ['name', 'size', 'type', 'modified']) {
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

    /* Selection operations */
    add('select-all', () => this.activeTab?.view.selectAll())
    add('open', () => this._openSelection())
    add('copy', () => this._clip(false))
    add('cut', () => this._clip(true))
    add('paste', () => this._paste(this.activeTab?.location))
    add('rename', () => this._rename())
    add('trash', () => this._trash())
    add('delete', () => this._delete())
    add('properties', () => this._properties())
    add('empty-trash', () => this._emptyTrash())
  }

  _syncSort() {
    for (const [key, a] of Object.entries(this.sortActions))
      a.setState(GLib.Variant.newBoolean(key === this.prefs.sortKey))
  }

  _zoom(delta) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.prefs.iconSize + delta))
    if (next === this.prefs.iconSize) return
    this.prefs.iconSize = next
    this.activeTab?.applyPrefs()
  }

  /* ---- Tabs / navigation ---- */
  openTab(file) {
    const tab = new Tab(this, file)
    this.tabs.push(tab)
    this._activeTab = tab
    this.tabView.setSelectedPage(tab.page)
    this.refreshChrome(tab)
    return tab
  }

  navigate(file) { this.activeTab?.navigate(file) }

  openPath(text) {
    text = text.trim()
    if (!text) return
    let file
    if (text.startsWith('~')) file = fileForPath(HOME + text.slice(1))
    else if (/^[a-z]+:\/\//i.test(text)) file = fileForUri(text)
    else if (text.startsWith('/')) file = fileForPath(text)
    else file = F.getChild(this.activeTab.location, text)

    if (F.queryExists(file, null)) {
      this.toolbar.showStack('pathbar')
      this.navigate(file)
    } else {
      this.toast('Location not found')
    }
  }

  _onTabSwitched() {
    const page = this.tabView.getSelectedPage()
    if (!page) return
    const tab = this.tabs.find(t => t.page === page)
    if (!tab) return
    this._activeTab = tab
    this.refreshChrome(tab)
  }

  _onClosePage(page) {
    const tab = this.tabs.find(t => t.page === page)
    if (tab) { tab.destroy(); this.tabs = this.tabs.filter(t => t !== tab) }
    this.tabView.closePageFinish(page, true)
    if (this.tabView.getNPages() === 0) this.window.close()
    return true
  }

  onTabChanged(tab) {
    if (tab === this._activeTab) this.refreshChrome(tab)
  }

  refreshChrome(tab) {
    this.toolbar.pathbar.setLocation(tab.location)
    this.toolbar.locationEntry.setText(F.getPath(tab.location) || F.getUri(tab.location))
    this.toolbar.setViewIcon(this.prefs.viewMode)
    this.window.setTitle(locationName(tab.location))
    this.backAction.setEnabled(tab.canGoBack)
    this.forwardAction.setEnabled(tab.canGoForward)
    this.upAction.setEnabled(!!tab.parent)
    this.sidebar.setActive(tab.location)
  }

  /* ---- Item activation + context menu ---- */
  onItemActivated(tab, info, file) {
    if (isDirectory(info)) { tab.navigate(file); return }
    try {
      Gio.AppInfo.launchDefaultForUri(F.getUri(file), null)
    } catch {
      this.toast(`Could not open “${displayName(info)}”`)
    }
  }

  showContextMenu(tab, widget, x, y, target) {
    const menu = Gio.Menu.new()
    if (target) {
      const s1 = Gio.Menu.new()
      s1.append('Open', 'win.open')
      menu.appendSection(null, s1)
      const s2 = Gio.Menu.new()
      s2.append('Cut', 'win.cut')
      s2.append('Copy', 'win.copy')
      if (isDirectory(target.info) && this.clipboard.files.length)
        s2.append('Paste Into Folder', 'win.paste')
      menu.appendSection(null, s2)
      const s3 = Gio.Menu.new()
      s3.append('Rename…', 'win.rename')
      s3.append('Move to Trash', 'win.trash')
      s3.append('Delete Permanently', 'win.delete')
      menu.appendSection(null, s3)
      const s4 = Gio.Menu.new()
      s4.append('Properties', 'win.properties')
      menu.appendSection(null, s4)
      this._pasteTarget = isDirectory(target.info) ? target.file : tab.location
    } else {
      const s1 = Gio.Menu.new()
      s1.append('New Folder…', 'win.new-folder')
      menu.appendSection(null, s1)
      const s2 = Gio.Menu.new()
      if (this.clipboard.files.length) s2.append('Paste', 'win.paste')
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
  _selected() { return this.activeTab ? this.activeTab.view.getSelected() : [] }
  _selectedFiles() { return this._selected().map(s => s.file) }

  async _newFolder() {
    if (!this.activeTab) return
    const name = await promptText(this.window, {
      heading: 'New Folder', value: 'New Folder', okLabel: 'Create', selectBasename: true,
    })
    if (!name) return
    try { ops.newFolder(this.activeTab.location, name) }
    catch (e) { this.toast('Could not create folder') }
  }

  _openSelection() {
    const sel = this._selected()
    if (sel[0]) this.onItemActivated(this.activeTab, sel[0].info, sel[0].file)
  }

  _clip(cut) {
    const files = this._selectedFiles()
    if (!files.length) return
    this.clipboard = { files, cut }
    this.toast(`${files.length} item${files.length > 1 ? 's' : ''} ${cut ? 'cut' : 'copied'}`)
  }

  _paste(destDir) {
    const dest = this._pasteTarget || destDir
    if (!dest || !this.clipboard.files.length) return
    try {
      if (this.clipboard.cut) {
        ops.moveInto(this.clipboard.files, dest)
        this.clipboard = { files: [], cut: false }
      } else {
        ops.copyInto(this.clipboard.files, dest)
      }
    } catch (e) { this.toast('Paste failed') }
  }

  async _rename() {
    const sel = this._selected()
    if (sel.length !== 1) return
    const newName = await promptText(this.window, {
      heading: 'Rename', value: displayName(sel[0].info), okLabel: 'Rename', selectBasename: true,
    })
    if (!newName || newName === displayName(sel[0].info)) return
    try { ops.rename(sel[0].file, newName) }
    catch (e) { this.toast('Could not rename') }
  }

  async _trash() {
    const files = this._selectedFiles()
    if (!files.length) return
    try {
      const n = ops.trash(files)
      this.toast(`Moved ${n} item${n > 1 ? 's' : ''} to Trash`)
    } catch (e) { this.toast('Could not move to Trash') }
  }

  async _delete() {
    const files = this._selectedFiles()
    if (!files.length) return
    const ok = await confirm(this.window, {
      heading: `Permanently delete ${files.length} item${files.length > 1 ? 's' : ''}?`,
      body: 'This action cannot be undone.', okLabel: 'Delete',
    })
    if (!ok) return
    try { ops.deletePermanently(files) }
    catch (e) { this.toast('Could not delete') }
  }

  _properties() {
    const sel = this._selected()
    if (sel[0]) showProperties(this.window, sel[0].info, sel[0].file)
  }

  async _emptyTrash() {
    const ok = await confirm(this.window, {
      heading: 'Empty all items from Trash?',
      body: 'All items will be permanently deleted.', okLabel: 'Empty Trash',
    })
    if (!ok) return
    try { ops.emptyTrash() } catch { this.toast('Could not empty Trash') }
  }

  /* ---- Search / location ---- */
  _showLocationEntry() {
    this.toolbar.showStack('location')
    this.toolbar.locationEntry.grabFocus()
    this.toolbar.locationEntry.selectRegion(0, -1)
  }

  _toggleSearch() {
    this.searching = !this.searching
    this.searchAction.setState(GLib.Variant.newBoolean(this.searching))
    if (this.searching) {
      this.toolbar.showStack('search')
      this.toolbar.searchEntry.grabFocus()
    } else {
      this.toolbar.showStack('pathbar')
      this.toolbar.searchEntry.setText('')
      this.activeTab?.setSearch('')
    }
  }

  toast(text) {
    this.toastOverlay.addToast(new Adw.Toast({ title: text }))
  }
}
