import Gtk from 'gi:Gtk-4.0'
import GLib from 'gi:GLib-2.0'
import type { SearchCategory, SearchFilter } from '../core/types.ts'

const CATEGORIES: Array<[string, SearchCategory]> = [
  ['Anything', 'all'], ['Folders', 'folder'], ['Documents', 'document'],
  ['Images', 'image'], ['Music', 'audio'], ['Video', 'video'],
]
/* label, days-window (0 = any) */
const WHEN: Array<[string, number]> = [
  ['Any time', 0], ['Today', 1], ['This week', 7], ['This month', 30], ['This year', 365],
]

export interface SearchFilterButton {
  widget: any
  filter: SearchFilter
  reset: () => void
}

/* Funnel button + popover refining the recursive search by file category and
 * modification window, mirroring nautilus's search popover ("What"/"When").
 * Reports the new filter via onChange whenever a dropdown changes. */
export function createSearchFilterButton(onChange: (f: SearchFilter) => void): SearchFilterButton {
  const filter: SearchFilter = { category: 'all', since: 0 }

  const grid = new Gtk.Grid({ rowSpacing: 8, columnSpacing: 12, marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12 })
  const kind = dropdown(CATEGORIES.map(c => c[0]), i => { filter.category = CATEGORIES[i][1]; onChange({ ...filter }) })
  const when = dropdown(WHEN.map(w => w[0]), i => { filter.since = sinceFor(WHEN[i][1]); onChange({ ...filter }) })
  grid.attach(label('What'), 0, 0, 1, 1); grid.attach(kind, 1, 0, 1, 1)
  grid.attach(label('When'), 0, 1, 1, 1); grid.attach(when, 1, 1, 1, 1)

  const popover = new Gtk.Popover()
  popover.setChild(grid)
  const widget = new Gtk.MenuButton({ iconName: 'funnel-symbolic', tooltipText: 'Filter Results', popover })

  return {
    widget, filter,
    reset: () => { filter.category = 'all'; filter.since = 0; kind.setSelected(0); when.setSelected(0) },
  }
}

/* days ago → unix-seconds floor (0 passes through). GLib avoids Date. */
function sinceFor(days: number): number {
  if (!days) return 0
  return Math.floor(Number(GLib.getRealTime()) / 1e6) - days * 86400
}

function dropdown(labels: string[], onChange: (i: number) => void): any {
  const dd = new Gtk.DropDown({ model: Gtk.StringList.new(labels) })
  dd.on('notify::selected', () => onChange(dd.getSelected()))
  return dd
}

function label(text: string): any {
  return new Gtk.Label({ label: text, xalign: 0, cssClasses: ['dim-label'] })
}
