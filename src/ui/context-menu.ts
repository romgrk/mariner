import Gio from 'gi:Gio-2.0'
import { displayName, isDirectory } from '../core/format.ts'
import { isArchive } from '../services/archive-service.ts'
import { customMenuItem } from './tag-menu.ts'
import type { Entry } from '../core/types.ts'

/* One toggle entry in the fallback Tags submenu: the tag's name and its
 * (window-scoped, stateful) toggle action. */
export interface TagMenuItem {
  label: string
  action: string
}

/* The Tags section's inputs. When `custom` is set the model carries custom-
 * widget placeholders (the inline dots row, and — with `overflow` — a "More
 * Tags" submenu list); the window fills them via PopoverMenu.addChild. `items`
 * is the plain stateful-toggle fallback for when node-gtk can't do that. */
export interface TagMenuContext {
  custom: boolean
  overflow: boolean
  /* Whether any selected file carries tags (enables "Remove All Tags"). */
  assigned: boolean
  items: TagMenuItem[]
}

export interface MenuContext {
  target: Entry | null
  inTrash: boolean
  clipboardEmpty: boolean
  isSplit: boolean
  /* Whether the targeted folder can be bookmarked, and in which direction: 'add'
   * when it isn't yet bookmarked, 'remove' when it is, null when N/A. */
  bookmark: 'add' | 'remove' | null
  /* Tags for the selection (null hides the Tags section — trash, background,
   * virtual schemes). */
  tags: TagMenuContext | null
}

/* Builds the file-view context-menu model (nautilus-like sections), varying by
 * whether an item is targeted, whether we're in Trash, clipboard state, and
 * whether the tab is split (dual-pane copy/move targets). Pure — the window
 * owns popover creation/positioning and the paste target. */
export function buildContextMenu({ target, inTrash, clipboardEmpty, isSplit, bookmark, tags }: MenuContext): any {
  const menu = Gio.Menu.new()
  const section = (...items: Array<[string, string]>) => {
    const s = Gio.Menu.new()
    for (const [label, action] of items) s.append(label, action)
    menu.appendSection(null, s)
  }

  /* The Tags section. Custom mode: an inline dots row (toggling stays open;
   * its "+" opens the New Tag dialog) and, when not every tag fits inline, a
   * "More Tags" submenu with the full dot+name list. Fallback mode: a "Tags"
   * submenu of plain stateful toggles. Either way, "Remove All Tags" appears
   * when the selection carries tags. */
  const tagsSection = (): void => {
    if (!tags) return
    const s = Gio.Menu.new()
    if (tags.custom) {
      s.appendItem(customMenuItem('tag-dots'))
      if (tags.overflow) {
        const sub = Gio.Menu.new()
        sub.appendItem(customMenuItem('tag-list'))
        /* Repeat the management entries inside the submenu, so everything
         * tag-related is at hand from either level. */
        const manage = Gio.Menu.new()
        manage.append('New Tag…', 'win.tag-new')
        if (tags.assigned) manage.append('Remove All Tags', 'win.tag-clear')
        sub.appendSection(null, manage)
        s.appendSubmenu('All Tags', sub)
      }
    } else {
      const sub = Gio.Menu.new()
      const toggles = Gio.Menu.new()
      for (const t of tags.items) toggles.append(t.label, t.action)
      if (tags.items.length) sub.appendSection(null, toggles)
      const manage = Gio.Menu.new()
      manage.append('New Tag…', 'win.tag-new')
      sub.appendSection(null, manage)
      s.appendSubmenu('Tags', sub)
    }
    if (tags.assigned) s.append('Remove All Tags', 'win.tag-clear')
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
