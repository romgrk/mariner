import GLib from 'gi:GLib-2.0'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const DIR = GLib.getUserConfigDir() + '/nautilus-clone'
const FILE = DIR + '/state.json'

export interface WindowState { width: number; height: number; maximized: boolean }
const DEFAULT: WindowState = { width: 890, height: 550, maximized: false }

/* Persist the window geometry across runs (nautilus stores this in GSettings;
 * we have no schema installed, so a small JSON file under the user config dir). */
export function loadWindowState(): WindowState {
  try { return { ...DEFAULT, ...JSON.parse(readFileSync(FILE, 'utf8')) } }
  catch { return { ...DEFAULT } }
}

export function saveWindowState(state: WindowState): void {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(state)) }
  catch { /* non-fatal */ }
}
