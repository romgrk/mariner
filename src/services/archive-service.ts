import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import type { GFile } from '../core/types.ts'

export type ArchiveFormat = 'zip' | 'tar.xz' | 'tar.gz' | '7z'

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|7z|rar|jar)$/i

export function isArchive(name: string): boolean { return ARCHIVE_RE.test(name) }

let nextArchiveId = 0

/* Extract/compress by shelling out to standard CLI tools via ProcessStream
 * (streams to completion; nautilus uses libarchive/gnome-autoar). GTK-free.
 * Speaks the same op protocol as FileOperations (with an `id`, no byte-level
 * progress): 'begin' {id,title}, 'done' {id,title}, 'error' {id,title,message}. */
export class ArchiveService extends EventEmitter {
  extract(archive: GFile, destDir: GFile): void {
    const path = archive.getPath()
    const dest = destDir.getPath()
    if (!path || !dest) return this._fail('Extract', 'Not a local location')
    const argv = extractArgv(path, dest)
    if (!argv) return this._fail('Extract', 'Unsupported archive format')
    this._run(`Extracting ${archive.getBasename()}`, argv)
  }

  compress(files: GFile[], out: GFile, format: ArchiveFormat): void {
    const outPath = out.getPath()
    const parent = files.length ? files[0].getParent() : null
    const cwd = parent && parent.getPath()
    if (!outPath || !cwd) return this._fail('Compress', 'Not a local location')
    const names = files.map(f => f.getBasename())
    this._run(`Compressing ${names.length} item${names.length > 1 ? 's' : ''}`, compressArgv(format, outPath, names), cwd)
  }

  _run(title: string, argv: string[], cwd?: string): void {
    const id = ++nextArchiveId
    this.emit('begin', { id, title })
    const stream = new ProcessStream(argv, cwd ? { cwd } : {})
    stream.on('error', (message: string) => this.emit('error', { id, title, message }))
    stream.on('end', (ok: boolean) => { if (ok) this.emit('done', { id, title }) })
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
