import GLib from 'gi:GLib-2.0'
import Gdk from 'gi:Gdk-4.0'
import GdkPixbuf from 'gi:GdkPixbuf-2.0'
import { createHash } from 'node:crypto'
import { HOME } from '../core/format.ts'

const SIZE = 256                          /* generated thumbnail edge, px */
const MAX_BYTES = 30 * 1024 * 1024        /* skip generating for huge images */
const CACHE_DIRS = ['large', 'normal'].map(s => `${HOME}/.cache/thumbnails/${s}`)

export interface ThumbRequest {
  key: string          /* cache key, e.g. uri + '|' + mtime */
  path: string         /* local filesystem path */
  uri: string          /* file:// uri, for the freedesktop cache lookup */
  contentType: string
  bytes: number
}
type Cb = (texture: any | null) => void

/* Resolves a GdkTexture thumbnail per file, asynchronously and lazily. First
 * consults the shared freedesktop cache (~/.cache/thumbnails/{large,normal}),
 * then generates one for images via GdkPixbuf. Work runs one item per low-prio
 * idle tick so scrolling stays smooth; results are cached (including misses) by
 * key. GTK-touching but UI-free — a single shared instance is exported. */
export class ThumbnailService {
  _cache = new Map<string, any>()
  _waiters = new Map<string, Cb[]>()
  _queue: ThumbRequest[] = []
  _idle = 0

  /* cb fires synchronously on a cache hit, else when the thumbnail resolves
   * (with null if there is none). */
  request(req: ThumbRequest, cb: Cb): void {
    if (this._cache.has(req.key)) { cb(this._cache.get(req.key)); return }
    const waiters = this._waiters.get(req.key)
    if (waiters) { waiters.push(cb); return }
    this._waiters.set(req.key, [cb])
    this._queue.push(req)
    this._kick()
  }

  _kick(): void {
    if (this._idle) return
    this._idle = GLib.idleAdd(GLib.PRIORITY_LOW, () => {
      const task = this._queue.shift()
      if (task) this._resolve(task)
      if (this._queue.length) return true
      this._idle = 0
      return false
    })
  }

  _resolve(task: ThumbRequest): void {
    let texture: any = null
    try { texture = this._fromCache(task.uri) ?? this._generate(task) } catch { texture = null }
    this._cache.set(task.key, texture)
    const waiters = this._waiters.get(task.key) ?? []
    this._waiters.delete(task.key)
    for (const cb of waiters) cb(texture)
  }

  _fromCache(uri: string): any | null {
    const md5 = createHash('md5').update(uri).digest('hex')
    for (const dir of CACHE_DIRS) {
      const p = `${dir}/${md5}.png`
      if (GLib.fileTest(p, GLib.FileTest.EXISTS)) {
        try { return Gdk.Texture.newFromFilename(p) } catch { /* stale/corrupt */ }
      }
    }
    return null
  }

  _generate(task: ThumbRequest): any | null {
    if (task.bytes > MAX_BYTES || !task.contentType.startsWith('image/')) return null
    const pixbuf = GdkPixbuf.Pixbuf.newFromFileAtScale(task.path, SIZE, SIZE, true)
    return Gdk.Texture.newForPixbuf(pixbuf)
  }
}

export const thumbnails = new ThumbnailService()
