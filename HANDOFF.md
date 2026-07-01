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
  walks **breadth-first** (FIFO queue, like nautilus-search-engine-simple) so
  matches nearest the root surface first, streams matches over a GLib-serviced
  pipe, resolves each match's metadata async, appends incrementally. Empty query
  shows the current folder; no matches → empty state; worker error → error state.
- **Typeahead**: plain typing in a focused view selects the first prefix
  (then substring) match and scrolls to it; the current query shows in a
  bottom-right floating pill (nautilus-style); resets after ~1s;
  Backspace/Escape editing; Ctrl/Alt chords ignored.
- **Operations** (async, time-sliced, non-blocking, with progress bar + toasts):
  new folder, rename, copy, cut/paste (move), move to trash, delete permanently,
  empty trash, symlink, restore-from-trash. Copy/move/delete are recursive with
  auto-renamed collisions. **Undo/redo** (Ctrl+Z/Y) of all of the above.
- **Thumbnails** for images (freedesktop cache + GdkPixbuf, lazy on idle).
- **Clipboard/DnD**: cut/copy publish to the system clipboard; drag files out and
  drop files in (see §7 for the verification caveat).
- **Rich search**: recursive name search + funnel filter (category + date window).
- **Batch rename** (multi-select: find/replace or numbered, live preview).
- **Archive**: Extract Here / Compress… (zip/tar.*/7z via CLI tools).
- **Trash view**: Empty-Trash banner + Restore.
- **Context/app extras**: Open With…, Open in New Tab, Open in Terminal, Set as
  Wallpaper, Create Link.
- **Prefs**: sort (name/size/type/modified, asc/desc), show hidden (Ctrl+H),
  zoom (Ctrl+±), list/grid (Ctrl+1/2, reset Ctrl+0); **Preferences dialog**.
- **Dialogs**: new folder, rename, batch rename, confirm-delete, properties
  (+ async folder size), compress, open-with, preferences, keyboard shortcuts,
  about.
- **Live refresh** via `Gio.FileMonitor` (debounced).
- Accelerators wired in `main.ts` (`ACCELS`); Keyboard Shortcuts window lists them.
- **Interaction**: the file view grabs focus on load/navigation (so typeahead
  and selection keys work immediately — no click required); scroll resets to top
  on navigation (kept on refresh); primary click on empty space clears the
  selection + focuses the view; search exits to the pathbar on Escape or on
  empty focus-out (not when the filter popover opens); window remembers its size.

---

## 3. Architecture

Decoupled layers. **Services are GTK-free and event-based** (extend Node's
`EventEmitter`); **UI is widgets only**; **per-tab controllers** wire them.

