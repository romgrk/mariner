import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { formatBytes } from '../core/format.ts'
import { listComputerGroups, itemUsage } from '../services/computer-service.ts'
import { initVolumeMonitor } from '../services/volume-monitor.ts'
import { debugLog } from '../core/debug-log.ts' // TEMP-DIAG
import type { ComputerItem } from '../services/computer-service.ts'
import type { GFile } from '../core/types.ts'

/* The "Computer" interface: a grouped, nautilus-my-computer-style device
 * overview reached by navigating to computer:/// (the sidebar's Computer
 * entry). Devices come from computer-service's hybrid enumeration and render
 * as cards in a FlowBox grid under section headings (System / On this
 * Computer / Removable / Disc / Network): full-color drive icon, name, a
 * LevelBar showing usage, and a "N free of M" caption.
 *
 * Unmounted volumes appear as dimmed ghost cards ("Not mounted"); activating
 * one mounts it — auth/passphrase prompts routed through a GtkMountOperation —
 * then navigates into it. Removable cards carry an eject button.
 *
 * A pure view — clicking a mounted card calls onActivate(file) so the pane
 * navigates. The volume monitor's change signals rebuild the grid live, so
 * plugging/unplugging a drive updates the page without a manual refresh. */
export interface ComputerView {
  widget: any
  refresh: () => void
  onActivate: (file: GFile) => void
  onContextMenu: (file: GFile, widget: any, x: number, y: number) => void
}

