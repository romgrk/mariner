import Gio from 'gi:Gio-2.0'
import GLib from 'gi:GLib-2.0'
import { EventEmitter } from '../core/emitter.ts'
import { ATTRS, fileForUri } from '../core/gio.ts'
import { tagsService, tagFromUri } from './tags-service.ts'
import type { Entry, GFile } from '../core/types.ts'

const BATCH = 64

/* Lists a tag:// virtual location: the indexed files carrying the URI's tag
 * (tag:/// itself lists every tagged file), each resolved to a GFileInfo like
 * a search result. Indexed files that no longer exist are pruned from the
 * index as they're discovered (the index is a cache of the xattrs).
 *
 * Events mirror DirectoryService so the pane wires it the same way:
 *   'loading'              listing started
 *   'items'   (Entry[])    a batch of resolved entries
 *   'ready'                finished
 */
export class TagLocationService extends EventEmitter {
  cancellable: any = null

  load(location: GFile): void {
    this.cancel()
    const token = this.cancellable = new Gio.Cancellable()
    this.emit('loading')

    const tag = tagFromUri(location.getUri())
    const uris = tag == null ? tagsService.allTaggedUris() : tagsService.filesWith(tag)

    let pending = uris.length
    if (!pending) { this.emit('ready'); return }
    let batch: Entry[] = []
    const flush = (): void => {
      if (batch.length) { this.emit('items', batch); batch = [] }
    }
    const settle = (): void => {
      if (--pending === 0) { flush(); this.emit('ready') }
      else if (batch.length >= BATCH) flush()
    }

    for (const uri of uris) {
      const file = fileForUri(uri)
      file.queryInfoAsync(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, token,
        (_src: any, res: any) => {
          if (token.isCancelled()) return
          try {
            const info = file.queryInfoFinish(res)
            batch.push({ info, file })
          } catch {
            /* The file is gone (moved/deleted outside Mariner) — prune it. */
            tagsService.dropUri(uri)
          }
          settle()
        })
    }
  }

  cancel(): void {
    if (this.cancellable) { try { this.cancellable.cancel() } catch {} this.cancellable = null }
  }
}
