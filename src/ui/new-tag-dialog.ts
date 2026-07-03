import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { tagsService, validateTagName, TAG_COLORS } from '../services/tags-service.ts'
import type { Tag } from '../services/tags-service.ts'

/* Shared swatch widget: a small colored circle (or a dashed outline for "no
 * color" = text tag). Used by the tag dialogs and the Tags page. */
export function swatchBox(color: string | null): any {
  const dot = new Gtk.Box({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
  dot.addCssClass('mariner-tag-swatch')
  if (color) dot.addCssClass('tag-color-' + color)
  else dot.addCssClass('no-color')
  return dot
}

const colorLabel = (color: string | null): string =>
  color ? (TAG_COLORS.find(c => c.key === color)?.label ?? color) : 'No color (text tag)'

/* A swatch with a check overlay marking the active color (white on colored
 * swatches, normal fg on the dashed no-color one). `_check` is exposed so the
 * dialog can move the mark without rebuilding the palette. */
export function checkedSwatch(color: string | null, checked: boolean): any {
  const overlay = new Gtk.Overlay({ child: swatchBox(color) })
  const check = new Gtk.Image({
    iconName: 'object-select-symbolic', pixelSize: 12,
    halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, visible: checked,
  })
  check.addCssClass(color ? 'mariner-swatch-check' : 'mariner-swatch-check-plain')
  overlay.addOverlay(check)
  overlay._check = check
  return overlay
}

interface TagDialogOptions {
  heading: string
  confirmLabel: string
  initialName?: string
  initialColor?: string | null
  /* When editing, the tag's own name stays valid (it isn't "taken"). */
  allowName?: string
}

/* Name entry + the nine accent swatches + "no color" (whiteboard #332). The
 * confirm response stays disabled while the name is empty, invalid (commas) or
 * taken. Resolves to the chosen {name, color}, or null on cancel. */
function tagDialog(parent: any, opts: TagDialogOptions): Promise<{ name: string; color: string | null } | null> {
  return new Promise(resolve => {
    const dialog = new Adw.AlertDialog({ heading: opts.heading })

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
    const entry = new Gtk.Entry({ text: opts.initialName ?? '', placeholderText: 'Tag name', activatesDefault: true })
    box.append(entry)

    let color: string | null = opts.initialColor ?? null
    const swatches: Array<{ swatch: any; color: string | null }> = []
    const pal = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, halign: Gtk.Align.CENTER })
    for (const c of [...TAG_COLORS.map(x => x.key), null]) {
      const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltipText: colorLabel(c) })
      b.addCssClass('flat')
      const swatch = checkedSwatch(c, c === color)
      b.setChild(swatch)
      b.on('clicked', () => {
        color = c
        for (const s of swatches) s.swatch._check.setVisible(s.color === c)
      })
      swatches.push({ swatch, color: c })
      pal.append(b)
    }
    box.append(pal)
    dialog.setExtraChild(box)

    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('confirm', opts.confirmLabel)
    dialog.setResponseAppearance('confirm', Adw.ResponseAppearance.SUGGESTED)
    dialog.setDefaultResponse('confirm')
    dialog.setCloseResponse('cancel')

    const validate = (): void => {
      const name = validateTagName(entry.getText())
      const taken = !!name && name !== opts.allowName && !!tagsService.getTag(name)
      dialog.setResponseEnabled('confirm', !!name && !taken)
    }
    entry.on('changed', validate)
    validate()

    let done = false
    dialog.on('response', (...a: any[]) => {
      if (done) return
      done = true
      const id = a[a.length - 1]
      const name = validateTagName(entry.getText())
      resolve(id === 'confirm' && name ? { name, color } : null)
    })
    dialog.present(parent)
    entry.grabFocus()
    if (opts.initialName) entry.selectRegion(0, -1)
  })
}

/* Create a tag. Resolves to it, or null on cancel. */
export async function newTagDialog(parent: any): Promise<Tag | null> {
  const res = await tagDialog(parent, { heading: 'New Tag', confirmLabel: 'Create' })
  return res ? tagsService.createTag(res.name, res.color) : null
}

/* Edit a tag's name and color in one dialog. */
export async function editTagDialog(parent: any, tag: Tag): Promise<void> {
  const res = await tagDialog(parent, {
    heading: 'Edit Tag', confirmLabel: 'Save',
    initialName: tag.name, initialColor: tag.color, allowName: tag.name,
  })
  if (!res) return
  if (res.color !== tag.color) tagsService.setTagColor(tag.name, res.color)
  if (res.name !== tag.name) tagsService.renameTag(tag.name, res.name)
}
