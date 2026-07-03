/* --import hook that lets Mariner's TypeScript sources run from inside
 * node_modules (npm/pnpm global installs). Node's built-in type stripping
 * refuses .ts files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so this performs the same erasable-only strip via node:module regardless of
 * location. Line numbers are preserved (types are blanked, not removed). */
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file://') && url.endsWith('.ts')) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'))
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
