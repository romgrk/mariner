import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/* A mounted block-device partition (a "drive" in the Computer section). Derived
 * from /proc/mounts, filtered to real disks (pseudo/virtual filesystems and snap
 * loopbacks dropped). `label` is the udev volume label when available, else a
 * name derived from the mount point or device. */
export interface Partition {
  device: string     /* /dev/sda2 */
  mountPath: string  /* / */
  fsType: string     /* ext4 */
  label: string
}

/* Live capacity of a filesystem. `free` is space available to the user (reserved
 * blocks count as used, so used + free === total and the bar reads honestly). */
export interface DiskUsage {
  total: number
  free: number
  used: number
  fraction: number   /* used / total, 0..1 */
}

/* /proc/mounts octal-escapes spaces (\040), tabs (\011), newlines (\012) and
 * backslashes (\134) in the device and mount-point fields. */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
}

/* /dev/disk/by-label names udev-encode non-alnum bytes as \x2d etc. */
function decodeLabelName(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/* Reverse map from a canonical device node to its filesystem label, built from
 * the /dev/disk/by-label symlinks. Best-effort: absent/unreadable → empty. */
function labelMap(): Map<string, string> {
  const map = new Map<string, string>()
  const dir = '/dev/disk/by-label'
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return map }
  for (const name of names) {
    try {
      const target = resolve(dir, readlinkSync(join(dir, name)))
      map.set(target, decodeLabelName(name))
    } catch { /* dangling link */ }
  }
  return map
}

/* The distro's pretty name, for labelling the root partition Windows-style
 * (e.g. "Arch Linux" rather than a bare "/"). Node-only, best-effort. */
function osName(): string {
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    const m = text.match(/^PRETTY_NAME="?(.*?)"?$/m) || text.match(/^NAME="?(.*?)"?$/m)
    return m ? m[1] : ''
  } catch { return '' }
}

function driveLabel(device: string, mountPath: string, labels: Map<string, string>): string {
  const label = labels.get(device)
  if (label) return label
  if (mountPath === '/') return osName() || 'Filesystem root'
  return basename(mountPath) || basename(device) || device
}

/* Enumerate the machine's drives/partitions from /proc/mounts, one row per
 * block device (btrfs subvolumes and other repeat mounts of the same device
 * collapse to their first — primary — mount point). Ordered root-first, then by
 * mount path. Non-block pseudo filesystems and snap/squashfs loopbacks are
 * excluded — this is the Windows-Explorer-style "This PC" drive list. */
export function listPartitions(): Partition[] {
  let text = ''
  try { text = readFileSync('/proc/mounts', 'utf8') } catch { return [] }
  const labels = labelMap()
  const seen = new Set<string>()
  const out: Partition[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const f = line.split(' ')
    if (f.length < 3) continue
    const device = unescapeMount(f[0])
    const mountPath = unescapeMount(f[1])
    const fsType = f[2]
    if (!device.startsWith('/dev/')) continue        /* skip proc, sysfs, tmpfs, … */
    if (device.startsWith('/dev/loop')) continue      /* skip snap/squashfs loopbacks */
    if (fsType === 'squashfs') continue
    if (seen.has(device)) continue                    /* one row per physical partition */
    seen.add(device)
    out.push({ device, mountPath, fsType, label: driveLabel(device, mountPath, labels) })
  }
  out.sort((a, b) =>
    a.mountPath === '/' ? -1 : b.mountPath === '/' ? 1 : a.mountPath.localeCompare(b.mountPath))
  return out
}

/* Filesystem type of the mount containing `path` — longest mount-point match
 * over /proc/mounts, '' when unknown. */
export function fsTypeForPath(path: string): string {
  let text = ''
  try { text = readFileSync('/proc/mounts', 'utf8') } catch { return '' }
  let best = ''
  let bestLen = -1
  for (const line of text.split('\n')) {
    const f = line.split(' ')
    if (f.length < 3) continue
    const mountPath = unescapeMount(f[1])
    if (mountPath.length <= bestLen) continue
    if (path === mountPath || path.startsWith(mountPath.endsWith('/') ? mountPath : mountPath + '/')) {
      best = f[2]
      bestLen = mountPath.length
    }
  }
  return best
}

/* True when `path` lives on a filesystem whose metadata operations can stall
 * for seconds behind other I/O — a single-threaded FUSE daemon (ntfs-3g, the
 * gvfs fuse bridge) or a network filesystem. Callers avoid main-thread
 * blocking calls (the sync inotify attach) and whole-tree scans (du) there. */
export function isSlowFs(path: string): boolean {
  return /^(fuse|nfs|cifs|smb|9p|afs)/.test(fsTypeForPath(path))
}

/* Query a mounted filesystem's live usage. Rejects if the path is unreachable. */
export async function diskUsage(mountPath: string): Promise<DiskUsage> {
  const s = await statfs(mountPath)
  const total = s.blocks * s.bsize
  const free = s.bavail * s.bsize
  const used = Math.max(0, total - free)
  return { total, free, used, fraction: total > 0 ? used / total : 0 }
}
