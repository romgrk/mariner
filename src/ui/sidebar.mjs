import Gtk from 'gi:Gtk-4.0'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { F, HOME, fileForPath, fileForUri, specialDirs } from '../util.mjs'

/* Places sidebar. onNavigate(file) on row activation. */
export function createSidebar(onNavigate) {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true })
  box.addCssClass('navigation-sidebar')
  const rows = []  /* {row, listbox, uri} */

  function makeList() {
    const lb = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE })
    lb.addCssClass('navigation-sidebar')
    lb.on('row-activated', (...a) => {
      const row = a[a.length - 1]
      if (row && row._file) onNavigate(row._file)
    })
    return lb
  }

  function addRow(lb, { label, icon, file }) {
    const row = new Gtk.ListBoxRow()
    row._file = file
    const b = new Gtk.Box({
      spacing: 12, marginTop: 5, marginBottom: 5, marginStart: 6, marginEnd: 6,
    })
    b.append(new Gtk.Image({ iconName: icon }))
    b.append(new Gtk.Label({ label, xalign: 0, ellipsize: 3, hexpand: true }))
    row.setChild(b)
    lb.append(row)
    rows.push({ row, listbox: lb, uri: F.getUri(file) })
  }

  function header(text) {
    const l = new Gtk.Label({
      label: text, xalign: 0, marginTop: 12, marginStart: 12, marginBottom: 4,
    })
    l.addCssClass('heading')
    l.addCssClass('dim-label')
    box.append(l)
  }

  /* Places */
  const places = makeList()
  addRow(places, { label: 'Recent', icon: 'document-open-recent-symbolic', file: fileForUri('recent:///') })
  addRow(places, { label: 'Home', icon: 'user-home-symbolic', file: fileForPath(HOME) })
  for (const d of specialDirs()) addRow(places, d)
  addRow(places, { label: 'Trash', icon: 'user-trash-symbolic', file: fileForUri('trash:///') })
  box.append(places)

  /* Bookmarks */
  const bookmarksList = makeList()
  const bookmarksHeader = (() => { header('Bookmarks'); return box.getLastChild() })()
  box.append(bookmarksList)

  /* Devices */
  const devicesList = makeList()
  const devicesHeader = (() => { header('Devices'); return box.getLastChild() })()
  box.append(devicesList)

  function reloadBookmarks() {
    let r
    while ((r = bookmarksList.getFirstChild()) !== null) bookmarksList.remove(r)
    for (const { uri, label } of readBookmarks()) {
      const file = fileForUri(uri)
      if (!F.queryExists(file, null)) continue
      addRow(bookmarksList, { label: label || F.getBasename(file), icon: 'folder-symbolic', file })
    }
    const has = bookmarksList.getFirstChild() !== null
    bookmarksHeader.setVisible(has)
    bookmarksList.setVisible(has)
  }

  function reloadDevices() {
    let r
    while ((r = devicesList.getFirstChild()) !== null) devicesList.remove(r)
    let mounts = []
    try { mounts = Gio.VolumeMonitor.get().getMounts() } catch {}
    for (const mount of mounts) {
      const root = mount.getRoot()
      const icon = mount.getSymbolicIcon?.()
      addRow(devicesList, {
        label: mount.getName(),
        icon: 'drive-harddisk-symbolic',
        file: root,
      })
      void icon
    }
    const has = devicesList.getFirstChild() !== null
    devicesHeader.setVisible(has)
    devicesList.setVisible(has)
  }

  function setActive(file) {
    const uri = F.getUri(file)
    for (const { listbox } of rows) listbox.unselectAll()
    const match = rows.find(r => r.uri === uri)
    if (match) match.listbox.selectRow(match.row)
  }

  reloadBookmarks()
  reloadDevices()

  const scroll = new Gtk.ScrolledWindow({
    child: box, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER,
  })
  return { widget: scroll, setActive, reloadBookmarks, reloadDevices }
}

function readBookmarks() {
  const path = GLib.buildFilenamev([HOME, '.config', 'gtk-3.0', 'bookmarks'])
  if (!GLib.fileTest(path, GLib.FileTest.EXISTS)) return []
  let text = ''
  try {
    const res = GLib.fileGetContents(path)
    const data = Array.isArray(res) ? res[1] : res
    text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  } catch { return [] }
  return text.split('\n').filter(Boolean).map(line => {
    const sp = line.indexOf(' ')
    return sp < 0
      ? { uri: line, label: '' }
      : { uri: line.slice(0, sp), label: line.slice(sp + 1) }
  })
}
