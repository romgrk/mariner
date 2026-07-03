import Gtk from 'gi:Gtk-4.0'
import GLib from 'gi:GLib-2.0'
import { tagsService } from '../services/tags-service.ts'
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
  const filter: SearchFilter = { category: 'all', since: 0, contents: false, tags: [] }

  const grid = new Gtk.Grid({ rowSpacing: 8, columnSpacing: 12, marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12 })
  const kind = dropdown(CATEGORIES.map(c => c[0]), i => { filter.category = CATEGORIES[i][1]; onChange({ ...filter }) })
  const when = dropdown(WHEN.map(w => w[0]), i => { filter.since = sinceFor(WHEN[i][1]); onChange({ ...filter }) })
  const contents = new Gtk.Switch({ halign: Gtk.Align.START, valign: Gtk.Align.CENTER })
  contents.on('notify::active', () => { filter.contents = contents.getActive(); onChange({ ...filter }) })
  grid.attach(label('What'), 0, 0, 1, 1); grid.attach(kind, 1, 0, 1, 1)
  grid.attach(label('When'), 0, 1, 1, 1); grid.attach(when, 1, 1, 1, 1)
  grid.attach(label('Contents'), 0, 2, 1, 1); grid.attach(contents, 1, 2, 1, 1)

  /* Tag chips: toggle any subset; matches must carry ALL toggled tags (tag
   * intersection). Rebuilt whenever the tag set changes. */
  const active = new Set<string>()
  const chips = new Gtk.FlowBox({ selectionMode: Gtk.SelectionMode.NONE, maxChildrenPerLine: 3, columnSpacing: 4, rowSpacing: 4 })
  const rebuildChips = (): void => {
    let c
    while ((c = chips.getFirstChild()) !== null) chips.remove(c)
    const names = new Set(tagsService.visibleTags().map(t => t.name))
    /* Drop toggled tags that no longer exist (or went hidden); re-run the
     * search if that changed the effective filter. */
    let pruned = false
    for (const n of [...active]) if (!names.has(n)) { active.delete(n); pruned = true }
    for (const tag of tagsService.visibleTags()) {
      const btn = new Gtk.ToggleButton({ active: active.has(tag.name) })
      btn.addCssClass('mariner-tag-chip')
      const content = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 })
      if (tag.color) {
        const dot = new Gtk.Box({ valign: Gtk.Align.CENTER })
        dot.addCssClass('mariner-tag-dot')
        dot.addCssClass('tag-color-' + tag.color)
        content.append(dot)
      }
      content.append(new Gtk.Label({ label: tag.name }))
      btn.setChild(content)
      btn.on('toggled', () => {
        if (btn.getActive()) active.add(tag.name)
        else active.delete(tag.name)
        filter.tags = [...active]
        onChange({ ...filter })
      })
      chips.append(btn)
    }
    if (pruned) { filter.tags = [...active]; onChange({ ...filter }) }
  }
  rebuildChips()
  tagsService.on('changed', rebuildChips)
  grid.attach(label('Tags'), 0, 3, 1, 1); grid.attach(chips, 1, 3, 1, 1)

  const popover = new Gtk.Popover()
  popover.setChild(grid)
  const widget = new Gtk.MenuButton({ iconName: 'view-more-symbolic', tooltipText: 'Filter Results', popover })

  return {
    widget, filter,
    reset: () => {
      filter.category = 'all'; filter.since = 0; filter.contents = false; filter.tags = []
      active.clear()
      kind.setSelected(0); when.setSelected(0); contents.setActive(false)
      rebuildChips()
    },
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
