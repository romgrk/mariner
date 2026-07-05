import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { listPartitions, diskUsage } from '../core/drives.ts'
import { fileForPath } from '../core/gio.ts'
import { volumeMonitor } from './volume-monitor.ts'
import type { DiskUsage } from '../core/drives.ts'
import type { GFile } from '../core/types.ts'

/* Enumeration behind the Computer page, hybrid by necessity:
 *
 *  - /proc/mounts (core/drives.ts) is the source of truth for mounted block
 *    partitions. The GVolumeMonitor deliberately hides anything udisks marks
 *    HintSystem — root, /boot, the EFI partition — so a monitor-only page
 *    would miss the machine's main drives.
 *  - The GVolumeMonitor contributes everything /proc/mounts can't see: the
 *    *unmounted* volumes (shown as ghost cards, mountable on click), the
 *    removable/optical classification, proper themed icons, eject handles,
 *    and the non-block gvfs mounts (smb/sftp/mtp/…).
 *
 * Items found by both sources (a mounted USB stick) are merged by device node:
 * the partition row keeps its mount data, the volume overlays icon, group and
 * eject/unmount handles. */

export type ComputerGroupId = 'system' | 'internal' | 'removable' | 'disc' | 'network'

export interface ComputerItem {
  name: string
  icon: any                  /* GIcon (full-color themed icon) */
  file: GFile | null         /* navigation target — null while unmounted */
  mountPath: string | null   /* local path, for the statfs usage query */
  tooltip: string
  mounted: boolean
  volume: any | null         /* GVolume — mount-on-click for ghost cards */
  mount: any | null          /* GMount — unmount/eject */
  canEject: boolean
  canUnmount: boolean
}

export interface ComputerGroup {
  id: ComputerGroupId
  title: string
  items: ComputerItem[]
}

const GROUP_ORDER: ComputerGroupId[] = ['system', 'internal', 'removable', 'disc', 'network']
const GROUP_TITLES: Record<ComputerGroupId, string> = {
  system: 'System',
  internal: 'On this Computer',
  removable: 'Removable',
  disc: 'Disc',
  network: 'Network',
}

/* Phone/camera gvfs mounts belong with the removable devices, not the network. */
const DEVICE_SCHEMES = new Set(['mtp', 'gphoto2', 'afc'])

interface Classified extends ComputerItem { group: ComputerGroupId }

