import Gio from 'gi:Gio-2.0'
import { displayName, isDirectory } from '../core/format.ts'
import { isArchive } from '../services/archive-service.ts'
import type { Entry } from '../core/types.ts'

export interface MenuContext {
  target: Entry | null
  inTrash: boolean
  clipboardEmpty: boolean
  isSplit: boolean
  /* Whether the targeted folder can be bookmarked, and in which direction: 'add'
   * when it isn't yet bookmarked, 'remove' when it is, null when N/A. */
  bookmark: 'add' | 'remove' | null
}

/* Builds the file-view context-menu model (nautilus-like sections), varying by
 * whether an item is targeted, whether we're in Trash, clipboard state, and
 * whether the tab is split (dual-pane copy/move targets). Pure — the window
 * owns popover creation/positioning and the paste target. */
export function buildContextMenu({ target, inTrash, clipboardEmpty, isSplit, bookmark }: MenuContext): any {
  const menu = Gio.Menu.new()
  const section = (...items: Array<[string, string]>) => {
    const s = Gio.Menu.new()
    for (const [label, action] of items) s.append(label, action)
    menu.appendSection(null, s)
  }
  const bookmarkItem = (): [string, string] => bookmark === 'add'
    ? ['Add to Bookmarks', 'win.ctx-add-bookmark']
    : ['Remove From Bookmarks', 'win.remove-bookmark']

  if (target && inTrash) {
    section(['Restore From Trash', 'win.restore'], ['Restore to…', 'win.restore-to'])
    section(['Delete Permanently', 'win.delete'])
    section(['Properties', 'win.properties'])
  } else if (target) {
    const isDir = isDirectory(target.info)
    const isImage = (target.info.getContentType() || '').startsWith('image/')
    section(['Open', 'win.open'], isDir ? ['Open in New Tab', 'win.open-new-tab'] : ['Open With…', 'win.open-with'])
    section(['Preview', 'win.preview'])

    const edit: Array<[string, string]> = [['Cut', 'win.cut'], ['Copy', 'win.copy']]
    if (isDir && !clipboardEmpty) edit.push(['Paste Into Folder', 'win.paste'])
    section(...edit)

    if (isSplit) section(['Copy to Other Pane', 'win.copy-to-other-pane'], ['Move to Other Pane', 'win.move-to-other-pane'])

    section(['Rename…', 'win.rename'], ['Create Link', 'win.create-link'],
      ['Move to Trash', 'win.trash'], ['Delete Permanently', 'win.delete'])

    const arc: Array<[string, string]> = []
    if (isArchive(displayName(target.info))) arc.push(['Extract Here', 'win.extract-here'])
    arc.push(['Compress…', 'win.compress'])
    if (isImage) arc.push(['Set as Wallpaper', 'win.set-wallpaper'])
    if (isDir) arc.push(['Analyze Disk Usage', 'win.disk-usage'])
    section(...arc)

    if (bookmark) section(bookmarkItem())

    section(['Properties', 'win.properties'])
  } else if (inTrash) {
    section(['Empty Trash', 'win.empty-trash'], ['Select All', 'win.select-all'])
  } else {
    section(['New Folder…', 'win.new-folder'])
    const bg: Array<[string, string]> = []
    if (!clipboardEmpty) bg.push(['Paste', 'win.paste'])
    bg.push(['Select All', 'win.select-all'])
    section(...bg)
    section(['Open in Terminal', 'win.open-terminal'], ['Analyze Disk Usage', 'win.disk-usage'])
  }
  return menu
}