```
src/
  core/                    pure/runtime primitives — no UI, no service logic
    gio.ts                 F proxy (GFile interface methods via prototype), ctors, ATTRS
    format.ts              displayName / formatSize|Bytes|Type|Modified / locationName
    comparator.ts          folders-first Comparator + binary-search sortedIndex
    navigation.ts          History (back/forward stacks) — pure
    process-stream.ts      ProcessStream: line-streaming over Gio.Subprocess (opt. cwd)
    measure.ts             async recursive disk-usage walk (node fs) for Properties
    emitter.ts             re-exports Node EventEmitter (loop-safe, pure JS)
    types.ts               Entry, Place, Prefs, ViewConfig, SortKey, SearchFilter, Op*
  services/                one responsibility each; emit events; GTK-free
    directory-service.ts   load(dir): 'loading'|'items'|'ready'|'error'|'invalidated'
    search-service.ts      search(dir,q,{filter}): 'start'|'result'|'end'|'error'
    file-operations.ts     copy/move/delete/trash/rename/newFolder/link/restore/emptyTrash
                           long ops: 'begin'|'progress'|'done'; quick: 'notify'; 'error'
    undo-service.ts        pure undo/redo stack of inverse closures; 'changed'
    thumbnail-service.ts   shared: fd-cache lookup + GdkPixbuf generation (idle); exports `thumbnails`
    archive-service.ts     extract/compress via CLI tools (ProcessStream); 'begin'|'done'|'error'
    clipboard-service.ts   in-app copy/cut state; 'changed' (system clipboard: ui/dnd.ts)
    places-service.ts      getPlaces()/getBookmarks()/getDevices() -> Place[]
    window-state.ts        persist/restore window geometry (JSON under user config dir)
  workers/
    search-worker.ts       pure-node BREADTH-FIRST walker -> JSON path per line on stdout
  ui/                      widgets only
    file-view.ts           grid+list+state stack; typeahead; sorted insert; drop target
    floating-bar.ts        overlay status pill (typeahead indicator) — NautilusFloatingBar
    cells.ts               grid/column cell factories; thumbnails; per-cell drag source
    sidebar.ts             places view (over places-service)
    toolbar.ts             header: history / pathbar|location|search+filter / view menu
    pathbar.ts             breadcrumb buttons
    dialogs.ts             prompt / confirm / properties (+folder size) / about (Adw)
    context-menu.ts        buildContextMenu(): pure Gio.Menu model for the view
    shortcuts.ts           Adw.ShortcutsDialog (data-driven, mirrors shortcuts-dialog.blp)
    preferences.ts         Adw.PreferencesDialog over prefs (view/sort/hidden)
    batch-rename.ts        multi-select rename (find/replace | numbered) + live preview
    search-filter.ts       search popover (What/When) -> SearchFilter
    compress.ts            compress dialog (name + format)
    open-with.ts           app chooser over Gio.AppInfo.getRecommendedForType
    dnd.ts                 DragSource / DropTarget + system-clipboard content provider
    style.ts, style.css    app stylesheet (adapted from ../nautilus/src/resources/style.css)
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

## 5b. Fidelity pass (reference `../nautilus`)

Goal: match GNOME Files' behaviour/look as closely as possible, using the
checked-out nautilus source at `../nautilus` as the reference for UI + CSS.

- [x] **Breadth-first search.** Worker walks a FIFO queue (like
  `nautilus-search-engine-simple.c`: `g_queue_push_tail`/`pop_head`) instead of
  recursing depth-first, so matches nearest the search root surface first.
  `src/workers/search-worker.ts`.
- [x] **Typeahead indicator.** Bottom-right floating pill showing the current
  typeahead query, mirroring `NautilusFloatingBar` (`halign/valign: end`,
  `.floating-bar` CSS). New `src/ui/floating-bar.ts`; wired in `file-view.ts`.
- [x] **App stylesheet.** `src/ui/style.ts` loads `src/ui/style.css` (adapted
  from `../nautilus/src/resources/style.css`) at application priority.
- [x] **Grid/list cell padding.** `.nautilus-grid-view`/`.nautilus-list-view`
  on the scrollers, `.nautilus-view-cell` on cell boxes — CSS ported near-verbatim
  from nautilus (grid: 18px pad + 6px spacing + rounded 6px cells; list: 24px
  inset + 8px row spacing + rounded rows; neutral-grey selection; hidden-file
  dimming). `style.css` + `cells.ts` + `file-view.ts`.
- [x] **Keyboard shortcuts.** Full accel table in `main.ts` (matches nautilus:
  Ctrl+1/2 views, Ctrl+0 reset zoom, Alt+Home, Ctrl+Shift+I invert, Ctrl+Page
  Up/Down tabs, Ctrl+M link, Ctrl+Z/Y undo/redo, Ctrl+, prefs, Ctrl+? shortcuts).
  Shortcuts window (`win.shortcuts`) built data-driven from `src/ui/shortcuts.ts`
  via `Adw.ShortcutsDialog` (mirrors `shortcuts-dialog.blp`).
- [x] **Undo/redo.** Pure stack `src/services/undo-service.ts`; the window
  records inverse closures (rename↔rename, newFolder→trash, copy→trash,
  move→move-back, trash↔restore, link→trash). `copy`/`move` now return their
  destination GFiles; `file-operations.ts` gained `restoreFromTrash` (matches by
  `trash::orig-path`). Trash toast carries an “Undo” button. Verified: rename
  and trash→restore round-trip.
- [x] **Preferences dialog** (`win.preferences`, `src/ui/preferences.ts`) —
  `Adw.PreferencesDialog` editing view/sort/hidden, writing through the same
  paths as the header actions.

## 6. Next points (P2/P3)

### Done (this pass — each verified per §5)

1. [x] **Thumbnails** — `services/thumbnail-service.ts` (shared `thumbnails`):
   freedesktop cache lookup (md5(uri) in `~/.cache/thumbnails/{large,normal}`)
   then GdkPixbuf generation on a low-prio idle, cached by uri+mtime; `cells.ts`
   bind swaps the icon in (guarded against cell recycling). Verified on `~/img`.
2. [x] **Undo/redo** — see §5b.
3. [x] **System clipboard + DnD** — `ui/dnd.ts`: `fileClipboardProvider`
   (union of `x-special/gnome-copied-files` + `text/uri-list`) set on the widget
   clipboard on cut/copy; `_pasteFromSystem` reads uri-list when the in-app
   clipboard is empty; `makeDragSource` (per cell) drags a `GdkFileList` out;
   `makeDropTarget` (on the view) copies dropped files in. Clipboard formats
   verified; **drag/drop gestures not headlessly verifiable** (no compositor).
4. [x] **Archive extract/compress** — `services/archive-service.ts` shells to
   `unzip`/`tar`/`7z`/`unar` via `ProcessStream` (now supports `cwd`).
   Context-menu `Extract Here` / `Compress…` (`ui/compress.ts`). Roundtrip verified.
5. [x] **Rich search** — `ui/search-filter.ts` funnel popover (What=category,
   When=window) → `SearchFilter` applied in `search-service.ts` at resolve time
   (worker stays name-only + breadth-first). Category=folder verified.
6. [x] **Batch rename** — `ui/batch-rename.ts` (find/replace | numbered) with live
   preview; `win.rename` routes to it for multi-selection; undoable.
7. [x] **Preferences + Keyboard Shortcuts** — see §5b.
8. [~] **Properties** — folder content-size + item counts via async walk
   (`core/measure.ts`), updating live. `Open With…` chooser is a separate
   context-menu item (`ui/open-with.ts`). *Editable permissions still TODO.*
9. [x] **Trash UX** — `Adw.Banner` with Empty Trash when viewing `trash:///`;
   trash-specific context menu (`Restore From Trash` / `Delete Permanently`),
   `win.restore` via `trash::orig-path`. Verified.
