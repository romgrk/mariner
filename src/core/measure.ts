import { opendir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

export interface Usage { bytes: number; files: number; folders: number }

/* Recursively measure a local directory's disk usage, asynchronously and
 * cancellably (node fs — properties are only shown for local paths). onProgress
 * is called periodically and once more with done=true when complete. Symlinked
 * dirs are counted but not descended (cycle safety), matching the file walker. */
export function measureUsage(
  path: string,
  onProgress: (usage: Usage, done: boolean) => void,
  isCancelled: () => boolean,
): void {
  const usage: Usage = { bytes: 0, files: 0, folders: 0 }
  let sinceReport = 0

  const walk = async (dir: string): Promise<void> => {
    let handle
    try { handle = await opendir(dir) } catch { return }
    for await (const entry of handle) {
      if (isCancelled()) return
      const full = join(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) { usage.folders++; await walk(full) }
      else { usage.files++; try { usage.bytes += (await lstat(full)).size } catch { /* vanished */ } }
      if (++sinceReport >= 256) { sinceReport = 0; onProgress(usage, false) }
    }
  }

  walk(path).then(() => { if (!isCancelled()) onProgress(usage, true) })
}
