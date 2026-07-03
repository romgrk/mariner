import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { tagsService, validateTagName, TAG_COLORS } from '../services/tags-service.ts'
import type { Tag } from '../services/tags-service.ts'

/* Shared swatch widget: a small colored circle (or a dashed outline for "no
 * color" = text tag). Used by the New Tag dialog and the Tags page. */
export function swatchBox(color: string | null): any {
  const dot = new Gtk.Box({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
  dot.addCssClass('mariner-tag-swatch')
  if (color) dot.addCssClass('tag-color-' + color)
  else dot.addCssClass('no-color')
  return dot
}

const colorLabel = (color: string | null): string =>
  color ? (TAG_COLORS.find(c => c.key === color)?.label ?? color) : 'No color (text tag)'

/* The New Tag dialog (whiteboard #332): a name entry and the nine accent
 * colors plus "no color". Create stays disabled while the name is empty,
 * invalid (commas) or already taken. Resolves to the created tag, or null. */
export function newTagDialog(parent: any): Promise<Tag | null> {
  return new Promise<Tag | null>(resolve => {
    const dialog = new Adw.AlertDialog({ heading: 'New Tag' })

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
    const entry = new Gtk.Entry({ placeholderText: 'Tag name', activatesDefault: true })
    box.append(entry)

    let color: string | null = null
    const swatches: Array<{ button: any; color: string | null }> = []
    const pal = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, halign: Gtk.Align.CENTER })
    for (const c of [...TAG_COLORS.map(x => x.key), null]) {
      const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltipText: colorLabel(c) })
      b.addCssClass('flat')
      if (c === color) b.addCssClass('selected-swatch')
      b.setChild(swatchBox(c))
      b.on('clicked', () => {
        color = c
        for (const s of swatches) {
          if (s.color === c) s.button.addCssClass('selected-swatch')
          else s.button.removeCssClass('selected-swatch')
        }
      })
      swatches.push({ button: b, color: c })
      pal.append(b)
    }
    box.append(pal)
    dialog.setExtraChild(box)

    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('create', 'Create')
    dialog.setResponseAppearance('create', Adw.ResponseAppearance.SUGGESTED)
    dialog.setDefaultResponse('create')
    dialog.setCloseResponse('cancel')

    const validate = (): void => {
      const name = validateTagName(entry.getText())
      dialog.setResponseEnabled('create', !!name && !tagsService.getTag(name))
    }
    entry.on('changed', validate)
    validate()

    let done = false
    dialog.on('response', (...a: any[]) => {
      if (done) return
      done = true
      const id = a[a.length - 1]
      resolve(id === 'create' ? tagsService.createTag(entry.getText(), color) : null)
    })
    dialog.present(parent)
    entry.grabFocus()
  })
}
