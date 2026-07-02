import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import type { GFile } from '../core/types.ts'

export type ArchiveFormat = 'zip' | 'tar.xz' | 'tar.gz' | '7z'

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|7z|rar|jar)$/i

export function isArchive(name: string): boolean { return ARCHIVE_RE.test(name) }

/* C locale so the per-file lines we count aren't localized. */
const ENV = { LC_ALL: 'C' }

let nextArchiveId = 0

/* Running progress for one op; `onLine` mutates it as the tool emits per-file lines. */
interface Prog { done: number; total: number }
type LineParser = (line: string, p: Prog) => boolean   /* true → emit an update */

const count7z: LineParser = (line, p) => { if (/^- /.test(line)) { p.done++; return true } return false }
const countUnzip: LineParser = (line, p) => { if (/(inflating|extracting|creating|linking):/.test(line)) { p.done++; return true } return false }
const countTar: LineParser = (_line, p) => { p.done++; return true }

/* Extract/compress by shelling out to standard CLI tools via ProcessStream
 * (streams to completion; nautilus uses libarchive/gnome-autoar). GTK-free.
 * Speaks the op protocol (with an `id`): 'begin' {id,title}, 'progress'
 * {id,title,done,total}, 'done' {id,title}, 'error' {id,title,message}. Extraction
 * of zip/7z/plain-tar reports a real percentage (cheap entry pre-count + per-file
 * output lines); compressed tars/rar/compression fall back to the queue's pulse. */
export class ArchiveService extends EventEmitter {
  _streams = new Map<number, ProcessStream>()

  pause(id: number): void { this._streams.get(id)?.pause() }
  resume(id: number): void { this._streams.get(id)?.resume() }

  async extract(archive: GFile, destDir: GFile): Promise<void> {
    const path = archive.getPath()
    const dest = destDir.getPath()
    if (!path || !dest) return this._fail('Extract', 'Not a local location')
    const p = path.toLowerCase()
    const title = `Extracting ${archive.getBasename()}`

    /* Determinate for the formats with a cheap index read + per-file output. */
    if (p.endsWith('.7z')) {
      const total = await this._count(['7z', 'l', '-ba', path])
      return this._run(title, ['7z', 'x', '-y', '-bd', '-bb1', '-o' + dest, path], { total, onLine: count7z })
    }
    if (p.endsWith('.zip') || p.endsWith('.jar')) {
      const total = await this._count(['unzip', '-Z1', path])
      return this._run(title, ['unzip', '-o', path, '-d', dest], { total, onLine: countUnzip })
    }
    if (/\.tar$/.test(p)) {
      const total = await this._count(['tar', '-tf', path])
      return this._run(title, ['tar', '-xvf', path, '-C', dest], { total, onLine: countTar })
    }

    /* Compressed tars (pre-count would cost a full decompress), rar, etc. → pulse. */
    const argv = extractArgv(path, dest)
    if (!argv) return this._fail('Extract', 'Unsupported archive format')
    this._run(title, argv)
  }

  compress(files: GFile[], out: GFile, format: ArchiveFormat): void {
    const outPath = out.getPath()
    const parent = files.length ? files[0].getParent() : null
    const cwd = parent && parent.getPath()
    if (!outPath || !cwd) return this._fail('Compress', 'Not a local location')
    const names = files.map(f => f.getBasename())
    this._run(`Compressing ${names.length} item${names.length > 1 ? 's' : ''}`, compressArgv(format, outPath, names), { cwd })
  }

  /* Count stdout lines of a quick listing command (entry count for progress). Best
   * effort: resolves 0 on failure, which leaves the op indeterminate (pulsing). */
  _count(argv: string[]): Promise<number> {
    return new Promise(resolve => {
      let n = 0
      const s = new ProcessStream(argv, { env: ENV, rawLines: true })
      s.on('line', () => { n++ })
      s.on('end', () => resolve(n))
      s.start()
    })
  }

  _run(title: string, argv: string[], opts: { cwd?: string; total?: number; onLine?: LineParser } = {}): void {
    const id = ++nextArchiveId
    const prog: Prog = { done: 0, total: opts.total ?? 0 }
    this.emit('begin', { id, title })
    if (prog.total > 0) this.emit('progress', { id, title, done: 0, total: prog.total })
    const stream = new ProcessStream(argv, { cwd: opts.cwd, env: ENV, rawLines: true })
    this._streams.set(id, stream)
    if (opts.onLine) stream.on('line', (line: string) => {
      if (opts.onLine!(line, prog)) this.emit('progress', { id, title, done: prog.done, total: prog.total })
    })
    stream.on('error', (message: string) => { this._streams.delete(id); this.emit('error', { id, title, message }) })
    stream.on('end', (ok: boolean) => { this._streams.delete(id); if (ok) this.emit('done', { id, title }) })
    stream.start()
  }

  _fail(title: string, message: string): void { this.emit('error', { title, message }) }
}

function extractArgv(path: string, dest: string): string[] | null {
  const p = path.toLowerCase()
  if (p.endsWith('.zip') || p.endsWith('.jar')) return ['unzip', '-o', path, '-d', dest]
  if (/\.(tar(\.(gz|bz2|xz|zst))?|tgz|tbz2?|txz)$/.test(p)) return ['tar', '-xf', path, '-C', dest]
  if (p.endsWith('.7z')) return ['7z', 'x', '-y', '-o' + dest, path]
  if (p.endsWith('.rar')) return ['unar', '-f', '-o', dest, path]
  return null
}

function compressArgv(format: ArchiveFormat, out: string, names: string[]): string[] {
  switch (format) {
    case 'zip': return ['zip', '-r', out, ...names]
    case 'tar.gz': return ['tar', '-czf', out, ...names]
    case 'tar.xz': return ['tar', '-cJf', out, ...names]
    case '7z': return ['7z', 'a', out, ...names]
  }
}
