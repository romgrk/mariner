import Gio from 'gi:Gio-2.0'
import { displayName, isDirectory } from '../core/format.ts'
import { isArchive } from '../services/archive-service.ts'
import type { Entry } from '../core/types.ts'

/* One toggle entry in the Tags submenu: the tag's name, its (window-scoped,
 * stateful) toggle action, and a colored-dot GIcon for palette tags. */
export interface TagMenuItem {
  label: string
  action: string
  icon?: any
}

export interface MenuContext {
  target: Entry | null
  inTrash: boolean
  clipboardEmpty: boolean
  isSplit: boolean
  /* Whether the targeted folder can be bookmarked, and in which direction: 'add'
   * when it isn't yet bookmarked, 'remove' when it is, null when N/A. */
  bookmark: 'add' | 'remove' | null
  /* Tag toggles for the selection (null hides the Tags submenu — trash,
   * background, virtual schemes). */
  tagItems: TagMenuItem[] | null
  /* Whether any selected file carries tags (enables "Remove All Tags"). */
  tagsAssigned: boolean
}

/* Builds the file-view context-menu model (nautilus-like sections), varying by
 * whether an item is targeted, whether we're in Trash, clipboard state, and
 * whether the tab is split (dual-pane copy/move targets). Pure — the window
 * owns popover creation/positioning and the paste target. */
export function buildContextMenu({ target, inTrash, clipboardEmpty, isSplit, bookmark, tagItems, tagsAssigned }: MenuContext): any {
  const menu = Gio.Menu.new()
  const section = (...items: Array<[string, string]>) => {
    const s = Gio.Menu.new()
    for (const [label, action] of items) s.append(label, action)
    menu.appendSection(null, s)
  }

  /* "Tags ▸": stateful toggles per tag (colored dot + check), then the manager
   * entry and — when anything is tagged — the destructive remove-all. */
  const tagsSection = (): void => {
    if (!tagItems) return
    const sub = Gio.Menu.new()
    const toggles = Gio.Menu.new()
    for (const t of tagItems) {
      const item = Gio.MenuItem.new(t.label, t.action)
      if (t.icon) { try { item.setIcon(t.icon) } catch { /* icon is cosmetic */ } }
      toggles.appendItem(item)
    }
    if (tagItems.length) sub.appendSection(null, toggles)
    const manage = Gio.Menu.new()
    manage.append('New Tag…', 'win.manage-tags')
    if (tagsAssigned) manage.append('Remove All Tags', 'win.tag-clear')
    sub.appendSection(null, manage)
    const s = Gio.Menu.new()
    s.appendSubmenu('Tags', sub)
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

    tagsSection()

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
