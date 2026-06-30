import Gtk from 'gi:Gtk-4.0'
import { F } from '../core/gio.ts'
import { HOME, locationName } from '../core/format.ts'
import type { GFile } from '../core/types.ts'

export interface PathBar {
  widget: any
  setLocation: (file: GFile) => void
}

/* Breadcrumb path bar. onNavigate(file) is called when a crumb is clicked. */
export function createPathBar(onNavigate: (file: GFile) => void): PathBar {
  const box = new Gtk.Box({ spacing: 0, valign: Gtk.Align.CENTER })
  box.addCssClass('linked')

  function clear(): void {
    let c
    while ((c = box.getFirstChild()) !== null) box.remove(c)
  }

  function crumb(file: GFile, label: string, isCurrent: boolean): void {
    const button = new Gtk.Button({ label })
    button.addCssClass('flat')
    if (isCurrent) button.addCssClass('current-crumb')
    button.on('clicked', () => onNavigate(file))
    box.append(button)
  }

  function setLocation(file: GFile): void {
    clear()
    const path = F.getPath(file)
    if (!path) { crumb(file, locationName(file), true); return }

    /* Build ancestor chain (root → current). */
    const chain: GFile[] = []
    let f: GFile | null = file
    while (f) { chain.unshift(f); f = F.getParent(f) }

    /* Collapse everything above Home into a single "Home" crumb. */
    let start = chain.findIndex(a => F.getPath(a) === HOME)
    if (start < 0) start = 0

    for (let i = start; i < chain.length; i++) {
      const a = chain[i]
      const label = F.getPath(a) === HOME ? 'Home' : (F.getBasename(a) || '/')
      crumb(a, label, i === chain.length - 1)
    }
  }

  return { widget: box, setLocation }
}
