import { EventEmitter } from '../core/emitter.ts'

/* One reversible action. `undo`/`redo` re-run the inverse/forward operation;
 * they call FileOperations directly (never through the recording path), so
 * replaying an undo does not itself get recorded. Labels are shown in the menu
 * and toasts (nautilus shows e.g. "Undo Move to Trash"). */
export interface UndoEntry {
  undo: () => void
  redo: () => void
  undoLabel: string
  redoLabel: string
}

/* A plain undo/redo stack. GTK-free and operation-agnostic: it stores inverse
 * closures the caller (window) supplies, mirroring nautilus's
 * NautilusFileUndoManager but without knowing any file semantics itself.
 * Event: 'changed'. */
export class UndoService extends EventEmitter {
  _undo: UndoEntry[] = []
  _redo: UndoEntry[] = []

  push(entry: UndoEntry): void {
    this._undo.push(entry)
    this._redo = []
    this.emit('changed')
  }

  undo(): void {
    const entry = this._undo.pop()
    if (!entry) return
    entry.undo()
    this._redo.push(entry)
    this.emit('changed')
  }

  redo(): void {
    const entry = this._redo.pop()
    if (!entry) return
    entry.redo()
    this._undo.push(entry)
    this.emit('changed')
  }

  get canUndo(): boolean { return this._undo.length > 0 }
  get canRedo(): boolean { return this._redo.length > 0 }
  get undoLabel(): string { return this.canUndo ? this._undo[this._undo.length - 1].undoLabel : 'Undo' }
  get redoLabel(): string { return this.canRedo ? this._redo[this._redo.length - 1].redoLabel : 'Redo' }

  clear(): void { this._undo = []; this._redo = []; this.emit('changed') }
}
