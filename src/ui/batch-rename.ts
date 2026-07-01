import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { displayName } from '../core/format.ts'
import type { Entry, GFile } from '../core/types.ts'

export interface RenamePlan { file: GFile; from: string; to: string }

/* Batch-rename dialog for a multi-selection, mirroring nautilus-batch-rename:
 * two modes (find/replace, numbered template) with a live preview. Resolves with
 * the list of files whose name actually changes, or null on cancel. */
export function batchRenameDialog(parent: any, entries: Entry[]): Promise<RenamePlan[] | null> {
  return new Promise(resolve => {
    const names = entries.map(e => displayName(e.info))

    const dialog = new Adw.Dialog()
    dialog.setTitle(`Rename ${entries.length} Files`)
    dialog.setContentWidth(500)
    dialog.setContentHeight(560)

    const header = new Adw.HeaderBar({ showStartTitleButtons: false, showEndTitleButtons: false })
    const cancel = new Gtk.Button({ label: 'Cancel' })
    const apply = new Gtk.Button({ label: 'Rename', cssClasses: ['suggested-action'] })
    header.packStart(cancel)
    header.packEnd(apply)

    const page = new Adw.PreferencesPage()
    const group = new Adw.PreferencesGroup()
    const modeRow = new Adw.ComboRow({ title: 'Rename Using', model: Gtk.StringList.new(['Find and Replace', 'Numbered']) })
    const findRow = new Adw.EntryRow({ title: 'Existing Text' })
    const replaceRow = new Adw.EntryRow({ title: 'Replace With' })
    const baseRow = new Adw.EntryRow({ title: 'Name' })
    group.add(modeRow); group.add(findRow); group.add(replaceRow); group.add(baseRow)
    page.add(group)

    const previewGroup = new Adw.PreferencesGroup({ title: 'Preview' })
    const list = new Gtk.ListBox({ cssClasses: ['boxed-list'], selectionMode: Gtk.SelectionMode.NONE })
    previewGroup.add(list)
    page.add(previewGroup)

    const tv = new Adw.ToolbarView()
    tv.addTopBar(header)
    tv.setContent(page)
    dialog.setChild(tv)

    const nameFor = (from: string, i: number, mode: number): string => {
      if (mode === 0) { const f = findRow.getText(); return f ? from.split(f).join(replaceRow.getText()) : from }
      const dot = from.lastIndexOf('.')
      const ext = dot > 0 ? from.slice(dot) : ''
      return `${baseRow.getText() || 'File'} ${i + 1}${ext}`
    }

    let plan: RenamePlan[] = []
    const compute = () => {
      const mode = modeRow.getSelected()
      findRow.setVisible(mode === 0); replaceRow.setVisible(mode === 0); baseRow.setVisible(mode === 1)
      let child
      while ((child = list.getFirstChild())) list.remove(child)
      plan = []
      entries.forEach((e, i) => {
        const from = names[i]
        const to = nameFor(from, i, mode)
        if (to && to !== from) plan.push({ file: e.file, from, to })
        list.append(new Adw.ActionRow({ title: from, subtitle: to }))
      })
      apply.setSensitive(plan.length > 0)
    }
    modeRow.on('notify::selected', compute)
    for (const row of [findRow, replaceRow, baseRow]) row.on('changed', compute)
    compute()

    let settled = false
    const finish = (result: RenamePlan[] | null) => { if (settled) return; settled = true; dialog.close(); resolve(result) }
    cancel.on('clicked', () => finish(null))
    apply.on('clicked', () => finish(plan))
    dialog.on('closed', () => finish(null))
    dialog.present(parent)
  })
}
