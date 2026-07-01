# nautilus-clone — handoff

A GNOME Files (nautilus) clone in **node-gtk + TypeScript**, GTK4 + libadwaita.
This doc is the single source of truth for picking the project up. Read it top to
bottom before changing code. Companion docs: `README.md` (user-facing),
`PLAN.md` (original feature plan).

---

## 1. Run & environment

```sh
cd ../nautilus-clone
npm install                 # links local node-gtk; installs typescript + @types/node
npm start                   # = node --import node-gtk/register src/main.ts
npm run typecheck           # = tsc --noEmit   (needs the npm install above)
```

- **TypeScript with no build step.** Node ≥ 22.6 strips `.ts` types at load
  (default-on in the 22.22.3 used here). Source imports use explicit `.ts`
  extensions. `tsconfig.json` enforces erasable-only syntax
  (`erasableSyntaxOnly`, `verbatimModuleSyntax`): **no `enum`/`namespace`/param
  properties; `import type` (or inline `import { type X }`) for type-only
  imports**, else Node keeps the import and crashes on the missing runtime export.
- Requires GTK ≥ 4.16, libadwaita ≥ 1.5 and their typelibs (`Gtk-4.0`, `Adw-1`).
  Verified on GTK 4.22.4 / libadwaita 1.9.1.
- `node_modules/node-gtk` is a symlink to the local `../node-gtk` dev build.
- `src/gi.d.ts` declares `gi:` modules as `any` (no generated GI types).

---

## 2. Current state (implemented + verified)

Everything below runs and was verified (screenshots via the recipe in §5, plus
functional tests):

- **Browse**: async, incremental, cancellable directory listing; grid
  (`Gtk.GridView`) and list (`Gtk.ColumnView`: Name/Size/Type/Modified) sharing
  one `MultiSelection`; folders-first sort.
- **View states**: explicit `loading` / `results` / `empty-folder` /
  `empty-search` / `error` via a `Gtk.Stack` of `Adw.StatusPage`s.
- **Navigation**: double-click/Enter opens (dir → navigate, file →
  `AppInfo.launchDefaultForUri`); breadcrumb pathbar; back/forward/up; per-tab
  history; location entry (Ctrl+L).
- **Tabs**: `Adw.TabView`, new/close/switch, per-tab history + search state.
- **Sidebar**: Recent, Home, XDG special dirs, Trash, bookmarks
  (`~/.config/gtk-3.0/bookmarks`), mounted volumes (`Gio.VolumeMonitor`).
- **Recursive search** (Ctrl+F): runs **out-of-process** (`workers/search-worker.ts`),
  streams matches over a GLib-serviced pipe, resolves each match's metadata async,
  appends incrementally. Empty query shows the current folder; no matches → empty
  state; worker error → error state.
- **Typeahead**: plain typing in a focused view selects the first prefix
  (then substring) match and scrolls to it; resets after ~1s; Backspace/Escape
  editing; Ctrl/Alt chords ignored.
- **Operations** (async, time-sliced, non-blocking, with progress bar + toasts):
  new folder, rename, copy, cut/paste (move), move to trash, delete permanently,
  empty trash, symlink. Copy/move/delete are recursive with auto-renamed
  collisions.
- **Prefs**: sort (name/size/type/modified, asc/desc), show hidden (Ctrl+H),
  zoom (Ctrl+±).
- **Dialogs**: new folder, rename, confirm-delete, properties, about.
- **Live refresh** via `Gio.FileMonitor` (debounced).
- Accelerators wired in `main.ts` (`ACCELS`).

---

## 3. Architecture

Decoupled layers. **Services are GTK-free and event-based** (extend Node's
`EventEmitter`); **UI is widgets only**; **per-tab controllers** wire them.

```
src/
  core/                    pure/runtime primitives — no UI, no service logic
    gio.ts                 F proxy (GFile interface methods via prototype), ctors, ATTRS
    format.ts              displayName / formatSize|Type|Modified / locationName
    comparator.ts          folders-first Comparator + binary-search sortedIndex
    navigation.ts          History (back/forward stacks) — pure
    process-stream.ts      ProcessStream: line-streaming over Gio.Subprocess
    emitter.ts             re-exports Node EventEmitter (loop-safe, pure JS)
    types.ts               Entry, Place, Prefs, ViewConfig, SortKey, Op* payloads
  services/                one responsibility each; emit events; GTK-free
    directory-service.ts   load(dir): 'loading'|'items'|'ready'|'error'|'invalidated'
    search-service.ts      search(dir,q): 'start'|'result'|'end'|'error'
    file-operations.ts     copy/move/delete/trash/rename/newFolder/link/emptyTrash
                           long ops: 'begin'|'progress'|'done'; quick: 'notify'; 'error'
    clipboard-service.ts   copy/cut state; 'changed'
    places-service.ts      getPlaces()/getBookmarks()/getDevices() -> Place[]
  workers/
    search-worker.ts       pure-node recursive walker -> JSON path per line on stdout
  ui/                      widgets only
    file-view.ts           grid+list+state stack; typeahead; sorted incremental insert
    cells.ts               grid/column cell factories
    sidebar.ts             places view (over places-service)
    toolbar.ts             header: history / pathbar|location|search / view menu
    pathbar.ts             breadcrumb buttons
    dialogs.ts             prompt / confirm / properties / about (Adw)
  tab.ts                   Tab controller: binds DirectoryService+SearchService <-> FileView
  window.ts                AppWindow: shell assembly, GAction wiring, op progress UI
  main.ts                  Adw.Application, accelerators, GLib.MainLoop lifecycle
```