10. [~] **Smaller items** — `Set as Wallpaper` (images), `Open in Terminal`
    (background), `Open in New Tab` (folders, Ctrl+Return), `Open With…` — all
    wired. *Column chooser / captions still TODO (see below).*

### Remaining

- **Column chooser / captions** — let the user choose which list columns show
  and grid caption lines. Needs dynamic `Gtk.ColumnViewColumn` visibility.
- **Editable permissions** in Properties (chmod via `info`/`F.setAttribute`).
- **Content (full-text) search** — worker only matches names.

---

## 7. Known limitations / rough edges

- **Clipboard**: cut/copy publish to the system clipboard (uri-list +
  gnome-copied-files) so paste works in other file managers; inbound paste from
  another app is best-effort (uri-list text). **DnD** drag/drop is implemented
  but was only construction-verified — gesture behaviour needs a real compositor.
- **Batch rename** applies renames directly; a target name colliding with another
  selected item's *old* name will error (no temp-name shuffling).
- **Rubber-band selection** uses GTK's built-in `enable-rubberband` (like
  nautilus). An item-press guard disables it during item drags so DnD still works
  (GTK issue 5670), re-enabling on release. Like DnD, the drag gesture itself
  isn't headlessly verifiable — the property/toggle are.
- **Thumbnails**: images only (no video/PDF generation); uses the shared
  freedesktop cache for other types when already present. Not persisted back.
- **`empty-trash`** also reachable from the Trash banner / context menu.
- XDG special dirs are hidden when they resolve to `$HOME` (this machine's config).
- Search matches **name only** (category/date filters apply on top).
- Large single-file copies + archive ops show a **pulsing** (indeterminate)
  progress bar, not a percentage.
- `tsc` isn't vendored — `npm install` before `npm run typecheck`. The app runs
  without it (types are stripped at load).

---

## 8. Commits so far

- `feat: nautilus clone …` — initial P0+P1 (was `.mjs`).
- `refactor: TypeScript rewrite with decoupled service architecture + recursive search`.
- `feat: typeahead (type-to-select) in the file view`.
