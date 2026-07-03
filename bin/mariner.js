#!/usr/bin/env node
/* Launcher for the `mariner` bin (see package.json "bin").
 *
 * Mirrors `npm start` (node --import node-gtk/register src/main.ts) but resolves
 * both the node-gtk register hook and main.ts to absolute paths, so it works
 * from any CWD once installed globally (`pnpm install -g .`). We re-exec node
 * rather than importing main.ts directly because --import must register the
 * `gi:` module hook before main.ts's top-level GTK imports are evaluated.
 * strip-types.mjs additionally lets the .ts sources run from under
 * node_modules, where Node's built-in type stripping refuses to. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const main = join(here, '..', 'src', 'main.ts')
const register = import.meta.resolve('node-gtk/register') // file:// URL, CWD-independent
const stripTypes = new URL('./strip-types.mjs', import.meta.url).href

const child = spawn(
  process.execPath,
  ['--import', stripTypes, '--import', register, main, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
