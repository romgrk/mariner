import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Gio from 'gi:Gio-2.0'
import { locationName } from '../core/format.ts'
import { uniqueChild } from '../services/file-operations.ts'
import type { CopyItem, GFile } from '../core/types.ts'

export type ConflictAction = 'replace' | 'skip' | 'keep-both'
export interface Conflict { src: GFile; name: string; dest: GFile }
/* Decision per conflicting source file (missing = not resolved / cancelled). */
export type Resolution = Map<GFile, ConflictAction>

const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS
function isDir(f: GFile): boolean { return f.queryFileType(NOFOLLOW, null) === Gio.FileType.DIRECTORY }

/* Walk the collisions, asking the user per file (Replace/Merge / Skip / Keep Both),
 * honouring an "Apply to all" toggle. Resolves to { resolution, applyAll }; resolution
 * is null if the user cancels the whole operation. `applyAll` is the action chosen
 * with the toggle (or null), so a later pass (nested merge conflicts) can honour it. */
export async function resolveConflicts(parent: any, conflicts: Conflict[]): Promise<{ resolution: Resolution | null; applyAll: ConflictAction | null }> {
  const res: Resolution = new Map()
  let applyAll: ConflictAction | null = null
  for (const c of conflicts) {
    if (applyAll) { res.set(c.src, applyAll); continue }
    const answer = await askOne(parent, c, conflicts.length)
    if (!answer) return { resolution: null, applyAll: null }   /* cancelled → abort everything */
    res.set(c.src, answer.action)
    if (answer.all) applyAll = answer.action
  }
  return { resolution: res, applyAll }
}

function askOne(parent: any, c: Conflict, total: number): Promise<{ action: ConflictAction; all: boolean } | null> {
  return new Promise(resolve => {
    const destDir = c.dest.getParent()
    const where = destDir ? locationName(destDir) : 'this location'
    /* Two directories → a non-destructive recursive merge (labelled "Merge"), still
     * carried as the 'replace' action ("take source"); a leaf → an overwrite. */
    const isMerge = isDir(c.src) && isDir(c.dest)
    const dialog = new Adw.AlertDialog({
      heading: `“${c.name}” already exists`,
      body: isMerge
        ? `A folder named “${c.name}” is already in “${where}”. Merging keeps files from both.`
        : `A file with that name is already in “${where}”.`,
    })
    let all: any = null
    if (total > 1) {
      all = new Gtk.CheckButton({ label: `Apply to all ${total} conflicts`, marginTop: 4 })
      dialog.setExtraChild(all)
    }
    dialog.addResponse('cancel', 'Cancel')
    dialog.addResponse('skip', 'Skip')
    dialog.addResponse('keep-both', 'Keep Both')
    dialog.addResponse('replace', isMerge ? 'Merge' : 'Replace')
    dialog.setResponseAppearance('replace', isMerge ? Adw.ResponseAppearance.SUGGESTED : Adw.ResponseAppearance.DESTRUCTIVE)
    dialog.setDefaultResponse(isMerge ? 'replace' : 'keep-both')
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

interface MergeScan { free: CopyItem[]; conflicts: Conflict[]; prune: GFile[] }

/* Expand a directory-on-directory merge into per-file work: children absent from
 * dest become free copies; child dir-on-dir recurses (auto-merge, non-destructive);
 * leaf collisions (file/file, file/dir, dir/file) are collected for prompting. Every
 * source dir visited is recorded in `prune` so a *move* can rmdir the emptied shells.
 * NOFOLLOW throughout: a symlinked dir is a leaf, so we never follow symlink loops. */
function scanMerge(src: GFile, dest: GFile, out: MergeScan): void {
  out.prune.push(src)
  const en = src.enumerateChildren('standard::name', NOFOLLOW, null)
  let info
  while ((info = en.nextFile(null)) !== null) {
    const name = info.getName()
    const childSrc = src.getChild(name)
    const childDest = dest.getChild(name)
    if (!childDest.queryExists(null)) out.free.push({ src: childSrc, dest: childDest })
    else if (isDir(childSrc) && isDir(childDest)) scanMerge(childSrc, childDest, out)
    else out.conflicts.push({ src: childSrc, name, dest: childDest })
  }
  en.close(null)
}

/* Turn a set of sources + a destination into a runnable copy/move plan, prompting
 * for name collisions and recursively merging directory-on-directory conflicts (so
 * "Replace" of a folder preserves destination-only files). Returns null if the user
 * cancels, else { items, prune, merged }: `prune` is the merge source dirs to
 * rmdir-if-empty after a move; `merged` is true if any directory merge happened
 * (the caller skips undo, since overwritten originals can't be restored). `move`
 * distinguishes cut/move from copy so pasting an item into its own folder is a
 * duplicate/no-op instead of a self-overwrite prompt. */
export async function planTransfer(parent: any, files: GFile[], destDir: GFile, move = false): Promise<{ items: CopyItem[]; prune: GFile[]; merged: boolean } | null> {
  const { free, conflicts } = partitionConflicts(files, destDir)
  const items: CopyItem[] = free.map(src => ({ src, dest: destDir.getChild(src.getBasename()) }))
  const prune: GFile[] = []
  let merged = false

  const real = conflicts.filter(c => {
    if (!c.src.equal(c.dest)) return true
    if (!move) items.push({ src: c.src, dest: uniqueChild(destDir, c.name) })
    return false
  })
  if (!real.length) return { items, prune: [], merged }

  const { resolution, applyAll } = await resolveConflicts(parent, real)
  if (!resolution) return null

  const nested: Conflict[] = []
  for (const c of real) {
    const action = resolution.get(c.src)
    if (action === 'skip') continue
    if (action === 'replace' && isDir(c.src) && isDir(c.dest)) {
      merged = true
      const scan: MergeScan = { free: [], conflicts: [], prune: [] }
      scanMerge(c.src, c.dest, scan)
      items.push(...scan.free)
      nested.push(...scan.conflicts)
      prune.push(...scan.prune)
    } else if (action === 'replace') {
      items.push({ src: c.src, dest: c.dest, replace: true })
    } else {
      items.push({ src: c.src, dest: uniqueChild(destDir, c.name) })
    }
  }

  /* Resolve the leaf conflicts surfaced by the merges. A phase-1 "apply to all"
   * decision blankets these too (no re-prompt); otherwise prompt once. */
  if (nested.length) {
    let map: Resolution
    if (applyAll) {
      map = new Map(nested.map(c => [c.src, applyAll] as const))
    } else {
      const r = await resolveConflicts(parent, nested)
      if (!r.resolution) return null
      map = r.resolution
    }
    for (const c of nested) {
      const action = map.get(c.src)
      if (action === 'skip') continue
      if (action === 'replace') items.push({ src: c.src, dest: c.dest, replace: true })
      else items.push({ src: c.src, dest: uniqueChild(c.dest.getParent(), c.name) })
    }
  }

  return { items, prune: move ? prune : [], merged }
}
