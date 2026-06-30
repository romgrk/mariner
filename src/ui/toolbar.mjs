import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import { createPathBar } from './pathbar.mjs'

/* Content-area header bar: history, breadcrumb/location/search stack, view
 * controls, new-folder. Buttons drive win.* actions defined by the window. */
export function createToolbar({ onNavigate, onLocationEntry, onSearchChanged }) {
  const header = new Adw.HeaderBar()

  /* History controls */
  const histBox = new Gtk.Box()
  histBox.addCssClass('linked')
  histBox.append(iconButton('go-previous-symbolic', 'Back', 'win.back'))
  histBox.append(iconButton('go-next-symbolic', 'Forward', 'win.forward'))
  header.packStart(histBox)
  header.packStart(iconButton('go-up-symbolic', 'Up', 'win.up'))

  /* Title: pathbar | location-entry | search */
  const pathbar = createPathBar(onNavigate)

  const locationEntry = new Gtk.Entry({ hexpand: true })
  locationEntry.on('activate', () => onLocationEntry(locationEntry.getText()))
  const locationBox = new Gtk.Box()
  locationBox.addCssClass('linked')
  locationBox.append(locationEntry)
  const locationClose = iconButton('window-close-symbolic', 'Cancel', null)
  locationClose.on('clicked', () => showStack('pathbar'))
  locationBox.append(locationClose)

  const searchEntry = new Gtk.SearchEntry({ hexpand: true })
  searchEntry.on('search-changed', () => onSearchChanged(searchEntry.getText()))

  const titleStack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE })
  titleStack.addNamed(wrapCenter(pathbar.widget), 'pathbar')
  titleStack.addNamed(locationBox, 'location')
  titleStack.addNamed(searchEntry, 'search')

  const searchButton = new Gtk.ToggleButton({
    iconName: 'edit-find-symbolic', tooltipText: 'Search Current Folder',
  })

  const titleBox = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
  titleBox.append(titleStack)
  titleBox.append(searchButton)
  header.setTitleWidget(titleBox)

  /* End: view controls + new folder */
  const viewMenu = buildViewMenu()
  const viewButton = new Adw.SplitButton({
    iconName: 'view-grid-symbolic',
    menuModel: viewMenu,
    tooltipText: 'View Options',
  })
  viewButton.on('clicked', () => header.getRootWindow?.())
  viewButton.setActionName('win.toggle-view')

  const newFolderButton = iconButton('folder-new-symbolic', 'New Folder', 'win.new-folder')

  header.packEnd(viewButton)
  header.packEnd(newFolderButton)

  function showStack(name) { titleStack.setVisibleChildName(name) }
  function setViewIcon(mode) {
    /* Show the icon for the mode you'd switch TO. */
    viewButton.setIconName(mode === 'grid' ? 'view-list-symbolic' : 'view-grid-symbolic')
  }

  return {
    header, pathbar, locationEntry, searchEntry, searchButton,
    showStack, setViewIcon,
  }
}

function iconButton(iconName, tooltip, actionName) {
  const b = new Gtk.Button({ iconName, tooltipText: tooltip })
  if (actionName) b.setActionName(actionName)
  return b
}

function wrapCenter(child) {
  const b = new Gtk.Box({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
  b.append(child)
  return b
}

function buildViewMenu() {
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
  menu.appendSection(null, opts)

  const zoom = Gio.Menu.new()
  zoom.append('Zoom In', 'win.zoom-in')
  zoom.append('Zoom Out', 'win.zoom-out')
  menu.appendSection(null, zoom)

  return menu
}
