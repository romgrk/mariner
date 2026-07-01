import Adw from 'gi:Adw-1'

/* Keyboard-shortcuts window. Built from a data table (below) mirroring
 * nautilus's shortcuts-dialog.blp, via Adw.ShortcutsDialog (libadwaita ≥ 1.8).
 * Lists only shortcuts this app actually implements — accelerators here must
 * stay in sync with ACCELS in main.ts. */

type Item = [title: string, accel: string]
interface Section { title?: string; items: Item[] }

const SECTIONS: Section[] = [
  { title: 'Actions', items: [
    ['Open', 'Return'],
    ['Rename', 'F2'],
    ['Create Folder', '<Primary><Shift>n'],
    ['Move to Trash', 'Delete'],
    ['Delete Permanently', '<Shift>Delete'],
    ['Create Link', '<Primary>m'],
    ['Show Item Properties', '<Primary>i <Alt>Return'],
    ['Open Context Menu', '<Shift>F10'],
  ] },
  { title: 'Edit', items: [
    ['Cut', '<Primary>x'],
    ['Copy', '<Primary>c'],
    ['Paste', '<Primary>v'],
    ['Undo', '<Primary>z'],
    ['Redo', '<Primary><Shift>z'],
  ] },
  { title: 'Select', items: [
    ['Select All', '<Primary>a'],
    ['Invert Selection', '<Primary><Shift>i'],
  ] },
  { title: 'View', items: [
    ['Zoom In', '<Primary>plus'],
    ['Zoom Out', '<Primary>minus'],
    ['Reset Zoom', '<Primary>0'],
    ['List View', '<Primary>1'],
    ['Grid View', '<Primary>2'],
    ['Refresh View', 'F5 <Primary>r'],
    ['Show/Hide Hidden Files', '<Primary>h'],
    ['Show/Hide Sidebar', 'F9'],
  ] },
  { title: 'Navigation', items: [
    ['Go Back', '<Alt>Left'],
    ['Go Forward', '<Alt>Right'],
    ['Go Up', '<Alt>Up'],
    ['Go to Home Folder', '<Alt>Home'],
    ['Enter Location', '<Primary>l'],
  ] },
  { title: 'Search', items: [
    ['Search Current Folder', '<Primary>f'],
  ] },
  { title: 'Windows & Tabs', items: [
    ['New Window', '<Primary>n'],
    ['New Tab', '<Primary>t'],
    ['Close Window or Tab', '<Primary>w'],
    ['Go to Previous Tab', '<Primary>Page_Up'],
    ['Go to Next Tab', '<Primary>Page_Down'],
  ] },
  { title: 'App', items: [
    ['Keyboard Shortcuts', '<Primary>question'],
    ['Preferences', '<Primary>comma'],
    ['Quit', '<Primary>q'],
  ] },
]

export function shortcutsDialog(): any {
  const dialog = new Adw.ShortcutsDialog()
  for (const { title, items } of SECTIONS) {
    const section = new Adw.ShortcutsSection(title ? { title } : {})
    for (const [name, accel] of items)
      section.add(new Adw.ShortcutsItem({ title: name, accelerator: accel }))
    dialog.add(section)
  }
  return dialog
}
