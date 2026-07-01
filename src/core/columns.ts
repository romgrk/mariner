import {
  formatSize, formatType, formatModified, formatAccessed,
  formatCreated, formatOwner, formatGroup, formatPermissions,
} from './format.ts'
import type { ColumnConfig, GFileInfo } from './types.ts'

/* Registry of the list-view's optional meta columns. The Name column is not
 * here — it always shows first and carries the icon/thumbnail (see cells.ts).
 * `format` is a pure GFileInfo → string; `rightAlign` sets the cell xalign.
 * Registry order mirrors GNOME Files' default_column_order. */
export interface ColumnDef {
  id: string
  label: string
  format: (info: GFileInfo) => string
  rightAlign?: boolean
}

export const COLUMN_DEFS: ColumnDef[] = [
  { id: 'size', label: 'Size', format: formatSize, rightAlign: true },
  { id: 'type', label: 'Type', format: formatType },
  { id: 'modified', label: 'Modified', format: formatModified },
  { id: 'accessed', label: 'Accessed', format: formatAccessed },
  { id: 'created', label: 'Created', format: formatCreated },
  { id: 'owner', label: 'Owner', format: formatOwner },
  { id: 'group', label: 'Group', format: formatGroup },
  { id: 'permissions', label: 'Permissions', format: formatPermissions },
]

export const COLUMN_DEF: Record<string, ColumnDef> =
  Object.fromEntries(COLUMN_DEFS.map(d => [d.id, d]))

/* Meta columns shown by default, in order (matches GNOME Files' list view). */
const DEFAULT_VISIBLE = ['size', 'type', 'modified']

/* Fresh default column config: every registered column in registry order, with
 * the defaults toggled on. */
export function defaultColumnConfig(): ColumnConfig[] {
  return COLUMN_DEFS.map(d => ({ id: d.id, visible: DEFAULT_VISIBLE.includes(d.id) }))
}

/* Reconcile a persisted/edited config against the registry: keep known columns
 * in their saved order, append any registry columns the config is missing
 * (hidden), and drop unknown ids. Keeps a stored config valid across releases. */
export function normalizeColumns(configs: ColumnConfig[]): ColumnConfig[] {
  const seen = new Set<string>()
  const out: ColumnConfig[] = []
  for (const c of configs) {
    if (COLUMN_DEF[c.id] && !seen.has(c.id)) { out.push({ id: c.id, visible: !!c.visible }); seen.add(c.id) }
  }
  for (const d of COLUMN_DEFS) if (!seen.has(d.id)) out.push({ id: d.id, visible: false })
  return out
}
