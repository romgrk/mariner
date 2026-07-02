import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import Pango from 'gi:Pango-1.0'
import { HOME } from '../core/format.ts'
import { archiveName } from '../core/archive-uri.ts'
import { volumeMonitor } from '../services/volume-monitor.ts'
import type { GFile } from '../core/types.ts'

/* Breadcrumb path bar — a faithful port of nautilus's NautilusPathBar
 * (src/nautilus-pathbar.c). Structure:
 *
 *   Box .linked .mariner-pathbar
 *     ScrolledWindow (hpolicy EXTERNAL, vpolicy NEVER, hexpand)
 *       Box buttons_box           <- one container per ancestor crumb
 *     MenuButton .flat            <- "view-more" current-folder menu
 *
 * Special roots (Home, filesystem root, trash, recent, mounts, …) render as an
 * icon + bold label; normal folders render as a dim "/" separator + bold label.
 * The current directory gets `.current-dir`, expands, and opens the location
 * entry on click (like nautilus's toolbar.edit-location). Middle-click opens a
 * crumb in a new tab, Ctrl+click in a new window, right-click shows a context
 * menu (Open in New Window/Tab, Properties). */

export interface PathBarHandlers {
  onNavigate: (file: GFile) => void
  onOpenTab: (file: GFile) => void
  onOpenWindow: (file: GFile) => void
  onProperties: (file: GFile) => void
}

export interface PathBar {
  widget: any
  setLocation: (file: GFile) => void
}

const ELLIPSIZE_MINIMUM_CHARS = 7

const MOD = Gdk.ModifierType
const DEFAULT_MOD_MASK =
  MOD.CONTROL_MASK | MOD.SHIFT_MASK | MOD.ALT_MASK | MOD.SUPER_MASK

type BtnType =
  | 'normal' | 'root' | 'admin' | 'home' | 'starred' | 'recent'
  | 'mount' | 'trash' | 'network' | 'computer' | 'burn' | 'archive'

interface Crumb {
  type: BtnType
  name: string
  iconName: string | null
  gicon: any | null
  isRoot: boolean
}

/* nautilus icon names (src/nautilus-icon-names.h). */
const ICON_FILESYSTEM = 'drive-harddisk-symbolic'
const ICON_HOME = 'user-home-symbolic'
const ICON_REMOTE = 'folder-remote-symbolic'

function osName(): string {
  try {
    const key = (GLib as any).OS_INFO_KEY_NAME ?? 'NAME'
    return GLib.getOsInfo(key) || 'Operating System'
  } catch {
    return 'Operating System'
  }
}

/* Uses the cached VolumeMonitor (see volume-monitor.ts) rather than
 * Gio.VolumeMonitor.get(): classify() runs on the synchronous window-build path,
 * and the first get() can block for ~25s on a gvfs daemon autostart. Until the
 * monitor is ready a mount root simply classifies as a normal folder. */
function mountForRoot(file: GFile): any | null {
  const mon = volumeMonitor()
  if (!mon) return null
  try {
    for (const m of mon.getMounts())
      if (m.getRoot().equal(file)) return m
  } catch {}
  return null
}

/* Mirrors setup_button_type() + get_gicon() + get_dir_name(): classify a
 * location into a button type with its icon and display name, and whether it is
 * a "root" (which stops the ancestor walk — nautilus never shows crumbs above
 * Home, the filesystem root, a mount, trash, recent, …). */
function classify(file: GFile): Crumb {
  const path = file.getPath()
  const scheme = (file.getUriScheme() || '').toLowerCase()
  const isSchemeRoot = !file.getParent()

  if (path === '/')
    return { type: 'root', name: osName(), iconName: ICON_FILESYSTEM, gicon: null, isRoot: true }
  if (path === HOME)
    return { type: 'home', name: 'Home', iconName: ICON_HOME, gicon: null, isRoot: true }
  if (scheme === 'recent')
    return { type: 'recent', name: 'Recent', iconName: 'document-open-recent-symbolic', gicon: null, isRoot: true }
  if (scheme === 'starred')
    return { type: 'starred', name: 'Starred', iconName: 'starred-symbolic', gicon: null, isRoot: true }

  const mount = mountForRoot(file)
  if (mount)
    return { type: 'mount', name: mount.getName(), iconName: null, gicon: safeGicon(mount), isRoot: true }

  if (scheme === 'admin' && isSchemeRoot)
    return { type: 'admin', name: 'Administrator Root', iconName: ICON_FILESYSTEM, gicon: null, isRoot: true }
  if (scheme === 'trash' && isSchemeRoot)
    return { type: 'trash', name: 'Trash', iconName: 'user-trash-symbolic', gicon: null, isRoot: true }
  if ((scheme === 'network' || scheme === 'network-view') && isSchemeRoot)
    return { type: 'network', name: 'Network', iconName: ICON_REMOTE, gicon: null, isRoot: true }
  if (scheme === 'computer' && isSchemeRoot)
    return { type: 'computer', name: 'Computer', iconName: 'computer-symbolic', gicon: null, isRoot: true }
  /* An archive browsed in place (archive://) — its root is the archive file;
   * label it with the archive's name and stop the ancestor walk there. */
  if (scheme === 'archive' && isSchemeRoot)
    return { type: 'archive', name: archiveName(file) || file.getBasename() || 'Archive', iconName: 'package-x-generic-symbolic', gicon: null, isRoot: true }
  if (scheme === 'burn' && isSchemeRoot)
    return { type: 'burn', name: file.getBasename() || 'CD/DVD Creator', iconName: null, gicon: null, isRoot: true }

  return { type: 'normal', name: file.getBasename() || '/', iconName: null, gicon: null, isRoot: false }
}

