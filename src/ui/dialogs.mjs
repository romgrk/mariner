import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import {
  F, displayName, formatType, formatSize, formatModified, isDirectory,
} from '../util.mjs'

/* Text prompt (new folder / rename). Resolves to the string, or null on cancel. */
export function promptText(parent, { heading, body, value = '', okLabel = 'OK', selectBasename = false }) {
  return new Promise(resolve => {
    const dialog = new Adw.AlertDialog(heading, body || null)
    const entry = new Gtk.Entry({ text: value, activatesDefault: true, hexpand: true })
    dialog.setExtraChild(entry)
    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('ok', okLabel)
    dialog.setResponseAppearance('ok', Adw.ResponseAppearance.SUGGESTED)
    dialog.setDefaultResponse('ok')
    dialog.setCloseResponse('cancel')

    let done = false
    const finish = id => {
      if (done) return
      done = true
      resolve(id === 'ok' ? entry.getText().trim() || null : null)
    }
    dialog.on('response', (...a) => finish(a[a.length - 1]))
    dialog.present(parent)

    entry.grabFocus()
    if (value) {
      const dot = value.lastIndexOf('.')
      if (selectBasename && dot > 0) entry.selectRegion(0, dot)
      else entry.selectRegion(0, -1)
    }
  })
}

/* Yes/no confirmation. Resolves true if confirmed. */
export function confirm(parent, { heading, body, okLabel = 'Delete', destructive = true }) {
  return new Promise(resolve => {
    const d = new Adw.AlertDialog(heading, body || null)
    d.addResponse('cancel', 'Cancel')
    d.addResponse('ok', okLabel)
    if (destructive) d.setResponseAppearance('ok', Adw.ResponseAppearance.DESTRUCTIVE)
    d.setDefaultResponse('cancel')
    d.setCloseResponse('cancel')
    d.on('response', (...a) => resolve(a[a.length - 1] === 'ok'))
    d.present(parent)
  })
}

function permString(info) {
  const canWrite = info.getAttributeBoolean('access::can-write')
  const canExec = info.getAttributeBoolean('access::can-execute')
  let s = canWrite ? 'Read & Write' : 'Read-only'
  if (canExec) s += ', Executable'
  return s
}

export function showProperties(parent, info, file) {
  const dialog = new Adw.Dialog()
  dialog.setTitle('Properties')
  dialog.setContentWidth(440)

  const tv = new Adw.ToolbarView()
  tv.addTopBar(new Adw.HeaderBar())

  const page = new Adw.PreferencesPage()
  const group = new Adw.PreferencesGroup()
  const row = (title, subtitle) => {
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

  page.add(group)
  tv.setContent(page)
  dialog.setChild(tv)
  dialog.present(parent)
}

export function aboutDialog(parent) {
  const about = new Adw.AboutDialog({
    applicationName: 'Files',
    applicationIcon: 'system-file-manager',
    developerName: 'node-gtk',
    version: '0.0.1',
    comments: 'A GNOME Files clone built with node-gtk.',
  })
  about.present(parent)
}
