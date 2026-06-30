import Gtk from 'gi:Gtk-4.0'
import { F } from '../core/gio.ts'
import { getPlaces, getBookmarks, getDevices } from '../services/places-service.ts'
import type { GFile, Place } from '../core/types.ts'

interface SidebarRow { row: any; listbox: any; uri: string }

export interface Sidebar {
  widget: any
  setActive: (file: GFile) => void
  refresh: () => void
}

/* Places sidebar (pure view). onNavigate(file) on row activation. */
export function createSidebar(onNavigate: (file: GFile) => void): Sidebar {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true })
  box.addCssClass('navigation-sidebar')
  let rows: SidebarRow[] = []

  function makeList(): any {
    const lb = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE })
    lb.addCssClass('navigation-sidebar')
    lb.on('row-activated', (...a: any[]) => {
      const row = a[a.length - 1]
      if (row?._file) onNavigate(row._file)
    })
    return lb
  }

  function addRow(lb: any, place: Place): void {
    const row = new Gtk.ListBoxRow()
    row._file = place.file
    const b = new Gtk.Box({ spacing: 12, marginTop: 5, marginBottom: 5, marginStart: 6, marginEnd: 6 })
    b.append(new Gtk.Image({ iconName: place.icon }))
    b.append(new Gtk.Label({ label: place.label, xalign: 0, ellipsize: 3, hexpand: true }))
    row.setChild(b)
    lb.append(row)
    rows.push({ row, listbox: lb, uri: F.getUri(place.file) })
  }

  function section(title: string, places: Place[], { showHeader = false }: { showHeader?: boolean } = {}): void {
    if (!places.length) return
    if (showHeader) {
      const l = new Gtk.Label({ label: title, xalign: 0, marginTop: 12, marginStart: 12, marginBottom: 4 })
      l.addCssClass('heading'); l.addCssClass('dim-label')
      box.append(l)
    }
    const lb = makeList()
    for (const p of places) addRow(lb, p)
    box.append(lb)
  }

  function build(): void {
    let c
    while ((c = box.getFirstChild()) !== null) box.remove(c)
    rows = []
    section('Places', getPlaces())
    section('Bookmarks', getBookmarks(), { showHeader: true })
    section('Devices', getDevices(), { showHeader: true })
  }

  function setActive(file: GFile): void {
    const uri = F.getUri(file)
    for (const { listbox } of rows) listbox.unselectAll()
    const match = rows.find(r => r.uri === uri)
    if (match) match.listbox.selectRow(match.row)
  }

  build()
  const scroll = new Gtk.ScrolledWindow({ child: box, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER })
  return { widget: scroll, setActive, refresh: build }
}
