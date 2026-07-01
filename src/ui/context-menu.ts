import Gio from 'gi:Gio-2.0'
import { displayName, isDirectory } from '../core/format.ts'
import { isArchive } from '../services/archive-service.ts'
import type { Entry } from '../core/types.ts'

export interface MenuContext {
  target: Entry | null
  inTrash: boolean
  clipboardEmpty: boolean
}

/* Builds the file-view context-menu model (nautilus-like sections), varying by
 * whether an item is targeted, whether we're in Trash, and clipboard state.
 * Pure — the window owns popover creation/positioning and the paste target. */
export function buildContextMenu({ target, inTrash, clipboardEmpty }: MenuContext): any {
  const menu = Gio.Menu.new()
  const section = (...items: Array<[string, string]>) => {
    const s = Gio.Menu.new()
    for (const [label, action] of items) s.append(label, action)
    menu.appendSection(null, s)
  }

  if (target && inTrash) {
    section(['Restore From Trash', 'win.restore'])
    section(['Delete Permanently', 'win.delete'])
    section(['Properties', 'win.properties'])
  } else if (target) {
    const isDir = isDirectory(target.info)
    const isImage = (target.info.getContentType() || '').startsWith('image/')
    section(['Open', 'win.open'], isDir ? ['Open in New Tab', 'win.open-new-tab'] : ['Open With…', 'win.open-with'])

    const edit: Array<[string, string]> = [['Cut', 'win.cut'], ['Copy', 'win.copy']]
    if (isDir && !clipboardEmpty) edit.push(['Paste Into Folder', 'win.paste'])
    section(...edit)

    section(['Rename…', 'win.rename'], ['Create Link', 'win.create-link'],
      ['Move to Trash', 'win.trash'], ['Delete Permanently', 'win.delete'])

    const arc: Array<[string, string]> = []
    if (isArchive(displayName(target.info))) arc.push(['Extract Here', 'win.extract-here'])
    arc.push(['Compress…', 'win.compress'])
    if (isImage) arc.push(['Set as Wallpaper', 'win.set-wallpaper'])
    section(...arc)

    section(['Properties', 'win.properties'])
  } else if (inTrash) {
    section(['Empty Trash', 'win.empty-trash'], ['Select All', 'win.select-all'])
  } else {
    section(['New Folder…', 'win.new-folder'])
    const bg: Array<[string, string]> = []
    if (!clipboardEmpty) bg.push(['Paste', 'win.paste'])
    bg.push(['Select All', 'win.select-all'])
    section(...bg)
    section(['Open in Terminal', 'win.open-terminal'])
  }
  return menu
}
