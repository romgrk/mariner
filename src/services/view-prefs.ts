import GLib from 'gi:GLib-2.0'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { defaultColumnConfig, normalizeColumns } from '../core/columns.ts'
import { SIDEBAR_ITEMS } from './places-service.ts'
import type { ColumnConfig, ViewMode } from '../core/types.ts'

const DIR = GLib.getUserConfigDir() + '/mariner'
const FILE = DIR + '/view-prefs.json'

/* The view choices we persist across runs: grid-vs-list mode, the list-view's
 * visible/ordered columns, which sidebar items/sections are hidden, and the
 * (opt-in) folder-sizes feature with its cache TTL. */
export interface ViewPrefs {
  viewMode: ViewMode
  columns: ColumnConfig[]
  sidebarHidden: string[]
  dirSizes: boolean
  dirSizesTtl: number
}

const DEFAULT_TTL = 15   /* minutes */

function normalizeTtl(raw: unknown): number {
  const n = Math.round(Number(raw))
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : DEFAULT_TTL
}

/* Drop stored sidebar ids that no longer exist (same stays-valid-across-releases
 * treatment as normalizeColumns). Everything is shown by default, so only the
 * hidden ids are persisted. */
function normalizeSidebarHidden(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return SIDEBAR_ITEMS.filter(item => raw.includes(item.id)).map(item => item.id)
}

/* Persist the user's view choices across runs (same JSON-under-config-dir
 * pattern as window-state.ts — we have no GSettings schema installed). Columns
 * are normalized against the registry on load so a stored config stays valid
 * across releases (see core/columns.ts). */
export function loadViewPrefs(): ViewPrefs {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    return {
      viewMode: raw.viewMode === 'list' ? 'list' : 'grid',
      columns: Array.isArray(raw.columns) ? normalizeColumns(raw.columns) : defaultColumnConfig(),
      sidebarHidden: normalizeSidebarHidden(raw.sidebarHidden),
      dirSizes: raw.dirSizes === true,
      dirSizesTtl: normalizeTtl(raw.dirSizesTtl),
    }
  } catch {
    return { viewMode: 'grid', columns: defaultColumnConfig(), sidebarHidden: [], dirSizes: false, dirSizesTtl: DEFAULT_TTL }
  }
}

export function saveViewPrefs(prefs: ViewPrefs): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify({
      viewMode: prefs.viewMode,
      columns: prefs.columns,
      sidebarHidden: prefs.sidebarHidden,
      dirSizes: prefs.dirSizes,
      dirSizesTtl: prefs.dirSizesTtl,
    }))
  } catch { /* non-fatal */ }
}
