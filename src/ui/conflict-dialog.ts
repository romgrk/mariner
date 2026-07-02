import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import { locationName } from '../core/format.ts'
import type { GFile } from '../core/types.ts'

export type ConflictAction = 'replace' | 'skip' | 'keep-both'
export interface Conflict { src: GFile; name: string; dest: GFile }
/* Decision per conflicting source file (missing = not resolved / cancelled). */
export type Resolution = Map<GFile, ConflictAction>

/* Walk the collisions, asking the user per file (Replace / Skip / Keep Both),
 * honouring an "Apply to all" toggle. Resolves to a per-src action map, or null
 * if the user cancels the whole operation. */
export async function resolveConflicts(parent: any, conflicts: Conflict[], destDir: GFile): Promise<Resolution | null> {
  const res: Resolution = new Map()
  let applyAll: ConflictAction | null = null
  for (const c of conflicts) {
    if (applyAll) { res.set(c.src, applyAll); continue }
    const answer = await askOne(parent, c, destDir, conflicts.length)
    if (!answer) return null   /* cancelled → abort everything */
    res.set(c.src, answer.action)
    if (answer.all) applyAll = answer.action
  }
  return res
}

function askOne(parent: any, c: Conflict, destDir: GFile, total: number): Promise<{ action: ConflictAction; all: boolean } | null> {
  return new Promise(resolve => {
    const dialog = new Adw.AlertDialog({
      heading: `“${c.name}” already exists`,
      body: `A file with that name is already in “${locationName(destDir)}”.`,
    })
    let all: any = null
    if (total > 1) {
      all = new Gtk.CheckButton({ label: `Apply to all ${total} conflicts`, marginTop: 4 })
      dialog.setExtraChild(all)
    }
    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('skip', 'Skip')
    dialog.addResponse('keep-both', 'Keep Both')
    dialog.addResponse('replace', 'Replace')
    dialog.setResponseAppearance('replace', Adw.ResponseAppearance.DESTRUCTIVE)
    dialog.setDefaultResponse('keep-both')
    dialog.setCloseResponse('cancel')

    let done = false
    const finish = (id: string) => {
      if (done) return
      done = true
      resolve(id === 'cancel' ? null : { action: id as ConflictAction, all: !!all && all.getActive() })
    }
    dialog.on('response', (...a: any[]) => finish(a[a.length - 1]))
    dialog.present(parent)
  })
}

/* Compute non-colliding items directly, and the colliding ones needing a prompt.
 * Kept here so the window's paste/drop paths stay thin. */
export function partitionConflicts(files: GFile[], destDir: GFile): { free: GFile[]; conflicts: Conflict[] } {
  const free: GFile[] = []
  const conflicts: Conflict[] = []
  for (const src of files) {
    const name = src.getBasename()
    const dest = destDir.getChild(name)
    if (dest.queryExists(null)) conflicts.push({ src, name, dest })
    else free.push(src)
  }
  return { free, conflicts }
}
