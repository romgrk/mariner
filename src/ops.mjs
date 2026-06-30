import Gio from 'gi:Gio-2.0'
import { F } from './util.mjs'

const NONE = Gio.FileCopyFlags.NONE
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS

function fileType(file) {
  return F.queryFileType(file, NOFOLLOW, null)
}
function exists(file) {
  return F.queryExists(file, null)
}

/* A destination child name that doesn't collide. */
function uniqueChild(destDir, name) {
  let child = F.getChild(destDir, name)
  if (!exists(child)) return child
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? ' (copy)' : ` (copy ${i})`
    child = F.getChild(destDir, base + suffix + ext)
    if (!exists(child)) return child
  }
}

function copyRecursive(src, dest) {
  if (fileType(src) === Gio.FileType.DIRECTORY) {
    F.makeDirectoryWithParents(dest, null)
    const en = F.enumerateChildren(src, 'standard::name', NOFOLLOW, null)
    let info
    while ((info = en.nextFile(null)) !== null)
      copyRecursive(F.getChild(src, info.getName()), F.getChild(dest, info.getName()))
    en.close(null)
  } else {
    F.copy(src, dest, NONE, null, null)
  }
}

function deleteRecursive(file) {
  if (fileType(file) === Gio.FileType.DIRECTORY) {
    const en = F.enumerateChildren(file, 'standard::name', NOFOLLOW, null)
    let info
    while ((info = en.nextFile(null)) !== null)
      deleteRecursive(F.getChild(file, info.getName()))
    en.close(null)
  }
  F.delete(file, null)
}

export function newFolder(parentDir, name) {
  const dir = F.getChild(parentDir, name)
  F.makeDirectory(dir, null)
  return dir
}

export function rename(file, newName) {
  return F.setDisplayName(file, newName, null)
}

/* files: GFile[]. Returns count moved to trash. */
export function trash(files) {
  let n = 0
  for (const f of files) { F.trash(f, null); n++ }
  return n
}

export function deletePermanently(files) {
  let n = 0
  for (const f of files) { deleteRecursive(f); n++ }
  return n
}

export function copyInto(files, destDir) {
  let n = 0
  for (const f of files) {
    copyRecursive(f, uniqueChild(destDir, F.getBasename(f)))
    n++
  }
  return n
}

export function moveInto(files, destDir) {
  let n = 0
  for (const f of files) {
    const dest = uniqueChild(destDir, F.getBasename(f))
    try {
      F.move(f, dest, NONE, null, null)
    } catch {
      copyRecursive(f, dest)
      deleteRecursive(f)
    }
    n++
  }
  return n
}

export function linkInto(files, destDir) {
  let n = 0
  for (const f of files) {
    const link = uniqueChild(destDir, F.getBasename(f))
    F.makeSymbolicLink(link, F.getPath(f), null)
    n++
  }
  return n
}

export function emptyTrash() {
  const trashDir = Gio.File.newForUri('trash:///')
  const en = F.enumerateChildren(trashDir, 'standard::name', NONE, null)
  let info
  while ((info = en.nextFile(null)) !== null)
    deleteRecursive(F.getChild(trashDir, info.getName()))
  en.close(null)
}
