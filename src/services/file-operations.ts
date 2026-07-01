import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { EventEmitter } from '../core/emitter.ts'
import { F } from '../core/gio.ts'
import type { GFile } from '../core/types.ts'

const NONE = Gio.FileCopyFlags.NONE
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS
const TIME_SLICE_MS = 8

type Step = () => void

function fileType(file: GFile): any { return F.queryFileType(file, NOFOLLOW, null) }
function isDir(file: GFile): boolean { return fileType(file) === Gio.FileType.DIRECTORY }

/* A non-colliding child name in destDir. */
function uniqueChild(destDir: GFile, name: string): GFile {
  let child = F.getChild(destDir, name)
  if (!F.queryExists(child, null)) return child
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; ; i++) {
    child = F.getChild(destDir, `${base}${i === 1 ? ' (copy)' : ` (copy ${i})`}${ext}`)
    if (!F.queryExists(child, null)) return child
  }
}

/* A time-sliced, self-expanding job: directory steps enqueue child steps, so
 * discovery and execution interleave on the idle loop and the UI never blocks. */
class Job {
  title: string
  service: FileOperations
  stack: Step[] = []
  done = 0
  discovered = 0

  constructor(title: string, service: FileOperations) {
    this.title = title
    this.service = service
  }

  push(step: Step): void { this.stack.push(step); this.discovered++ }

  run(): void {
    this.service.emit('begin', { title: this.title })
    GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
      const t0 = Number(GLib.getMonotonicTime())   /* getMonotonicTime returns a BigInt */
      while (this.stack.length && (Number(GLib.getMonotonicTime()) - t0) / 1000 < TIME_SLICE_MS) {
        const step = this.stack.pop()!
        try { step() }
        catch (e: any) { this.service.emit('error', { title: this.title, message: e.message }); return false }
        this.done++
      }
      this.service.emit('progress', { title: this.title, done: this.done, total: this.discovered })
      if (this.stack.length) return true
      this.service.emit('done', { title: this.title, count: this.done })
      return false
    })
  }

  copyStep(src: GFile, dest: GFile): Step {
    return () => {
      if (isDir(src)) {
        F.makeDirectoryWithParents(dest, null)
        this._eachChild(src, name => this.push(this.copyStep(F.getChild(src, name), F.getChild(dest, name))))
      } else {
        F.copy(src, dest, NONE, null, null)
      }
    }
  }

  deleteStep(file: GFile): Step {
    return () => {
      if (isDir(file)) {
        this.push(() => F.delete(file, null))   /* runs last: dir removed after contents */
        this._eachChild(file, name => this.push(this.deleteStep(F.getChild(file, name))))
      } else {
        F.delete(file, null)
      }
    }
  }

  moveStep(src: GFile, dest: GFile): Step {
    return () => {
      try {
        F.move(src, dest, NONE, null, null)
      } catch {
        /* cross-device: copy fully, then delete source */
        this.push(this.deleteStep(src))
        this.push(this.copyStep(src, dest))
      }
    }
  }

  _eachChild(dir: GFile, fn: (name: string) => void): void {
    const en = F.enumerateChildren(dir, 'standard::name', NOFOLLOW, null)
    let info
    while ((info = en.nextFile(null)) !== null) fn(info.getName())
    en.close(null)
  }
}

/* Asynchronous file operations with progress.
 * Long ops (copy/move/delete/empty-trash) emit: 'begin' {title},
 * 'progress' {title,done,total}, 'done' {title,count}. Quick ops (trash/rename/
 * new-folder/link) emit 'notify' {message} instead. Both emit 'error'
 * {title,message} on failure. */
export class FileOperations extends EventEmitter {
  /* copy/move return the destination GFiles (collision-resolved up front) so the
   * caller can record a precise inverse for undo. */
  copy(files: GFile[], destDir: GFile): GFile[] {
    const dests = files.map(f => uniqueChild(destDir, F.getBasename(f)))
    const job = new Job(`Copying ${files.length} item${files.length > 1 ? 's' : ''}`, this)
    files.forEach((f, i) => job.push(job.copyStep(f, dests[i])))
    job.run()
    return dests
  }

  move(files: GFile[], destDir: GFile): GFile[] {
    const dests = files.map(f => uniqueChild(destDir, F.getBasename(f)))
    const job = new Job(`Moving ${files.length} item${files.length > 1 ? 's' : ''}`, this)
    files.forEach((f, i) => job.push(job.moveStep(f, dests[i])))
    job.run()
    return dests
  }

  deletePermanently(files: GFile[]): void {
    const job = new Job(`Deleting ${files.length} item${files.length > 1 ? 's' : ''}`, this)
    for (const f of files) job.push(job.deleteStep(f))
    job.run()
  }

  emptyTrash(): void {
    const job = new Job('Emptying Trash', this)
    const trash = Gio.File.newForUri('trash:///')
    const en = F.enumerateChildren(trash, 'standard::name', NONE, null)
    let info
    while ((info = en.nextFile(null)) !== null) job.push(job.deleteStep(F.getChild(trash, info.getName())))
    en.close(null)
    job.run()
  }

  /* Quick, near-instant operations (run inline, report via 'notify'). */
  trash(files: GFile[]): boolean {
    const n = files.length
    return this._quick('Move to Trash', () => files.forEach((f: GFile) => F.trash(f, null)),
      `Moved ${n} item${n > 1 ? 's' : ''} to Trash`)
  }

  /* Restore selected Trash items to their original locations, given each item's
   * trash::orig-path (used by the Trash view's Restore action). */
  restore(pairs: Array<[GFile, string]>): boolean {
    const n = pairs.length
    return this._quick('Restore', () => {
      for (const [item, orig] of pairs) F.move(item, Gio.File.newForPath(orig), NONE, null, null)
    }, `Restored ${n} item${n > 1 ? 's' : ''}`)
  }

  /* Restore items from Trash to their original locations (undo of trash), matched
   * by trash::orig-path. */
  restoreFromTrash(origFiles: GFile[]): boolean {
    const wanted = new Set(origFiles.map(f => F.getPath(f)))
    const n = origFiles.length
    return this._quick('Restore', () => {
      const trash = Gio.File.newForUri('trash:///')
      const en = F.enumerateChildren(trash, 'standard::name,trash::orig-path', NONE, null)
      let info
      while ((info = en.nextFile(null)) !== null) {
        const orig = info.getAttributeByteString('trash::orig-path')
        if (orig && wanted.has(orig)) {
          F.move(F.getChild(trash, info.getName()), Gio.File.newForPath(orig), NONE, null, null)
          wanted.delete(orig)
        }
      }
      en.close(null)
    }, `Restored ${n} item${n > 1 ? 's' : ''}`)
  }
  newFolder(dir: GFile, name: string): GFile {
    const folder = F.getChild(dir, name)
    this._quick('New Folder', () => F.makeDirectory(folder, null), `Created “${name}”`)
    return folder
  }
  rename(file: GFile, newName: string): GFile | null {
    let out: GFile | null = null
    this._quick('Rename', () => { out = F.setDisplayName(file, newName, null) }, `Renamed to “${newName}”`)
    return out
  }
  link(files: GFile[], destDir: GFile): boolean {
    return this._quick('Create Link', () => {
      for (const f of files) F.makeSymbolicLink(uniqueChild(destDir, F.getBasename(f)), F.getPath(f), null)
    }, 'Link created')
  }

  _quick(title: string, fn: () => void, message: string): boolean {
    try { fn() }
    catch (e: any) { this.emit('error', { title, message: e.message }); return false }
    this.emit('notify', { message })
    return true
  }
}
