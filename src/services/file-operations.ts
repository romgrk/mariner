import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { EventEmitter } from '../core/emitter.ts'
import type { CopyItem, GFile } from '../core/types.ts'

const NONE = Gio.FileCopyFlags.NONE
const CREATE_NONE = Gio.FileCreateFlags.NONE
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS
const TIME_SLICE_MS = 8
/* Files at/above this size on a *different* filesystem are copied chunk-by-chunk
 * (StreamCopy) for live byte progress; smaller / same-fs copies use native
 * g_file_copy (reflink, sparse + metadata preservation, near-instant same-fs). */
const STREAM_THRESHOLD = 8 * 1024 * 1024
const CHUNK = 4 * 1024 * 1024

let nextJobId = 0

type Step = () => void

function fileType(file: GFile): any { return file.queryFileType(NOFOLLOW, null) }
function isDir(file: GFile): boolean { return fileType(file) === Gio.FileType.DIRECTORY }
function depth(file: GFile): number { const p = file.getPath(); return p ? p.split('/').length : 0 }

function fileSize(file: GFile): number {
  try { return Number(file.queryInfo('standard::size', NOFOLLOW, null).getSize()) }
  catch { return 0 }
}
function deviceOf(file: GFile): number {
  try { return Number(file.queryInfo('unix::device', NOFOLLOW, null).getAttributeUint32('unix::device')) }
  catch { return -1 }
}
/* Are src and dest on different filesystems? (dest may not exist yet → use its
 * parent). Only a confident "different" answer enables streaming; unknowns fall
 * back to native copy. */
function crossDevice(src: GFile, dest: GFile): boolean {
  const a = deviceOf(src)
  const parent = dest.getParent()
  const b = parent ? deviceOf(parent) : -1
  return a >= 0 && b >= 0 && a !== b
}

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

/* A large single-file copy streamed in chunks so the UI stays responsive and we
 * get byte-level progress. One ~4 MiB chunk per pump; the Job's idle loop calls
 * pumpChunk() until EOF. Best-effort restores mode + mtime after the data copy
 * (userspace chunking loses reflink/sparse — hence gated to large cross-fs files). */
class StreamCopy {
  src: GFile
  dest: GFile
  size: number
  bytesCopied = 0
  fraction = 0
  _in: any = null
  _out: any = null
  _open = false

  constructor(src: GFile, dest: GFile, size: number) {
    this.src = src
    this.dest = dest
    this.size = size
  }

  _ensureOpen(): void {
    if (this._open) return
    this._in = this.src.read(null)
    this._out = this.dest.replace(null, false, CREATE_NONE, null)
    this._open = true
  }

  /* Copy one chunk; true at EOF (streams closed, metadata restored). */
  pumpChunk(): boolean {
    this._ensureOpen()
    const bytes = this._in.readBytes(CHUNK, null)
    const n = Number(bytes.getSize())
    if (n === 0) { this._finish(); return true }
    let b = bytes
    let remaining = n
    while (remaining > 0) {
      const w = Number(this._out.writeBytes(b, null))
      if (w <= 0) break
      remaining -= w
      if (remaining > 0) b = GLib.Bytes.newFromBytes(b, w, remaining)
    }
    this.bytesCopied += n
    this.fraction = this.size > 0 ? Math.min(1, this.bytesCopied / this.size) : 0
    return false
  }

  _finish(): void {
    this._close()
    try {
      const info = this.src.queryInfo('unix::mode,unix::uid,unix::gid,time::modified,time::modified-usec', NOFOLLOW, null)
      this.dest.setAttributesFromInfo(info, NOFOLLOW, null)
    } catch { /* best effort */ }
  }

  _close(): void {
    try { this._out?.close(null) } catch {}
    try { this._in?.close(null) } catch {}
    this._open = false
  }

  /* Cancel mid-copy: drop streams and remove the partial destination. */
  abort(): void {
    this._close()
    try { this.dest.delete(null) } catch {}
  }
}

/* A time-sliced, self-expanding job: directory steps enqueue child steps, so
 * discovery and execution interleave on the idle loop and the UI never blocks.
 * Each job has an id so the operations queue can track, cancel + pause/resume it. */
class Job {
  id = ++nextJobId
  title: string
  service: FileOperations
  stack: Step[] = []
  done = 0
  discovered = 0
  cancelled = false
  paused = false
  sourceId = 0
  /* In-progress chunked file copy (StreamCopy). Counted in `discovered` but not
   * added to `done` until it hits EOF; `partialFraction` carries its 0..1 share. */
  stream: StreamCopy | null = null
  partialFraction = 0