export function createComputerView(): ComputerView {
  const content = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL, spacing: 12, valign: Gtk.Align.START,
    marginTop: 18, marginBottom: 18, marginStart: 18, marginEnd: 18,
  })
  content.addCssClass('computer-list')

  const empty = new Adw.StatusPage({ iconName: 'drive-harddisk-symbolic', title: 'No Drives Found' })

  /* A stack so the (rare) driveless case shows a status page instead of a blank. */
  const stack = new Gtk.Stack()
  stack.addNamed(new Gtk.ScrolledWindow({ child: content, vexpand: true, hexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }), 'drives')
  stack.addNamed(empty, 'empty')
  stack.addCssClass('computer-view')

  const api: ComputerView = { widget: stack, refresh, onActivate: () => {}, onContextMenu: () => {} }

  function refresh(): void {
    debugLog('diag', 'computer.refresh enter') // TEMP-DIAG
    let c
    while ((c = content.getFirstChild()) !== null) content.remove(c)
    const groups = listComputerGroups()
    for (const group of groups) {
      const title = new Gtk.Label({ label: group.title, xalign: 0, marginTop: groups[0] === group ? 0 : 8 })
      title.addCssClass('heading')
      content.append(title)

      const grid = new Gtk.FlowBox({
        selectionMode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        columnSpacing: 12, rowSpacing: 12,
        minChildrenPerLine: 1, maxChildrenPerLine: 4,
        valign: Gtk.Align.START,
      })
      for (const item of group.items) {
        const c = card(item)
        grid.append(c)
        /* FlowBox wraps children in a GtkFlowBoxChild with its own hover
         * background, padding and focus stop — the button is the card, so
         * neutralize the wrapper (background/padding killed in style.css). */
        c.getParent().setFocusable(false)
      }
      content.append(grid)
    }
    stack.setVisibleChildName(groups.length ? 'drives' : 'empty')
    debugLog('diag', 'computer.refresh exit') // TEMP-DIAG
  }

  function card(item: ComputerItem): any {
    const btn = new Gtk.Button()
    btn.addCssClass('computer-card')
    btn.addCssClass('flat')
    if (!item.mounted) btn.addCssClass('computer-card-ghost')
    btn.setTooltipText(item.tooltip)

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
    box.append(new Gtk.Image({ gicon: item.icon, pixelSize: 48, valign: Gtk.Align.CENTER }))

    const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true, valign: Gtk.Align.CENTER })
    const name = new Gtk.Label({ label: item.name, xalign: 0, ellipsize: 3 /* END */ })
    name.addCssClass('computer-card-name')
    info.append(name)

    const caption = new Gtk.Label({ label: item.mounted ? '' : 'Not mounted', xalign: 0, ellipsize: 3 })
    caption.addCssClass('computer-card-caption')
    caption.addCssClass('dim-label')

    if (item.mounted) {
      const bar = usageBar()
      info.append(bar)
      itemUsage(item).then(u => {
        bar.setValue(u.fraction)
        caption.setLabel(`${formatBytes(u.free)} free of ${formatBytes(u.total)}`)
      }).catch(() => {
        bar.setVisible(false)
        caption.setLabel(item.tooltip)
      })
    }
    info.append(caption)
    box.append(info)

    btn.setChild(box)
    btn.on('clicked', () => {
      if (item.file) api.onActivate(item.file)
      else if (item.volume) mountAndOpen(item, btn, caption)
    })

    /* Right-click → drive context menu (Open / Analyze Disk Usage / Properties);
     * only meaningful once there is a location to act on. */
    if (item.file) {
      const file = item.file
      const secondary = new Gtk.GestureClick({ button: 3 })
      secondary.on('pressed', (...a: any[]) => {
        const [x, y] = a.slice(-2)
        api.onContextMenu(file, btn, x, y)
      })
      btn.addController(secondary)
    }

    /* Eject/unmount on removable cards — overlaid on the card, not nested in
     * it: a GtkButton inside a GtkButton mis-delivers the click to the card
     * (which navigated instead of ejecting). As an overlay sibling it owns
     * its clicks outright. */
    if (item.canEject || item.canUnmount) {
      box.setMarginEnd(36)
      const overlay = new Gtk.Overlay()
      overlay.setChild(btn)
      const eject = new Gtk.Button({
        iconName: 'media-eject-symbolic',
        halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
        marginEnd: 10,
        tooltipText: item.canEject ? 'Eject' : 'Unmount',
      })
      eject.addCssClass('flat')
      eject.on('clicked', () => ejectItem(item))
      overlay.addOverlay(eject)
      return overlay
    }

    return btn
  }

  /* Usage LevelBar: the stock low/high/full offsets are battery-style (low =
   * red); replace them with fill-style thresholds — accent until 90%, warning
   * to 98%, critical above (colored in style.css). */
  function usageBar(): any {
    const bar = new Gtk.LevelBar({ maxValue: 1 })
    bar.addCssClass('computer-card-bar')
    for (const stock of ['low', 'high', 'full'])
      try { bar.removeOffsetValue(stock) } catch { /* absent on this GTK */ }
    bar.addOffsetValue('fill-normal', 0.9)
    bar.addOffsetValue('fill-warning', 0.98)
    bar.addOffsetValue('fill-critical', 1.0)
    return bar
  }

  /* Mount a ghost volume, then navigate into it. The GtkMountOperation gives
   * gvfs/udisks a native dialog for passphrases and credentials. On success
   * the monitor's mount-added signal also rebuilds the whole grid. */
  function mountAndOpen(item: ComputerItem, btn: any, caption: any): void {
    btn.setSensitive(false)
    let op: any = null
    try { op = new Gtk.MountOperation({ parent: btn.getRoot() }) } catch { /* headless */ }
    const fail = (message: string) => {
      btn.setSensitive(true)
      /* A dismissed auth dialog is the user changing their mind, not an error. */
      if (/cancel|dismiss/i.test(message)) return
      caption.setLabel(message)
      caption.removeCssClass('dim-label')
      caption.addCssClass('error')
      btn.setTooltipText(message)
    }
    try {
      item.volume.mount(0 /* MountMountFlags.NONE */, op, null, (_src: any, res: any) => {
        try {
          item.volume.mountFinish(res)
          const mount = item.volume.getMount()
          if (mount) api.onActivate(mount.getRoot())
          else btn.setSensitive(true)
        } catch (e: any) {
          fail(e?.message ?? 'Mount failed')
        }
      })
    } catch (e: any) {
      fail(e?.message ?? 'Mount failed')
    }
  }

  function ejectItem(item: ComputerItem): void {
    try {
      const flags = 0 /* Gio.MountUnmountFlags.NONE */
      if (item.mount && item.canEject) item.mount.ejectWithOperation(flags, null, null, () => {})
      else if (item.mount) item.mount.unmountWithOperation(flags, null, null, () => {})
      else if (item.volume?.canEject()) item.volume.eject(flags, null, () => {})
    } catch { /* best-effort */ }
  }

  refresh()
  /* Rebuild on every mount/volume/drive change (and once the monitor first
   * becomes available, which upgrades the /proc/mounts-only initial view). */
  initVolumeMonitor(refresh)
  return api
}
