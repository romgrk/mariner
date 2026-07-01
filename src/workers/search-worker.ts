/* Pure-node recursive search worker. Runs as its own process (no node-gtk):
 *
 *   node search-worker.ts <rootDir> <query> <showHidden:0|1>
 *
 * Emits one JSON-encoded absolute path per line on stdout for each entry whose
 * name contains <query> (case-insensitive). Walks BREADTH-FIRST via a FIFO
 * queue (mirroring nautilus's nautilus-search-engine-simple.c, which uses
 * g_queue_push_tail + g_queue_pop_head) so matches nearest the search root
 * surface first. Skips symlinked dirs (cycle safety) and silently skips
 * unreadable directories. */
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

const [, , root = process.cwd(), query = '', hiddenArg = '0'] = process.argv
const showHidden = hiddenArg === '1'
const needle = query.toLowerCase()

function emit(line: string): Promise<void> {
  /* Respect stdout backpressure so we never drop results on large trees. */
  return process.stdout.write(line)
    ? Promise.resolve()
    : new Promise<void>(resolve => process.stdout.once('drain', () => resolve()))
}

/* Enumerate one directory: emit its matches, return its subdirectories. */
async function visit(dir: string): Promise<string[]> {
  const subdirs: string[] = []
  let handle
  try { handle = await opendir(dir) }
  catch { return subdirs }   /* permission denied, vanished, not a dir — skip */
  for await (const entry of handle) {
    if (!showHidden && entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (!needle || entry.name.toLowerCase().includes(needle))
      await emit(JSON.stringify(full) + '\n')
    if (entry.isDirectory() && !entry.isSymbolicLink())
      subdirs.push(full)
  }
  return subdirs
}

/* Breadth-first walk: a FIFO queue processed via a moving head index (avoids
 * O(n²) Array.shift). Every match at depth N is emitted before any at depth
 * N+1, so results appear expanding outward from the search root. */
async function walk(start: string): Promise<void> {
  const queue = [start]
  for (let head = 0; head < queue.length; head++)
    queue.push(...await visit(queue[head]))
}

walk(root)
  .then(() => process.exit(0))
  .catch((err: any) => { process.stderr.write(String(err?.message || err) + '\n'); process.exit(1) })