### Data flow
- **Listing**: `Tab.navigate` → `DirectoryService.load` emits `loading` →
  `items` (batches) → `ready`. Tab maps each `GFileInfo` to
  `{info, file: dir.getChild(name)}` and calls `FileView.addEntries` (sorted
  insert, switches to `results` on first item). `invalidated` (FileMonitor) →
  reload unless a recursive search is showing.
- **Search**: `AppWindow._setSearch(true)` → `Tab.beginSearch`. Typing →
  `Tab.setSearchQuery` → `SearchService.search` spawns the worker; each `result`
  (`{info, file}`) → `FileView.addEntries`; `end` → `finishLoading('search')`.
- **Operations**: `AppWindow` actions call `FileOperations`; events drive the
  bottom progress bar + toasts. The FileMonitor refreshes the view afterward.

### Key patterns / invariants
- **`Entry` = `{info: GFileInfo, file: GFile}`.** The GFile is also stashed on
  the info wrapper as `info._file` so it survives a round-trip through the
  `Gio.ListStore` (node-gtk keeps wrapper identity + JS props stable — verified).
  `FileView.getSelected()` reads `store.getItem(i)._file`.
- **Sorting is done in JS** (binary-search insert / `Array.sort`), never
  `Gtk.CustomSorter` (its JS compare callback gets `undefined` args in node-gtk).
- **Cancellation**: services hold a `Gio.Cancellable` per operation; a new
  `load`/`search` cancels the previous; async callbacks bail on
  `token.isCancelled()`.
- **Menu actions use action identity + JS state**, never the signal's variant
  (see §4). Sort is 4 mutually-exclusive boolean actions; `_syncSort()` keeps
  their state in sync with `prefs.sortKey`.
- The FileView retains the full unfiltered dataset in `this.all`, so toggling
  hidden/sort does a `rebuild()` without re-listing.

---

## 4. node-gtk gotchas (critical — most bugs came from these)

- **GFile / interface methods live on the interface prototype**, not the
  instance. Always go through the `F` proxy: `F.getPath(file)`,
  `F.enumerateChildren(file, …)` (it does `Gio.File.prototype[m].call(file, …)`).
- **Under ESM `app.run()` returns immediately.** An explicit `GLib.MainLoop` is
  created in `main.ts`, run inside `activate`, and quit on `window-removed` when
  `app.getWindows().length === 0`. Without it, GLib timeouts/async never fire.
- **Signal callbacks drop the emitter (first) arg.** `button 'clicked'` → 0 args;
  `action 'change-state'` → 1 arg; `gesture 'pressed'` → `(nPress, x, y)`;
  `SignalListItemFactory setup/bind` → `(listItem)`; `EventControllerKey
  'key-pressed'` → `(keyval, keycode, state)`.
- **GVariants passed INTO a JS signal callback are corrupted** (NULL/garbage).
  Only read variants you created in JS. This is why menu actions are driven by
  identity + JS state. `GVariant.getString()` returns a `[str, len]` tuple.
- **Async-ready callbacks get `(sourceObject, GAsyncResult, userData)`** — the
  result is **args[1]**. GFile finishers go through the prototype
  (`F.enumerateChildrenFinish(file, res)`).
- **`Gio.DataInputStream.readLineFinish` returns `[bytes, len]`** where bytes is a
  plain `number[]` (decode with `Buffer.from`). **At EOF node-gtk returns an
  empty array, not null** — so treat zero-length as EOF and never emit blank
  lines over the protocol. `ProcessStream` finalizes on stdout+stderr EOF
  (`Gio.Subprocess.waitAsync` was unreliable).
- **`GLib.getMonotonicTime()` returns a BigInt** — `Number(...)` before math.
- **GType**: no `.$gtype`; use `GObject.typeFromName('GFileInfo')` (or
  `instance.__gtype__`), e.g. for `Gio.ListStore.new(type)`.
- **`Adw.Breakpoint.addSetter`** needs a boxed `GObject.Value` (init with
  `typeFromName('gboolean')`, `setBoolean`), not a raw JS `true`.
- camelCase everything (`getHomeDir`, `newForPath`); enums via the namespace
  (`Gtk.Orientation.VERTICAL`).

---

