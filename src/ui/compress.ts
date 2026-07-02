import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import type { ArchiveFormat } from '../services/archive-service.ts'

const FORMATS: Array<[label: string, format: ArchiveFormat]> = [
  ['.zip', 'zip'], ['.tar.xz', 'tar.xz'], ['.tar.gz', 'tar.gz'], ['.7z', '7z'],
]

/* Compress dialog: name entry + format dropdown, mirroring nautilus's compress
 * dialog. Resolves { name, format } or null on cancel. */
export function compressDialog(parent: any, defaultBase: string): Promise<{ name: string; format: ArchiveFormat } | null> {
  return new Promise(resolve => {
    const dialog = new Adw.AlertDialog({ heading: 'Create Archive' })
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
    const entry = new Gtk.Entry({ text: defaultBase, hexpand: true, activatesDefault: true })
    const format = new Gtk.DropDown({ model: Gtk.StringList.new(FORMATS.map(f => f[0])) })
    box.append(entry)
    box.append(format)
    dialog.setExtraChild(box)
    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('ok', 'Create')
    dialog.setResponseAppearance('ok', Adw.ResponseAppearance.SUGGESTED)
    dialog.setDefaultResponse('ok')
    dialog.setCloseResponse('cancel')

    let done = false
    dialog.on('response', (...a: any[]) => {
      if (done) return
      done = true
      if (a[a.length - 1] !== 'ok') return resolve(null)
      const base = entry.getText().trim() || defaultBase
      const [label, fmt] = FORMATS[format.getSelected()]
      resolve({ name: base + label, format: fmt })
    })
    dialog.present(parent)
    entry.grabFocus()
    entry.selectRegion(0, -1)
  })
}
