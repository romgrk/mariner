/* Per-user desktop integration for installs that don't come from a system
 * package manager (npm/pnpm global installs, source checkouts): copies the
 * .desktop entry and icons from data/ into XDG_DATA_HOME so Mariner appears
 * in the application menu. `--uninstall-desktop-entry` reverts it. Pure Node —
 * runs and exits before any GApplication setup (see main.ts). */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ID = 'com.github.romgrk.mariner'

const DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url))
/* Launcher shipped by the npm package; absent under system installs, which
 * provide /usr/bin/mariner instead (see packaging/aur/PKGBUILD). */
const LAUNCHER = fileURLToPath(new URL('../../bin/mariner.js', import.meta.url))

const ICON_DIRS = ['icons', 'hicolor', 'scalable', 'apps']
const SYMBOLIC_DIRS = ['icons', 'hicolor', 'symbolic', 'apps']

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')

const targets = {
  desktop: join(dataHome, 'applications', `${APP_ID}.desktop`),
  icon: join(dataHome, ...ICON_DIRS, `${APP_ID}.svg`),
  symbolic: join(dataHome, ...SYMBOLIC_DIRS, `${APP_ID}-symbolic.svg`),
}

/* Desktop Entry spec quoting: quote arguments containing reserved characters,
 * escaping the ones that stay special inside double quotes. */
function quoteExecArg(arg: string): string {
  if (!/[ \t"'\\><~|&;$*?#()`]/.test(arg)) return arg
  return '"' + arg.replace(/[\\"`$]/g, c => '\\' + c) + '"'
}

/* Absolute node + launcher paths: .desktop entries launch with a minimal
 * session PATH that rarely includes nvm/pnpm/npm-prefix bin dirs. */
function execLine(): string {
  if (existsSync(LAUNCHER))
    return `${quoteExecArg(process.execPath)} ${quoteExecArg(LAUNCHER)} %U`
  return 'mariner %U' // system install: launcher on PATH at /usr/bin/mariner
}

/* Refreshes the MimeType=inode/directory association; absent tool is fine —
 * desktops rescan ~/.local/share/applications on their own. */
function updateDesktopDatabase(): void {
  spawnSync('update-desktop-database', [join(dataHome, 'applications')], { stdio: 'ignore' })
}

export function install(): number {
  const entry = readFileSync(join(DATA_DIR, `${APP_ID}.desktop`), 'utf8')
    .replace(/^Exec=.*$/m, `Exec=${execLine()}`)
  mkdirSync(dirname(targets.desktop), { recursive: true })
  writeFileSync(targets.desktop, entry)

  for (const [target, source] of [
    [targets.icon, join(DATA_DIR, ...ICON_DIRS, `${APP_ID}.svg`)],
    [targets.symbolic, join(DATA_DIR, ...SYMBOLIC_DIRS, `${APP_ID}-symbolic.svg`)],
  ]) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }

  updateDesktopDatabase()
  console.log(`Installed:\n  ${Object.values(targets).join('\n  ')}`)
  console.log('\nTo also make Mariner the default file manager, see')
  console.log('https://github.com/romgrk/mariner/blob/master/docs/default-file-manager.md')
  return 0
}

export function uninstall(): number {
  for (const path of Object.values(targets)) rmSync(path, { force: true })
  updateDesktopDatabase()
  console.log(`Removed:\n  ${Object.values(targets).join('\n  ')}`)
  return 0
}
