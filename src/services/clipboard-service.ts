import { EventEmitter } from '../core/emitter.ts'
import type { GFile } from '../core/types.ts'

/* In-app file clipboard (copy/cut state). Events: 'changed'. */
export class ClipboardService extends EventEmitter {
  files: GFile[] = []
  cut = false

  get isEmpty(): boolean { return this.files.length === 0 }

  set(files: GFile[], cut: boolean): void {
    this.files = files
    this.cut = cut
    this.emit('changed')
  }

  clear() {
    this.files = []
    this.cut = false
    this.emit('changed')
  }
}
