import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { EventEmitter } from '../core/emitter.ts'
import type { CopyItem, GFile } from '../core/types.ts'

const NONE = Gio.FileCopyFlags.NONE
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS
const TIME_SLICE_MS = 8

let nextJobId = 0

type Step = () => void

function fileType(file: GFile): any { return file.queryFileType(NOFOLLOW, null) }
function isDir(file: GFile): boolean { return fileType(file) === Gio.FileType.DIRECTORY }

/* A non-colliding child name in destDir (auto-rename, e.g. "file (copy).txt").
 * Exported so the conflict-resolution path can build "Keep Both" destinations. */
export function uniqueChild(destDir: GFile, name: string): GFile {
  let child = destDir.getChild(name)
  if (!child.queryExists(null)) return child
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; ; i++) {
    child = destDir.getChild(`${base}${i === 1 ? ' (copy)' : ` (copy ${i})`}${ext}`)
    if (!child.queryExists(null)) return child
  }
}

/* A time-sliced, self-expanding job: directory steps enqueue child steps, so
 * discovery and execution interleave on the idle loop and the UI never blocks.
 * Each job has an id so the operations queue can track + cancel it. */
class Job {
  id = ++nextJobId
  title: string
  service: FileOperations
  stack: Step[] = []
  done = 0
  discovered = 0
  cancelled = false

  constructor(title: string, service: FileOperations) {
    this.title = title
    this.service = service
  }

  cancel(): void { this.cancelled = true }

  push(step: Step): void { this.stack.push(step); this.discovered++ }

  run(): void {
    this.service._register(this)
    this.service.emit('begin', { id: this.id, title: this.title })
    GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this.cancelled) { this._finish(); return false }
      const t0 = Number(GLib.getMonotonicTime())   /* getMonotonicTime returns a BigInt */
      while (this.stack.length && !this.cancelled && (Number(GLib.getMonotonicTime()) - t0) / 1000 < TIME_SLICE_MS) {
        const step = this.stack.pop()!
        try { step() }
        catch (e: any) {
          this.service._unregister(this)
          this.service.emit('error', { id: this.id, title: this.title, message: e.message })
          return false
        }
        this.done++
      }
      this.service.emit('progress', { id: this.id, title: this.title, done: this.done, total: this.discovered })
      if (this.stack.length && !this.cancelled) return true
      this._finish()
      return false
    })
  }

  _finish(): void {
    this.service._unregister(this)
    this.service.emit('done', { id: this.id, title: this.title, count: this.done, cancelled: this.cancelled })
  }

  copyStep(src: GFile, dest: GFile): Step {
    return () => {
      if (isDir(src)) {
        dest.makeDirectoryWithParents(null)
        this._eachChild(src, name => this.push(this.copyStep(src.getChild(name), dest.getChild(name))))
      } else {
        src.copy(dest, NONE, null, null)
      }
    }
  }

  deleteStep(file: GFile): Step {
    return () => {
      if (isDir(file)) {
        this.push(() => file.delete(null))   /* runs last: dir removed after contents */
        this._eachChild(file, name => this.push(this.deleteStep(file.getChild(name))))
      } else {
        file.delete(null)
      }
    }
  }

  moveStep(src: GFile, dest: GFile): Step {
    return () => {
      try {
        src.move(dest, NONE, null, null)
      } catch {
        /* cross-device: copy fully, then delete source */
        this.push(this.deleteStep(src))
        this.push(this.copyStep(src, dest))
      }
    }
  }

  _eachChild(dir: GFile, fn: (name: string) => void): void {
    const en = dir.enumerateChildren('standard::name', NOFOLLOW, null)
    let info
    while ((info = en.nextFile(null)) !== null) fn(info.getName())
    en.close(null)
  }
}

/* Asynchronous file operations with progress.
 * Long ops (copy/move/delete/empty-trash) emit: 'begin' {id,title},
 * 'progress' {id,title,done,total}, 'done' {id,title,count,cancelled}. Quick ops
 * (trash/rename/new-folder/link) emit 'notify' {message} instead. Both emit
 * 'error' {id?,title,message} on failure. `cancel(id)` stops a long op. */
export class FileOperations extends EventEmitter {
  _jobs = new Map<number, Job>()

  _register(job: Job): void { this._jobs.set(job.id, job) }
  _unregister(job: Job): void { this._jobs.delete(job.id) }
  /* Request cancellation of an in-flight long operation by id. */
  cancel(id: number): void { this._jobs.get(id)?.cancel() }

  /* Run an explicit copy/move plan (destinations already collision-resolved) and
   * return those destinations so the caller can record a precise undo. `replace`
   * items delete the existing destination first, so nested copies never
   * re-conflict. */
  copyItems(items: CopyItem[]): GFile[] {
    const job = new Job(`Copying ${items.length} item${items.length > 1 ? 's' : ''}`, this)
    for (const it of items) {
      job.push(job.copyStep(it.src, it.dest))
      if (it.replace && it.dest.queryExists(null)) job.push(job.deleteStep(it.dest))
    }
    job.run()
    return items.map(i => i.dest)
  }

