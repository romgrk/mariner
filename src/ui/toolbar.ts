import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { createPathBar } from './pathbar.ts'
import { createSearchFilterButton } from './search-filter.ts'
import type { PathBar } from './pathbar.ts'
import type { GFile, ViewMode, SearchFilter } from '../core/types.ts'

export interface ToolbarHandlers {
  onNavigate: (file: GFile) => void
  onOpenTab: (file: GFile) => void
  onOpenWindow: (file: GFile) => void
  onProperties: (file: GFile) => void
  onLocationEntry: (text: string) => void
  onLocationExit: () => void
  onSearchChanged: (text: string) => void
  onSearchFilter: (f: SearchFilter) => void
  onSearchExit: () => void
}

export interface Toolbar {
  header: any
  pathbar: PathBar
  locationEntry: any
  searchEntry: any
  searchButton: any
  showStack: (name: string) => void
  setViewIcon: (mode: ViewMode) => void
  packTrailing: (w: any) => void
}

/* Content-area header bar: history, breadcrumb/location/search stack, view
 * controls, new-folder. Buttons drive win.* actions defined by the window. */
export function createToolbar({ onNavigate, onOpenTab, onOpenWindow, onProperties, onLocationEntry, onLocationExit, onSearchChanged, onSearchFilter, onSearchExit }: ToolbarHandlers): Toolbar {
  /* The whole header is one hexpanding row (assembled as the title widget) so
   * the pathbar fills all slack between the history group and the window
   * buttons. AdwHeaderBar's own start/end areas are avoided because a centered
   * title reserves the *wider* side's width on BOTH sides, stranding a gap on
   * the lighter side (e.g. history is 2 buttons but `appmenu:close` is only 1);
   * with nothing packed on either side the reserved margin is zero. The window
   * buttons are therefore rendered inline via GtkWindowControls instead. */
  const header = new Adw.HeaderBar({ showStartTitleButtons: false, showEndTitleButtons: false })

  /* History controls — flat (not raised/linked), matching the search/view
   * buttons rather than reading as a solid pair. */
  const histBox = new Gtk.Box()
  const backButton = iconButton('go-previous-symbolic', 'Back', 'win.back')
  const forwardButton = iconButton('go-next-symbolic', 'Forward', 'win.forward')
  backButton.addCssClass('flat')
  forwardButton.addCssClass('flat')
  histBox.append(backButton)
  histBox.append(forwardButton)

  /* Title: pathbar | location-entry | search */
  const pathbar = createPathBar({ onNavigate, onOpenTab, onOpenWindow, onProperties })

  const locationEntry = new Gtk.Entry({ hexpand: true })
  locationEntry.on('activate', () => onLocationEntry(locationEntry.getText()))
  /* Escape abandons the entry and hands focus back to the file view; the
   * focus-out handler below then restores the breadcrumb display. */
  const locationKey = new Gtk.EventControllerKey()
  locationKey.on('key-pressed', (...a: any[]) => {
    if (a[0] === Gdk.KEY_Escape) { onLocationExit(); return true }
    return false
  })
  locationEntry.addController(locationKey)
  const locationBox = new Gtk.Box()
  locationBox.addCssClass('linked')
  locationBox.append(locationEntry)
  const locationClose = iconButton('window-close-symbolic', 'Cancel', null)
  locationClose.on('clicked', () => showStack('pathbar'))
  locationBox.append(locationClose)

  const searchEntry = new Gtk.SearchEntry({ hexpand: true })
  searchEntry.on('search-changed', () => onSearchChanged(searchEntry.getText()))
  /* Escape exits search (GtkSearchEntry::stop-search). Otherwise search stays up
   * until the user navigates elsewhere — the window drops it on location change.
   * Blur deliberately does NOT cancel, so opening the filter popover is safe. */
  searchEntry.on('stop-search', () => onSearchExit())
  const filterButton = createSearchFilterButton(onSearchFilter)
  const searchBox = new Gtk.Box()
  searchBox.addCssClass('linked')
  searchBox.append(searchEntry)
  searchBox.append(filterButton.widget)

  const titleStack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE, hexpand: true })
  titleStack.addNamed(pathbar.widget, 'pathbar')
  titleStack.addNamed(locationBox, 'location')
  titleStack.addNamed(searchBox, 'search')

  /* Losing focus on the location entry reverts to the breadcrumb display
   * (nautilus's location entry cancels on focus-out). Deferred to idle so it
   * doesn't reshuffle the stack mid focus-change, and guarded on the entry
   * still being shown so an Enter-navigation that already switched away — or a
   * switch to search — isn't clobbered back to the pathbar. */
  const locationFocus = new Gtk.EventControllerFocus()
  locationFocus.on('leave', () => GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (titleStack.getVisibleChildName() === 'location') showStack('pathbar')
    return false
  }))
  locationEntry.addController(locationFocus)

  const searchButton = new Gtk.ToggleButton({ iconName: 'edit-find-symbolic', tooltipText: 'Search Current Folder' })

  const viewButton = new Adw.SplitButton({
    iconName: 'view-grid-symbolic', menuModel: buildViewMenu(), tooltipText: 'View Options',
  })
  viewButton.setActionName('win.toggle-view')

  /* Inline window buttons (close/minimise/maximise per the system decoration
   * layout) sit at the trailing edge; GtkWindowControls renders nothing for a
   * side that has no buttons, so this also covers layouts with buttons on the
   * left. */
  const windowControls = new Gtk.WindowControls({ side: Gtk.PackType.END })

  /* history | pathbar/location/search (hexpands) | search | view | <trailing> |
   * window buttons — a plain box, so the pathbar fills the middle with no gap. */
  const titleBox = new Gtk.Box({ hexpand: true, spacing: 6 })
  titleBox.append(histBox)
  titleBox.append(titleStack)
  titleBox.append(searchButton)
  titleBox.append(viewButton)
  titleBox.append(windowControls)
  header.setTitleWidget(titleBox)

  function showStack(name: string): void { titleStack.setVisibleChildName(name) }
  function setViewIcon(mode: ViewMode): void {
    /* Show the icon for the mode you'd switch TO. */
    viewButton.setIconName(mode === 'grid' ? 'view-list-symbolic' : 'view-grid-symbolic')
  }
  /* Insert a trailing control (e.g. the file-operations button) just left of the
   * window buttons, replacing what would otherwise be header.packEnd(). */
  function packTrailing(w: any): void { titleBox.insertChildAfter(w, viewButton) }

  return { header, pathbar, locationEntry, searchEntry, searchButton, showStack, setViewIcon, packTrailing }
}

function iconButton(iconName: string, tooltip: string, actionName: string | null): any {
  const b = new Gtk.Button({ iconName, tooltipText: tooltip })
  if (actionName) b.setActionName(actionName)
  return b
}

function buildViewMenu(): any {
  const menu = Gio.Menu.new()

  const sort = Gio.Menu.new()
  sort.append('Name', 'win.sort-name')
  sort.append('Size', 'win.sort-size')
  sort.append('Type', 'win.sort-type')
  sort.append('Last Modified', 'win.sort-modified')
  menu.appendSection('Sort', sort)

  const dir = Gio.Menu.new()
  dir.append('Descending', 'win.sort-desc')
  menu.appendSection(null, dir)

  const opts = Gio.Menu.new()
  opts.append('Show Hidden Files', 'win.show-hidden')
  opts.append('Visible Columns…', 'win.choose-columns')
  menu.appendSection(null, opts)

  const zoom = Gio.Menu.new()
  zoom.append('Zoom In', 'win.zoom-in')
  zoom.append('Zoom Out', 'win.zoom-out')
  menu.appendSection(null, zoom)

  return menu
}