function safeGicon(mount: any): any | null {
  try { return mount.getSymbolicIcon() } catch { return null }
}

/* onNavigate/… wire clicks back to the window. */
export function createPathBar(handlers: PathBarHandlers): PathBar {
  const box = new Gtk.Box({ valign: Gtk.Align.CENTER })
  box.addCssClass('linked')
  box.addCssClass('mariner-pathbar')

  const scrolled = new Gtk.ScrolledWindow({ hexpand: true })
  /* Scroll horizontally only, no internal scrollbar (nautilus). */
  scrolled.setPolicy(Gtk.PolicyType.EXTERNAL, Gtk.PolicyType.NEVER)
  /* Report the crumbs' natural extent so the bar sizes to content and, when it
   * overflows the available width, shrinks + scrolls (the current-dir button
   * hexpands to take any slack when the bar is given the full header width). */
  scrolled.setPropagateNaturalWidth(true)
  scrolled.setPropagateNaturalHeight(true)

  const buttonsBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 })
  scrolled.setChild(buttonsBox)
  box.append(scrolled)

  /* Vertical mouse-wheel scrolls the crumbs horizontally. */
  const scroll = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
  scroll.on('scroll', (...a: any[]) => {
    const dy = a[a.length - 1]
    if (!dy) return false
    const adj = scrolled.getHadjustment()
    adj.setValue(adj.getValue() + dy * adj.getStepIncrement())
    return true
  })
  scrolled.addController(scroll)

  /* Auto-scroll to the end so the current folder stays visible. */
  scrolled.getHadjustment().on('changed', () => {
    const last = buttonsBox.getLastChild()
    const vp = scrolled.getChild()
    if (last && vp && vp.scrollTo) { try { vp.scrollTo(last, null) } catch {} }
  })

  /* "view-more" current-folder menu button at the end of the bar. */
  const menuButton = new Gtk.MenuButton({
    iconName: 'view-more-symbolic',
    menuModel: buildCurrentViewMenu(),
    tooltipText: 'Current Folder Menu',
  })
  menuButton.addCssClass('flat')
  box.append(menuButton)

  /* pathbar.* action group backing the crumb context menu, operating on the
   * last right-clicked crumb (nautilus's context_menu_file). */
  let contextFile: GFile | null = null
  const buttonMenu = Gio.Menu.new()
  buttonMenu.append('Open in New _Window', 'pathbar.open-item-new-window')
  buttonMenu.append('Open in New _Tab', 'pathbar.open-item-new-tab')
  buttonMenu.append('_Properties', 'pathbar.properties')

  const actions = new Gio.SimpleActionGroup()
  const addAction = (name: string, cb: (f: GFile) => void): void => {
    const a = Gio.SimpleAction.new(name, null)
    a.on('activate', () => { if (contextFile) cb(contextFile) })
    actions.addAction(a)
  }
  addAction('open-item-new-window', f => handlers.onOpenWindow(f))
  addAction('open-item-new-tab', f => handlers.onOpenTab(f))
  addAction('properties', f => handlers.onProperties(f))
  box.insertActionGroup('pathbar', actions)

  function popContextMenu(button: any, file: GFile, x: number, y: number): void {
    contextFile = file
    const pop = Gtk.PopoverMenu.newFromModel(buttonMenu)
    pop.setParent(button)
    pop.setHasArrow(false)
    pop.setHalign(Gtk.Align.START)
    try {
      const r = new Gdk.Rectangle()
      r.x = Math.round(x); r.y = Math.round(y); r.width = 1; r.height = 1
      pop.setPointingTo(r)
    } catch {}
    /* GtkPopoverMenu activates the chosen item's action AFTER "closed" fires;
     * unparenting synchronously strands the `pathbar` action group and the
     * deferred activation silently no-ops. Defer the cleanup past activation. */
    pop.on('closed', () => GLib.timeoutAdd(GLib.PRIORITY_DEFAULT_IDLE, 100, () => {
      try { pop.unparent() } catch {}
      return false
    }))
    pop.popup()
  }

  function clear(): void {
    let c
    while ((c = buttonsBox.getFirstChild()) !== null) buttonsBox.remove(c)
  }

  function makeButton(file: GFile, crumb: Crumb, isCurrent: boolean): any {
    const button = new Gtk.Button({ focusOnClick: false })
    button.addCssClass('mariner-path-button')

    const image = new Gtk.Image()
    const label = new Gtk.Label({ singleLineMode: true })
    let container: any
    let child: any

    if (crumb.type === 'normal') {
      const separator = new Gtk.Label({ label: '/' })
      separator.addCssClass('dim-label')
      child = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 })
      container = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 })
      container.append(separator)
      container.append(button)
      child.append(label)
    } else {
      if (crumb.gicon) image.setFromGicon(crumb.gicon)
      else if (crumb.iconName) image.setFromIconName(crumb.iconName)
      child = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
      container = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
      container.append(button)
      child.append(image)
      child.append(label)
    }

    if (isCurrent) {
      button.addCssClass('current-dir')
      button.setHexpand(true)
      label.setHalign(Gtk.Align.START)
      /* Clicking the current folder opens the editable location entry. */
      button.setActionName('win.location')
    } else {
      label.addCssClass('dim-label')
      image.addCssClass('dim-label')
    }

    updateAppearance(button, label, crumb.name, isCurrent)
    button.setChild(child)

    if (!isCurrent) button.on('clicked', () => handlers.onNavigate(file))
    attachGesture(button, file, isCurrent)

    return container
  }

  function attachGesture(button: any, file: GFile, isCurrent: boolean): void {
    const gesture = new Gtk.GestureClick({ button: 0 })
    gesture.on('pressed', (...a: any[]) => {
      const [x, y] = a.slice(-2)
      const btn = gesture.getCurrentButton()
      const state = gesture.getCurrentEventState()
      if (btn === 2 /* middle */) {
        if ((state & DEFAULT_MOD_MASK) === 0) {
          gesture.setState(Gtk.EventSequenceState.CLAIMED)
          handlers.onOpenTab(file)
        }
      } else if (btn === 3 /* right */) {
        if (isCurrent) return
        gesture.setState(Gtk.EventSequenceState.CLAIMED)
        popContextMenu(button, file, x, y)
      } else if (btn === 1 /* left */) {
        if (state & MOD.CONTROL_MASK) {
          gesture.setState(Gtk.EventSequenceState.CLAIMED)
          handlers.onOpenWindow(file)
        }
        /* plain primary: let GtkButton emit "clicked" (navigate / edit-location) */
      }
    })
    button.addController(gesture)
  }

  function setLocation(file: GFile): void {
    clear()
    /* Walk up from the current location to the nearest root, then render
     * root-first (current folder last / rightmost). */
    const chain: Array<{ file: GFile; crumb: Crumb; current: boolean }> = []
    let f: GFile | null = file
    let first = true
    while (f) {
      const crumb = classify(f)
      chain.unshift({ file: f, crumb, current: first })
      first = false
      if (crumb.isRoot) break
      f = f.getParent()
    }
    for (const c of chain) buttonsBox.append(makeButton(c.file, c.crumb, c.current))
  }

  return { widget: box, setLocation }
}