  moveItems(items: CopyItem[]): GFile[] {
    const job = new Job(`Moving ${items.length} item${items.length > 1 ? 's' : ''}`, this)
    for (const it of items) {
      job.push(job.moveStep(it.src, it.dest))
      if (it.replace && it.dest.queryExists(null)) job.push(job.deleteStep(it.dest))
    }
    job.run()
    return items.map(i => i.dest)
  }

  /* Auto-rename wrappers (no conflict prompt) for callers without a resolved
   * plan: system-clipboard paste, undo/redo re-runs. */
  copy(files: GFile[], destDir: GFile): GFile[] {
    return this.copyItems(files.map(f => ({ src: f, dest: uniqueChild(destDir, f.getBasename()) })))
  }

  move(files: GFile[], destDir: GFile): GFile[] {
    return this.moveItems(files.map(f => ({ src: f, dest: uniqueChild(destDir, f.getBasename()) })))
  }

  deletePermanently(files: GFile[]): void {
    const job = new Job(`Deleting ${files.length} item${files.length > 1 ? 's' : ''}`, this)
    for (const f of files) job.push(job.deleteStep(f))
    job.run()
  }

  emptyTrash(): void {
    const job = new Job('Emptying Trash', this)
    const trash = Gio.File.newForUri('trash:///')
    const en = trash.enumerateChildren('standard::name', NONE, null)
    let info
    while ((info = en.nextFile(null)) !== null) job.push(job.deleteStep(trash.getChild(info.getName())))
    en.close(null)
    job.run()
  }

  /* Quick, near-instant operations (run inline, report via 'notify'). */
  trash(files: GFile[]): boolean {
    const n = files.length
    return this._quick('Move to Trash', () => files.forEach((f: GFile) => f.trash(null)),
      `Moved ${n} item${n > 1 ? 's' : ''} to Trash`)
  }

  /* Restore selected Trash items to their original locations, given each item's
   * trash::orig-path (used by the Trash view's Restore action). */
  restore(pairs: Array<[GFile, string]>): boolean {
    const n = pairs.length
    return this._quick('Restore', () => {
      for (const [item, orig] of pairs) item.move(Gio.File.newForPath(orig), NONE, null, null)
    }, `Restored ${n} item${n > 1 ? 's' : ''}`)
  }

  /* Restore selected Trash items into an explicit destination folder (the Trash
   * view's "Restore to…" chooser), collision-resolving each by its original
   * display name so two same-named items don't clobber each other. */
  restoreTo(items: Array<{ file: GFile; name: string }>, destDir: GFile): boolean {
    const n = items.length
    return this._quick('Restore', () => {
      for (const { file, name } of items) file.move(uniqueChild(destDir, name), NONE, null, null)
    }, `Restored ${n} item${n > 1 ? 's' : ''}`)
  }

  /* Restore items from Trash to their original locations (undo of trash), matched
   * by trash::orig-path. */
  restoreFromTrash(origFiles: GFile[]): boolean {
    const wanted = new Set(origFiles.map(f => f.getPath()))
    const n = origFiles.length
    return this._quick('Restore', () => {
      const trash = Gio.File.newForUri('trash:///')
      const en = trash.enumerateChildren('standard::name,trash::orig-path', NONE, null)
      let info
      while ((info = en.nextFile(null)) !== null) {
        const orig = info.getAttributeByteString('trash::orig-path')
        if (orig && wanted.has(orig)) {
          trash.getChild(info.getName()).move(Gio.File.newForPath(orig), NONE, null, null)
          wanted.delete(orig)
        }
      }
      en.close(null)
    }, `Restored ${n} item${n > 1 ? 's' : ''}`)
  }
  newFolder(dir: GFile, name: string): GFile {
    const folder = dir.getChild(name)
    this._quick('New Folder', () => folder.makeDirectory(null), `Created “${name}”`)
    return folder
  }
  rename(file: GFile, newName: string): GFile | null {
    let out: GFile | null = null
    this._quick('Rename', () => { out = file.setDisplayName(newName, null) }, `Renamed to “${newName}”`)
    return out
  }
  link(files: GFile[], destDir: GFile): boolean {
    return this._quick('Create Link', () => {
      for (const f of files) uniqueChild(destDir, f.getBasename()).makeSymbolicLink(f.getPath(), null)
    }, 'Link created')
  }

  _quick(title: string, fn: () => void, message: string): boolean {
    try { fn() }
    catch (e: any) { this.emit('error', { title, message: e.message }); return false }
    this.emit('notify', { message })
    return true
  }
}
