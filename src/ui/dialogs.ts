import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import {
  displayName, formatType, formatSize, formatBytes, formatModified, isDirectory,
} from '../core/format.ts'
import { measureUsage } from '../core/measure.ts'
import { createUsageChart } from './disk-usage.ts'
import type { GFile, GFileInfo } from '../core/types.ts'

interface PromptOptions {
  heading: string
  body?: string
  value?: string
  okLabel?: string
  selectBasename?: boolean
}

/* Text prompt (new folder / rename). Resolves to the string, or null on cancel. */
export function promptText(parent: any, { heading, body, value = '', okLabel = 'OK', selectBasename = false }: PromptOptions): Promise<string | null> {
  return new Promise<string | null>(resolve => {
    const dialog = new Adw.AlertDialog({ heading, body: body ?? '' })
    const entry = new Gtk.Entry({ text: value, activatesDefault: true, hexpand: true })
    dialog.setExtraChild(entry)
    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('ok', okLabel)
    dialog.setResponseAppearance('ok', Adw.ResponseAppearance.SUGGESTED)
    dialog.setDefaultResponse('ok')
    dialog.setCloseResponse('cancel')

    let done = false
    const finish = (id: string) => {
      if (done) return
      done = true
      resolve(id === 'ok' ? entry.getText().trim() || null : null)
    }
    dialog.on('response', (...a: any[]) => finish(a[a.length - 1]))
    dialog.present(parent)

    entry.grabFocus()
    if (value) {
      const dot = value.lastIndexOf('.')
      if (selectBasename && dot > 0) entry.selectRegion(0, dot)
      else entry.selectRegion(0, -1)
    }
  })
}

/* Native folder picker (GTK's FileDialog). Resolves to the chosen folder, or
 * null if the user cancels. Used by the Trash view's "Restore to…" action. */
export function chooseFolder(parent: any, opts: { title?: string; initialFolder?: GFile } = {}): Promise<GFile | null> {
  return new Promise<GFile | null>(resolve => {
    const dialog = new Gtk.FileDialog({ title: opts.title ?? 'Select Folder', modal: true })
    if (opts.initialFolder) dialog.setInitialFolder(opts.initialFolder)
    dialog.selectFolder(parent, null, (_src: any, res: any) => {
      let folder: GFile | null = null
      try { folder = dialog.selectFolderFinish(res) } catch { /* cancelled */ }
      resolve(folder)
    })
  })
}

interface ConfirmOptions {
  heading: string
  body?: string
  okLabel?: string
  destructive?: boolean
}

/* Yes/no confirmation. Resolves true if confirmed. */
export function confirm(parent: any, { heading, body, okLabel = 'Delete', destructive = true }: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const d = new Adw.AlertDialog({ heading, body: body ?? '' })
    d.addResponse('cancel', 'Cancel')
    d.addResponse('ok', okLabel)
    if (destructive) d.setResponseAppearance('ok', Adw.ResponseAppearance.DESTRUCTIVE)
    d.setDefaultResponse('cancel')
    d.setCloseResponse('cancel')
    d.on('response', (...a: any[]) => resolve(a[a.length - 1] === 'ok'))
    d.present(parent)
  })
}

function permString(info: GFileInfo): string {
  const canWrite = info.getAttributeBoolean('access::can-write')
  const canExec = info.getAttributeBoolean('access::can-execute')
  let s = canWrite ? 'Read & Write' : 'Read-only'
  if (canExec) s += ', Executable'
  return s
}

interface PropertiesOptions {
  /* Open with the "Disk Usage" section already expanded + scanning (the
   * merged "Analyze Disk Usage" entry point). */
  expandUsage?: boolean
}

export function showProperties(parent: any, info: GFileInfo, file: GFile, opts: PropertiesOptions = {}): void {
  const dialog = new Adw.Dialog()
  dialog.setTitle('Properties')
  dialog.setContentWidth(560)

  const tv = new Adw.ToolbarView()
  tv.addTopBar(new Adw.HeaderBar())

  const page = new Adw.PreferencesPage()
  const group = new Adw.PreferencesGroup()
  const row = (title: string, subtitle: string) => {
    const r = new Adw.ActionRow({ title, subtitle: String(subtitle || '—') })
    r.addCssClass('property')
    group.add(r)
  }
  row('Name', displayName(info))
  row('Type', formatType(info))
  if (!isDirectory(info)) row('Size', formatSize(info))
  const parentDir = file.getParent()
  row('Location', parentDir ? parentDir.getPath() : '')
  row('Modified', formatModified(info))
  row('Permissions', permString(info))

  page.add(group)

  /* Folders/drives (local paths only): one "Disk Usage" row whose subtitle holds
   * the size/count summary, an inline "Scan" button, and the sunburst as its
   * expandable content. Nothing scans on open — pressing Scan (or opening via
   * "Analyze Disk Usage") walks the tree once, filling both the summary and the
   * chart; the walk is cancelled when the dialog closes. */
  const usagePath = isDirectory(info) ? file.getPath() : null
  if (usagePath) {
    dialog.setContentHeight(640)

    const usageGroup = new Adw.PreferencesGroup()
    const expander = new Adw.ExpanderRow({ title: 'Disk Usage', subtitle: 'Not scanned' })
    const chart = createUsageChart(usagePath)
    chart.widget.setSizeRequest(-1, 360)
    expander.addRow(chart.widget)

    const scanBtn = new Gtk.Button({ label: 'Scan', valign: Gtk.Align.CENTER })
    scanBtn.addCssClass('suggested-action')
    expander.addSuffix(scanBtn)

    usageGroup.add(expander)
    page.add(usageGroup)

    let cancelled = false
    dialog.on('closed', () => { cancelled = true; chart.cancel() })
    let scanned = false
    const runScan = () => {
      if (scanned) return
      scanned = true
      scanBtn.setSensitive(false)
      scanBtn.setLabel('Scanning…')
      expander.setSubtitle('Calculating…')
      measureUsage(usagePath, (u, done) => {
        const items = `${u.files} file${u.files === 1 ? '' : 's'}, ${u.folders} folder${u.folders === 1 ? '' : 's'}`
        expander.setSubtitle(`${formatBytes(u.bytes)} — ${items}${done ? '' : '…'}`)
        if (done) scanBtn.setLabel('Done')
      }, () => cancelled)
      chart.start()
      expander.setExpanded(true)
    }
    scanBtn.on('clicked', runScan)
    if (opts.expandUsage) runScan()
  }

  tv.setContent(page)
  dialog.setChild(tv)
  dialog.present(parent)
}

export function aboutDialog(parent: any): void {
  const about = new Adw.AboutDialog({
    applicationName: 'Mariner',
    applicationIcon: 'system-file-manager',
    developerName: 'node-gtk',
    version: '0.0.1',
    comments: 'A GNOME Files clone built with node-gtk.',
  })
  about.present(parent)
}
