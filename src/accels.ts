/* Keyboard accelerators, shared by main.ts (app-level, for menu accel labels)
 * and window.ts (an explicit bubble-phase Gtk.ShortcutController that reliably
 * triggers the actions — app-level accels alone weren't firing under node-gtk).
 * Bubble phase means a focused text entry still gets Ctrl+C/V/A for its text. */
export const ACCELS: Record<string, string[]> = {
  'win.back': ['<alt>Left'],
  'win.forward': ['<alt>Right'],
  'win.up': ['<alt>Up', '<alt>u'],
  'win.go-home': ['<alt>Home'],
  'win.reload': ['<ctrl>r', 'F5'],
  'win.new-tab': ['<ctrl>t'],
  'win.new-window': ['<ctrl>n'],
  'win.command-palette': ['<ctrl>p'],
  'win.toggle-split': ['F3'],
  'win.focus-other-pane': ['F6', '<alt>w'],
  'win.close-tab': ['<ctrl>w'],
  'win.tab-prev': ['<ctrl>Page_Up'],
  'win.tab-next': ['<ctrl>Page_Down'],
  'win.location': ['<ctrl>l'],
  'win.search': ['<ctrl>f'],
  'win.show-hidden': ['<ctrl>h'],
  'win.select-all': ['<ctrl>a'],
  'win.invert-selection': ['<ctrl><shift>i'],
  'win.copy': ['<ctrl>c'],
  'win.cut': ['<ctrl>x'],
  'win.paste': ['<ctrl>v'],
  'win.copy-to-other-pane': ['<ctrl><shift>c'],
  'win.move-to-other-pane': ['<ctrl><shift>x'],
  'win.undo': ['<ctrl>z'],
  'win.redo': ['<ctrl><shift>z'],
  'win.open-new-tab': ['<ctrl>Return'],
  'win.rename': ['F2'],
  'win.create-link': ['<ctrl>m'],
  'win.trash': ['Delete'],
  'win.delete': ['<shift>Delete'],
  'win.new-folder': ['<ctrl><shift>n'],
  'win.add-bookmark': ['<ctrl>d'],
  'win.view-list': ['<ctrl>1'],
  'win.view-grid': ['<ctrl>2'],
  'win.zoom-in': ['<ctrl>plus', '<ctrl>equal'],
  'win.zoom-out': ['<ctrl>minus'],
  'win.zoom-reset': ['<ctrl>0'],
  'win.properties': ['<ctrl>i', '<alt>Return'],
  'win.preferences': ['<ctrl>comma'],
  'win.shortcuts': ['<ctrl>question', '<ctrl>slash'],
  'win.quit': ['<ctrl>q'],
}

/* Human-readable rendering of a GTK accelerator string (e.g. '<ctrl>p' →
 * 'Ctrl+P', '<alt>Left' → 'Alt+←'), for the command palette's trailing hint. */
const ACCEL_MODS: Record<string, string> = { ctrl: 'Ctrl', primary: 'Ctrl', shift: 'Shift', alt: 'Alt', super: 'Super', meta: 'Meta' }
const ACCEL_KEYS: Record<string, string> = {
  Left: '←', Right: '→', Up: '↑', Down: '↓', Return: 'Enter', space: 'Space',
  plus: '+', equal: '=', minus: '−', comma: ',', period: '.', question: '?', slash: '/',
  Page_Up: 'Page Up', Page_Down: 'Page Down', Home: 'Home', Delete: 'Del',
}
export function formatAccel(accel: string): string {
  const mods = [...accel.matchAll(/<([a-z]+)>/gi)].map(m => ACCEL_MODS[m[1].toLowerCase()] ?? m[1])
  const key = accel.replace(/<[a-z]+>/gi, '')
  const label = ACCEL_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...mods, label].join('+')
}

/* First (primary) accelerator for an action, human-readable, or undefined. */
export function accelHint(actionName: string): string | undefined {
  const a = ACCELS[actionName]?.[0]
  return a ? formatAccel(a) : undefined
}
