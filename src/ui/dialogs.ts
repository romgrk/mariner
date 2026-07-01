import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { F } from '../core/gio.ts'
import {
  displayName, formatType, formatSize, formatBytes, formatModified, isDirectory,
} from '../core/format.ts'
import { measureUsage } from '../core/measure.ts'
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

export function showProperties(parent: any, info: GFileInfo, file: GFile): void {
  const dialog = new Adw.Dialog()
  dialog.setTitle('Properties')
  dialog.setContentWidth(440)

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
  const parentDir = F.getParent(file)
  row('Location', parentDir ? F.getPath(parentDir) : '')
  row('Modified', formatModified(info))
  row('Permissions', permString(info))

  /* Folders: walk asynchronously for total size + item counts, updating live. */
  if (isDirectory(info)) {
    const contents = new Adw.ActionRow({ title: 'Contents', subtitle: 'Calculating…' })
    contents.addCssClass('property')
    group.add(contents)
    const path = F.getPath(file)
    if (path) {
      let cancelled = false
      dialog.on('closed', () => { cancelled = true })
      measureUsage(path, (u, done) => {
        const items = `${u.files} file${u.files === 1 ? '' : 's'}, ${u.folders} folder${u.folders === 1 ? '' : 's'}`
        contents.setSubtitle(`${formatBytes(u.bytes)} — ${items}${done ? '' : '…'}`)
      }, () => cancelled)
    } else {
      contents.setSubtitle('—')
    }
  }

  page.add(group)
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
