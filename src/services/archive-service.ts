import { EventEmitter } from '../core/emitter.ts'
import { ProcessStream } from '../core/process-stream.ts'
import { F } from '../core/gio.ts'
import type { GFile } from '../core/types.ts'

export type ArchiveFormat = 'zip' | 'tar.xz' | 'tar.gz' | '7z'

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|7z|rar|jar)$/i

export function isArchive(name: string): boolean { return ARCHIVE_RE.test(name) }

/* Extract/compress by shelling out to standard CLI tools via ProcessStream
 * (streams to completion; nautilus uses libarchive/gnome-autoar). GTK-free.
 * Events: 'begin' {title}, 'done' {title}, 'error' {title, message}. */
export class ArchiveService extends EventEmitter {
  extract(archive: GFile, destDir: GFile): void {
    const path = F.getPath(archive)
    const dest = F.getPath(destDir)
    if (!path || !dest) return this._fail('Extract', 'Not a local location')
    const argv = extractArgv(path, dest)
    if (!argv) return this._fail('Extract', 'Unsupported archive format')
    this._run(`Extracting ${F.getBasename(archive)}`, argv)
  }

  compress(files: GFile[], out: GFile, format: ArchiveFormat): void {
    const outPath = F.getPath(out)
    const parent = files.length ? F.getParent(files[0]) : null
    const cwd = parent && F.getPath(parent)
    if (!outPath || !cwd) return this._fail('Compress', 'Not a local location')
    const names = files.map(f => F.getBasename(f))
    this._run(`Compressing ${names.length} item${names.length > 1 ? 's' : ''}`, compressArgv(format, outPath, names), cwd)
  }

  _run(title: string, argv: string[], cwd?: string): void {
    this.emit('begin', { title })
    const stream = new ProcessStream(argv, cwd ? { cwd } : {})
    stream.on('error', (message: string) => this.emit('error', { title, message }))
    stream.on('end', (ok: boolean) => { if (ok) this.emit('done', { title }) })
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
