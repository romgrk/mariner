/* Pure-node recursive search worker. Runs as its own process (no node-gtk):
 *
 *   node search-worker.ts <rootDir> <query> <showHidden:0|1>
 *
 * Emits one JSON-encoded absolute path per line on stdout for each entry whose
 * name contains <query> (case-insensitive). Walks depth-first, skips symlinked
 * dirs (cycle safety), and silently skips unreadable directories. */
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

async function walk(dir: string): Promise<void> {
  let handle
  try { handle = await opendir(dir) }
  catch { return }   /* permission denied, vanished, not a dir — skip */
  for await (const entry of handle) {
    if (!showHidden && entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (!needle || entry.name.toLowerCase().includes(needle))
      await emit(JSON.stringify(full) + '\n')
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await walk(full)
  }
}

walk(root)
  .then(() => process.exit(0))
  .catch((err: any) => { process.stderr.write(String(err?.message || err) + '\n'); process.exit(1) })