## 5. Verifying changes (this is a headless Wayland box)

Compositor screenshots are blocked, so **render the window to a PNG via GSK**
(no compositor). Pattern used throughout:

```js
import Gtk from 'gi:Gtk-4.0'; import Adw from 'gi:Adw-1'; import GLib from 'gi:GLib-2.0'
import { AppWindow } from '/abs/path/src/window.ts'
import { fileForPath } from '/abs/path/src/core/gio.ts'
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application('com.test.x', 0)
app.on('activate', () => {
  const w = new AppWindow(app, fileForPath('/home/you'))
  GLib.timeoutAdd(0, 1400, () => {           // let it lay out; retry if node is null
    const win = w.window, width = win.getWidth(), height = win.getHeight()
    const pt = Gtk.WidgetPaintable.new(win), s = Gtk.Snapshot.new()
    pt.snapshot(s, width, height)
    const node = s.toNode()                  // null on an un-drawn frame → queueDraw + retry
    if (node) win.getRenderer().renderTexture(node, null).saveToPng('/tmp/out.png')
    loop.quit(); return false
  })
  loop.run()
})
app.run()
```
Run with `node --import node-gtk/register /tmp/harness.mjs` **from the clone dir**
(so `node-gtk/register` resolves). Filter noise:
`2>&1 | grep -vE "Vulkan|Gdk-WARNING"`. A `.mjs` harness may import the app's
`.ts` modules directly. Drive behaviour by calling controller methods
(`w.activeTab.navigate(...)`, `w._setSearch(true)`, `view._onTypeaheadKey(...)`).
Services can be tested headless against `/tmp` dirs (see prior `/tmp/*.mjs`).

---

## 6. Next points (P2/P3)

Roughly priority-ordered. Each notes where it hooks in.

1. **Thumbnails** for images/video. Add a `services/thumbnail-service.ts`
   (GnomeDesktop.DesktopThumbnailFactory, or generate via GdkPixbuf/glycin) that
   resolves a `GdkTexture` per file async; `cells.ts` bind swaps the icon when
   ready. Cache by uri+mtime.
2. **Undo/redo** of operations. Give `file-operations.ts` an undo stack
   (record inverse ops: trash↔restore, move-back, delete-created). Wire
   `win.undo`/`win.redo` (Ctrl+Z/Y) + toast "Undo" action after trash.
3. **System clipboard + DnD.** Current clipboard is in-app only. Implement
   `Gdk.ContentProvider` with `text/uri-list` + `x-special/gnome-copied-files`
   for real cut/copy/paste across apps; add `Gtk.DragSource` on cells and
   `Gtk.DropTarget` on the view (accept `Gdk.FileList` → move/copy into dir).
   Verify content-provider marshalling in node-gtk first.
4. **Archive extract/compress.** `services/archive-service.ts` shelling to
   `libarchive`/`tar`/`unzip` via `ProcessStream` (streams progress). Context-menu
   items `extract-here` / `compress…` (compress dialog exists in nautilus blp).
5. **Rich search** (nautilus search popover): filter by date range / file type,
   content search. Extend `search-worker.ts` args + a popover under the search
   entry in `toolbar.ts`.
6. **Batch rename** dialog (nautilus-batch-rename): multi-select → find/replace or
   numbered template. New dialog in `ui/dialogs.ts` + `file-operations` batch.
7. **Preferences** (`app.preferences`) and **Keyboard Shortcuts** window
   (`app.shortcuts`) — currently unimplemented app actions.
8. **Properties**: editable permissions, folder content-size calc (async walk),
   open-with default chooser.
9. **Trash UX**: show an "Empty Trash" / "Restore" bar when viewing `trash:///`
   (the `win.empty-trash` action exists but has no entry point yet); per-item
   Restore.
10. **Column chooser / captions**, **set as wallpaper**, **compress**, **open in
    terminal** — smaller context-menu items nautilus has.

---

## 7. Known limitations / rough edges

- **Clipboard is in-app only**; no DnD (see next-point 3).
- **No rubber-band selection** — `Gtk.GridView`/`ColumnView` don't provide it
  (nautilus implements a custom one). Ctrl/Shift-click + Ctrl+A work.
- **`link` op** exists in `file-operations.ts` but has no menu/action yet.
- **`empty-trash` action** exists but no UI entry point.
- **Icons only** (no thumbnails).
- XDG special dirs are hidden when they resolve to `$HOME` (this machine's config).
- Search matches **name only**.
- Large single-file copies show a **pulsing** (indeterminate) progress bar, not a
  percentage (total is discovered as the job runs).
- `tsc` isn't vendored — `npm install` before `npm run typecheck`. The app runs
  without it (types are stripped at load).

---

## 8. Commits so far

- `feat: nautilus clone …` — initial P0+P1 (was `.mjs`).
- `refactor: TypeScript rewrite with decoupled service architecture + recursive search`.
- `feat: typeahead (type-to-select) in the file view`.
