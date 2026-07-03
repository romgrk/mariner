import Gio from 'gi:Gio-2.0'
import Gtk from 'gi:Gtk-4.0'
import { getPlaces, getBookmarks, getComputer, getDevices } from '../services/places-service.ts'
import { initVolumeMonitor } from '../services/volume-monitor.ts'
import { tagsService, tagUri } from '../services/tags-service.ts'
import { fileForUri } from '../core/gio.ts'
import { makeDropTarget } from './dnd.ts'
import { tagIconName } from './tag-icons.ts'
import type { GFile, Place } from '../core/types.ts'

/* Section ids drive the separators between groups: nautilus'
 * list_box_header_func draws a GtkSeparator whenever a row's section differs
 * from the previous row's (and no text section headers). */
const SECTION_DEFAULT = 0
const SECTION_BOOKMARKS = 1
const SECTION_TAGS = 2
const SECTION_COMPUTER = 3
const SECTION_MOUNTS = 4

const TAGS_EXPANDED_KEY = 'sidebar-tags-expanded'

interface SidebarRow { row: any; uri: string }

export interface Sidebar {
  widget: any
  setActive: (file: GFile) => void
  refresh: () => void
}

/* Places sidebar (pure view). onNavigate(file) on row activation.
 *
 * A faithful port of nautilus-sidebar.c: a single `.navigation-sidebar`
 * GtkListBox in single-selection / activate-on-single-click mode, rows built
 * like nautilus-sidebar-row.blp (start icon, middle-ellipsized label, an eject
 * button on removable devices), and the Places / Bookmarks / Devices groups
 * split by separators — nautilus draws these from its list_box_header_func, with
 * no text section headers.
 *
 * `isHidden(id)` filters out user-hidden items/sections (Preferences → Sidebar);
 * ids are the SIDEBAR_ITEMS ids. refresh() re-applies it after a change.
 *
 * The separators are non-selectable separator rows rather than GtkListBoxRow
 * headers: node-gtk mis-marshals GtkListBox.setHeaderFunc/setHeader, and a
 * separator row is visually identical and keyboard-skipped. */