export function listComputerGroups(): ComputerGroup[] {
  const items: Classified[] = []
  const byDevice = new Map<string, Classified>()

  /* Mounted block partitions — always available, even before the volume
   * monitor has initialized (its first access is deferred off first-paint). */
  for (const p of listPartitions()) {
    const item: Classified = {
      name: p.label,
      icon: themedIcon(p.mountPath === '/'
        ? ['drive-harddisk-system', 'drive-harddisk']
        : ['drive-harddisk']),
      file: fileForPath(p.mountPath),
      mountPath: p.mountPath,
      tooltip: `${p.mountPath} · ${p.device} · ${p.fsType}`,
      mounted: true,
      volume: null, mount: null, canEject: false, canUnmount: false,
      group: isSystemMount(p.mountPath) ? 'system'
        : isOpticalFs(p.device, p.fsType) ? 'disc' : 'internal',
    }
    items.push(item)
    byDevice.set(p.device, item)
  }

  const mon = volumeMonitor()
  if (mon) {
    /* Volumes: enrich the partition rows (icons, grouping, eject handles) and
     * surface the unmounted ones as ghost items. */
    for (const v of safeList(() => mon.getVolumes())) {
      const dev = safe(() => v.getIdentifier('unix-device'), null)
      const mount = safe(() => v.getMount(), null)
      const drive = safe(() => v.getDrive(), null)
      const removable = drive != null &&
        (safe(() => drive.isRemovable(), false) || safe(() => drive.canEject(), false))
      const icon = safe(() => v.getIcon(), null)
      const optical = isOpticalIcon(icon) || (dev != null && isOpticalFs(dev, ''))

      const existing = dev != null ? byDevice.get(dev) : undefined
      if (existing) {
        existing.volume = v
        if (icon) existing.icon = icon
        if (mount) {
          existing.mount = mount
          existing.canEject = safe(() => mount.canEject(), false)
          existing.canUnmount = safe(() => mount.canUnmount(), false)
        }
        if (optical) existing.group = 'disc'
        else if (removable && existing.group === 'internal') existing.group = 'removable'
        continue
      }

      /* Mounted volumes with no /proc/mounts row are gvfs-backed; the mounts
       * pass below picks those up. Here: only the ghosts. */
      if (mount) continue
      items.push({
        name: safe(() => v.getName(), dev ?? 'Volume'),
        icon: icon ?? themedIcon(['drive-harddisk']),
        file: null,
        mountPath: null,
        tooltip: dev ?? 'Not mounted',
        mounted: false,
        volume: v, mount: null,
        canEject: safe(() => v.canEject(), false), canUnmount: false,
        group: optical ? 'disc' : removable ? 'removable' : 'internal',
      })
    }

    /* Non-block gvfs mounts: network shares, phones, cameras. Block-device
     * mounts have file:// roots and are already covered above. */
    for (const m of safeList(() => mon.getMounts())) {
      if (safe(() => m.isShadowed(), false)) continue
      const root = safe(() => m.getRoot(), null)
      const uri: string = root ? safe(() => root.getUri(), '') : ''
      if (!uri || uri.startsWith('file:')) continue
      items.push({
        name: safe(() => m.getName(), uri),
        icon: safe(() => m.getIcon(), null) ?? themedIcon(['folder-remote']),
        file: root,
        mountPath: safe(() => root.getPath(), null),
        tooltip: uri,
        mounted: true,
        volume: null, mount: m,
        canEject: safe(() => m.canEject(), false),
        canUnmount: safe(() => m.canUnmount(), false),
        group: DEVICE_SCHEMES.has(uri.split(':')[0]) ? 'removable' : 'network',
      })
    }
  }

  return GROUP_ORDER
    .map(id => ({ id, title: GROUP_TITLES[id], items: items.filter(it => it.group === id) }))
    .filter(g => g.items.length > 0)
}

/* Live capacity for a card: statfs for anything with a local path, the async
 * gio filesystem-info query for gvfs mounts without one (no fuse bridge). */
export function itemUsage(item: ComputerItem): Promise<DiskUsage> {
  if (item.mountPath != null) return diskUsage(item.mountPath)
  if (item.file != null) return gioFsUsage(item.file)
  return Promise.reject(new Error('not mounted'))
}

function gioFsUsage(file: GFile): Promise<DiskUsage> {
  return new Promise((resolve, reject) => {
    try {
      file.queryFilesystemInfoAsync('filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, null,
        (_src: any, res: any) => {
          try {
            const info = file.queryFilesystemInfoFinish(res)
            /* uint64 attributes come back as BigInt through node-gtk. */
            const total = Number(info.getAttributeUint64('filesystem::size'))
            const free = Number(info.getAttributeUint64('filesystem::free'))
            if (!total) return reject(new Error('no filesystem size info'))
            const used = Math.max(0, total - free)
            resolve({ total, free, used, fraction: used / total })
          } catch (e) { reject(e) }
        })
    } catch (e) { reject(e) }
  })
}

/* Root and the boot/EFI partitions — the "System" group. */
function isSystemMount(mountPath: string): boolean {
  return mountPath === '/' || mountPath === '/boot' || mountPath.startsWith('/boot/')
    || mountPath === '/efi' || mountPath.startsWith('/efi/')
}

function isOpticalFs(device: string, fsType: string): boolean {
  return /^\/dev\/sr\d+$/.test(device) || device === '/dev/cdrom'
    || fsType === 'iso9660' || fsType === 'udf'
}

function isOpticalIcon(icon: any): boolean {
  const names = safe(() => icon?.getNames?.(), null)
  return Array.isArray(names) && names.some((n: string) => n.includes('optical'))
}

/* A GIcon over the given names — the theme picks the first one it has. */
function themedIcon(names: string[]): any {
  return Gio.ThemedIcon.newFromNames(names)
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() ?? fallback } catch { return fallback }
}

function safeList(fn: () => any[]): any[] {
  try { return fn() ?? [] } catch { return [] }
}
