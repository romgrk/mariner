import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import GLib from 'gi:GLib-2.0'
import GObject from 'gi:GObject-2.0'
import type { GFile } from '../core/types.ts'

const FILE_LIST_TYPE = GObject.typeFromName('GdkFileList')

function fileListValue(files: GFile[]): any {
  const v = new GObject.Value()
  v.init(FILE_LIST_TYPE)
  v.setBoxed(Gdk.FileList.newFromList(files))
  return v
}

/* Content provider carrying files for the system clipboard: both text/uri-list
 * and x-special/gnome-copied-files (the format nautilus/GTK apps paste), so our
 * cut/copy is understood by other file managers. */
export function fileClipboardProvider(files: GFile[], cut: boolean): any {
  const uris = files.map(f => f.getUri())
  const uriList = new GLib.Bytes(Buffer.from(uris.join('\r\n') + '\r\n', 'utf8'))
  const gnome = new GLib.Bytes(Buffer.from(`${cut ? 'cut' : 'copy'}\n${uris.join('\n')}`, 'utf8'))
  return Gdk.ContentProvider.newUnion([
    Gdk.ContentProvider.newForBytes('x-special/gnome-copied-files', gnome),
    Gdk.ContentProvider.newForBytes('text/uri-list', uriList),
  ])
}

/* Drag source dragging files out as a GdkFileList (understood as text/uri-list
 * by other apps). getFiles is queried at drag start. */
export function makeDragSource(getFiles: () => GFile[]): any {
  const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE })
  source.on('prepare', () => {
    const files = getFiles()
    if (!files.length) return null
    try { return Gdk.ContentProvider.newForValue(fileListValue(files)) } catch { return null }
  })
  return source
}

/* Drop target accepting a GdkFileList (files dragged in from other apps or this
 * one); onDrop receives the resolved GFiles. */
export function makeDropTarget(onDrop: (files: GFile[]) => void): any {
  const target = Gtk.DropTarget.new(FILE_LIST_TYPE, Gdk.DragAction.COPY)
  target.on('drop', (...a: any[]) => {
    const files = extractFiles(a[0])
    if (!files.length) return false
    onDrop(files)
    return true
  })
  return target
}

/* The dropped value is a GdkFileList (possibly wrapped in a GObject.Value under
 * node-gtk); pull the GFile array out defensively. */
function extractFiles(value: any): GFile[] {
  try {
    const list = value && typeof value.getBoxed === 'function' ? value.getBoxed() : value
    const files = list && typeof list.getFiles === 'function' ? list.getFiles() : list
    return Array.isArray(files) ? files : []
  } catch { return [] }
}