  constructor(title: string, service: FileOperations) {
    this.title = title
    this.service = service
  }

  cancel(): void {
    this.cancelled = true
    /* Re-arm a paused job so _tick runs once, observes `cancelled`, and finishes
     * (otherwise a cancelled-while-paused row would never clear). */
    if (this.paused) { this.paused = false; this._arm() }
  }

  pause(): void {
    if (this.paused || this.cancelled) return
    this.paused = true
    if (this.sourceId) { GLib.sourceRemove(this.sourceId); this.sourceId = 0 }
    this._emitProgress()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this._arm()
    this._emitProgress()
  }

  push(step: Step): void { this.stack.push(step); this.discovered++ }

  run(): void {
    this.service._register(this)
    this.service.emit('begin', { id: this.id, title: this.title })
    this._arm()
  }

  /* Install the idle pump if not already running (pause removes it, resume/cancel
   * re-add it; the guard prevents two sources popping one stack). */
  _arm(): void {
    if (this.sourceId) return
    this.sourceId = GLib.idleAdd(GLib.PRIORITY_DEFAULT_IDLE, this._tick)
  }

  _tick = (): boolean => {
    if (this.cancelled) { this._abortStream(); this.sourceId = 0; this._finish(); return false }
    const t0 = Number(GLib.getMonotonicTime())   /* getMonotonicTime returns a BigInt */
    while ((this.stack.length || this.stream) && !this.cancelled && (Number(GLib.getMonotonicTime()) - t0) / 1000 < TIME_SLICE_MS) {
      if (this.stream) {
        let eof = false
        try { eof = this.stream.pumpChunk() }
        catch (e: any) { this._abortStream(); this.sourceId = 0; this._fail(e.message); return false }
        this.partialFraction = this.stream?.fraction ?? 0
        if (eof) { this.stream = null; this.partialFraction = 0; this.done++ }
        continue
      }
      const step = this.stack.pop()!
      try { step() }
      catch (e: any) { this.sourceId = 0; this._fail(e.message); return false }
      /* A step that started a stream (large-file copy) is counted on EOF, not now. */
      if (!this.stream) this.done++
    }
    this._emitProgress()
    if ((this.stack.length || this.stream) && !this.cancelled) return true
    this.sourceId = 0
    this._finish()
    return false
  }

  _emitProgress(): void {
    this.service.emit('progress', { id: this.id, title: this.title, done: this.done + this.partialFraction, total: this.discovered, paused: this.paused })
  }

  _abortStream(): void {
    if (this.stream) { try { this.stream.abort() } catch {} this.stream = null; this.partialFraction = 0 }
  }

  _fail(message: string): void {
    this.service._unregister(this)
    this.service.emit('error', { id: this.id, title: this.title, message })
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
        const size = fileSize(src)
        if (size >= STREAM_THRESHOLD && crossDevice(src, dest)) this.stream = new StreamCopy(src, dest, size)
        else src.copy(dest, NONE, null, null)
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

  /* rmdir a merge source dir, but only if it's now empty (kernel ENOTEMPTY →
   * quietly left behind, e.g. when a nested leaf was skipped). */
  rmdirStep(dir: GFile): Step {
    return () => { try { dir.delete(null) } catch {} }
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
 * 'progress' {id,title,done,total,paused}, 'done' {id,title,count,cancelled}. Quick
 * ops (trash/rename/new-folder/link) emit 'notify' {message} instead. Both emit
 * 'error' {id?,title,message} on failure. `cancel(id)` / `pause(id)` / `resume(id)`
 * act on an in-flight long op. */
export class FileOperations extends EventEmitter {
  _jobs = new Map<number, Job>()

  _register(job: Job): void { this._jobs.set(job.id, job) }
  _unregister(job: Job): void { this._jobs.delete(job.id) }
  /* Request cancellation of an in-flight long operation by id. */
  cancel(id: number): void { this._jobs.get(id)?.cancel() }
  pause(id: number): void { this._jobs.get(id)?.pause() }
  resume(id: number): void { this._jobs.get(id)?.resume() }

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

  /* `prune` lists merge source directories to rmdir-if-empty after the moves (see
   * Job.rmdirStep). They're pushed first (shallow→deep) so the LIFO stack pops
   * them after every move, deepest-first. */
  moveItems(items: CopyItem[], prune: GFile[] = []): GFile[] {
    const job = new Job(`Moving ${items.length} item${items.length > 1 ? 's' : ''}`, this)
    for (const dir of [...prune].sort((a, b) => depth(a) - depth(b))) job.push(job.rmdirStep(dir))
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