export function createSidebar(
  onNavigate: (file: GFile) => void,
  onBookmarkMenu: (file: GFile, widget: any, x: number, y: number) => void = () => {},
  isHidden: (id: string) => boolean = () => false,
  onTagMenu: (name: string, widget: any, x: number, y: number) => void = () => {},
): Sidebar {
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE })
  list.addCssClass('navigation-sidebar')
  list.setActivateOnSingleClick(true)
  let rows: SidebarRow[] = []
  let prevSection = -1
  let activeUri: string | null = null

  list.on('row-activated', (...a: any[]) => {
    const row = a[a.length - 1]
    if (row?._file) onNavigate(row._file)
  })

  function addSeparator(): void {
    const sep = new Gtk.ListBoxRow({ selectable: false, activatable: false, focusable: false })
    sep.addCssClass('sidebar-separator-row')
    sep.setChild(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }))
    list.append(sep)
  }

  function addRow(place: Place, section: number): void {
    enterSection(section)

    const row = new Gtk.ListBoxRow({ focusOnClick: false })
    row._file = place.file

    const b = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL })
    b.append(new Gtk.Image({ iconName: place.icon, marginEnd: 8 }))
    b.append(new Gtk.Label({
      label: place.label,
      xalign: 0,
      hexpand: true,
      ellipsize: 2 /* Pango.EllipsizeMode.MIDDLE — matches nautilus-sidebar-row.blp */,
      marginEnd: 2,
    }))

    /* Eject/unmount button for removable devices (nautilus' eject_button). */
    const mount = place.mount
    if (mount != null) {
      const canEject = safe(() => mount.canEject())
      const canUnmount = safe(() => mount.canUnmount())
      if (canEject || canUnmount) {
        const eject = new Gtk.Button({
          iconName: 'media-eject-symbolic',
          halign: Gtk.Align.CENTER,
          valign: Gtk.Align.CENTER,
          marginStart: 4,
          tooltipText: canEject ? 'Eject' : 'Unmount',
        })
        eject.addCssClass('sidebar-button')
        eject.addCssClass('flat')
        eject.on('clicked', () => ejectMount(mount, canEject))
        b.append(eject)
      }
    }

    row.setChild(b)

    /* Bookmarks (and only bookmarks) get a right-click menu — to remove them. */
    if (section === SECTION_BOOKMARKS) {
      const secondary = new Gtk.GestureClick({ button: 3 })
      secondary.on('pressed', (...a: any[]) => {
        const [x, y] = a.slice(-2)
        onBookmarkMenu(place.file, row, x, y)
      })
      row.addController(secondary)
    }

    list.append(row)
    rows.push({ row, uri: place.file.getUri() })
  }

  /* Section-transition separator, shared by addRow and the tag rows. */
  function enterSection(section: number): void {
    if (prevSection !== -1 && prevSection !== section) addSeparator()
    prevSection = section
  }

  /* The Tags group: a split "Tags" header — activating the row opens the Tags
   * page (tag:///) while the trailing chevron button collapses/expands the
   * group (state persisted in the tags database) — then one row per visible
   * tag that has files (colored dot + name). Hidden tags never show here;
   * empty tags live only on the Tags page. Files can be dropped on a tag row
   * to tag them. */
  function addTagRows(): void {
    if (!tagsService.enabled) return
    enterSection(SECTION_TAGS)
    const expanded = tagsService.getSetting(TAGS_EXPANDED_KEY, '1') === '1'

    const header = new Gtk.ListBoxRow({ focusOnClick: false })
    const headerFile = fileForUri('tag:///')
    header._file = headerFile
    const hb = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL })
    hb.append(new Gtk.Image({ iconName: tagIconName(), marginEnd: 8 }))
    hb.append(new Gtk.Label({ label: 'Tags', xalign: 0, hexpand: true }))
    /* The chevron is its own button (like the device rows' eject button), so
     * it toggles without activating the row. */
    const toggle = new Gtk.Button({
      iconName: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
      halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
      tooltipText: expanded ? 'Collapse' : 'Expand',
    })
    toggle.addCssClass('sidebar-button')
    toggle.addCssClass('flat')
    toggle.on('clicked', () => {
      tagsService.setSetting(TAGS_EXPANDED_KEY, expanded ? '0' : '1')
      build()
    })
    hb.append(toggle)
    header.setChild(hb)
    list.append(header)
    rows.push({ row: header, uri: headerFile.getUri() })
    if (!expanded) return

    const counts = tagsService.counts()
    for (const tag of tagsService.visibleTags()) {
      if ((counts.get(tag.name) ?? 0) === 0) continue
      const row = new Gtk.ListBoxRow({ focusOnClick: false })
      const file = fileForUri(tagUri(tag.name))
      row._file = file

      const b = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, marginStart: 10 })
      const dot = new Gtk.Box({ valign: Gtk.Align.CENTER, marginEnd: 10 })
      dot.addCssClass('mariner-sidebar-tag-dot')
      dot.addCssClass(tag.color ? 'tag-color-' + tag.color : 'mariner-tag-dot')
      b.append(dot)
      b.append(new Gtk.Label({ label: tag.name, xalign: 0, hexpand: true, ellipsize: 2, marginEnd: 2 }))
      row.setChild(b)

      /* Drop files on a tag row to apply that tag. */
      row.addController(makeDropTarget(files => tagsService.addTag(files, tag.name)))

      /* Right-click → Edit / Hide / Delete (like the Tags page's ⋮ menu). */
      const secondary = new Gtk.GestureClick({ button: 3 })
      secondary.on('pressed', (...a: any[]) => {
        const [x, y] = a.slice(-2)
        onTagMenu(tag.name, row, x, y)
      })
      row.addController(secondary)

      list.append(row)
      rows.push({ row, uri: file.getUri() })
    }

  }

  function build(): void {
    let c
    while ((c = list.getFirstChild()) !== null) list.remove(c)
    rows = []
    prevSection = -1
    for (const p of getPlaces()) if (!isHidden(p.id!)) addRow(p, SECTION_DEFAULT)
    if (!isHidden('bookmarks')) for (const p of getBookmarks()) addRow(p, SECTION_BOOKMARKS)
    if (!isHidden('tags')) addTagRows()
    if (!isHidden('computer')) addRow(getComputer(), SECTION_COMPUTER)
    if (!isHidden('devices')) for (const p of getDevices()) addRow(p, SECTION_MOUNTS)
    applyActive()
  }

  function applyActive(): void {
    list.unselectAll()
    if (activeUri == null) return
    const match = rows.find(r => r.uri === activeUri)
    if (match) list.selectRow(match.row)
  }

  function setActive(file: GFile): void {
    activeUri = file.getUri()
    applyActive()
  }

  build()
  /* Devices (mounted drives) come from the gvfs VolumeMonitor, whose first
   * access can block on a daemon autostart — so it's loaded off the first-paint
   * path (getDevices() returns [] until then). Rebuild once it's ready and on
   * every mount change, so plugging/unplugging a drive updates the sidebar. */
  initVolumeMonitor(build)
  /* Tag changes (assignments and registry alike) move counts and rows. */
  tagsService.on('changed', build)
  const scroll = new Gtk.ScrolledWindow({ child: list, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER })
  return { widget: scroll, setActive, refresh: build }
}

function safe(fn: () => boolean): boolean {
  try { return !!fn() } catch { return false }
}

function ejectMount(mount: any, eject: boolean): void {
  try {
    const flags = Gio.MountUnmountFlags.NONE
    if (eject) mount.ejectWithOperation(flags, null, null, () => {})
    else mount.unmountWithOperation(flags, null, null, () => {})
  } catch { /* best-effort */ }
}