/* Set the label text/tooltip and middle-ellipsize long names, matching
 * nautilus_path_bar_update_button_appearance(): a 7-char floor (28 for the
 * current dir), only ellipsizing when the name exceeds 1.5× that floor. */
function updateAppearance(button: any, label: any, name: string, isCurrent: boolean): void {
  label.setText(name)
  button.setTooltipText(name)
  const minChars = isCurrent ? 4 * ELLIPSIZE_MINIMUM_CHARS : ELLIPSIZE_MINIMUM_CHARS
  if ([...name].length > minChars * 1.5) {
    label.setWidthChars(minChars)
    label.setEllipsize(Pango.EllipsizeMode.MIDDLE)
  } else {
    label.setWidthChars(-1)
    label.setEllipsize(Pango.EllipsizeMode.NONE)
  }
}

/* The current-folder menu shown by the "view-more" button. Mirrors nautilus's
 * current-view-menu, wired to this app's window actions. */
function buildCurrentViewMenu(): any {
  const menu = Gio.Menu.new()

  const s1 = Gio.Menu.new()
  s1.append('New _Folder…', 'win.new-folder')
  s1.append('Open in _Terminal', 'win.open-terminal')
  menu.appendSection(null, s1)

  const s2 = Gio.Menu.new()
  s2.append('R_eload', 'win.reload')
  s2.append('_Paste', 'win.paste')
  s2.append('Select _All', 'win.select-all')
  menu.appendSection(null, s2)

  const s3 = Gio.Menu.new()
  s3.append('Empty _Trash…', 'win.empty-trash')
  menu.appendSection(null, s3)

  const s4 = Gio.Menu.new()
  s4.append('P_roperties', 'win.properties')
  menu.appendSection(null, s4)

  return menu
}
