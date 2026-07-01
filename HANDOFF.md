# Mariner — handoff

Mariner — a GNOME Files clone in **node-gtk + TypeScript**, GTK4 + libadwaita.
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
  zoom (Ctrl+±), list/grid (Ctrl+1/2, reset Ctrl+0); **Preferences dialog**;
  **customizable list-view columns** — a "Visible Columns" chooser (view menu)
  toggles/reorders which columns show (Size, Type, Modified, Accessed, Created,
  Owner, Group, Permissions; Name is always first). See §6d.
- **Dialogs**: new folder, rename, batch rename, confirm-delete, properties
  (+ async folder size), compress, open-with, preferences, keyboard shortcuts,
  about.
- **Live refresh** via `Gio.FileMonitor` (debounced).
- **Dual pane** (F3): a tab hosts 1–2 `Pane`s (extracted browsing controller) in a
  `Gtk.Paned`; the active pane (focus-follows, framed) drives the toolbar/actions;
  F6 switches panes; copy/move/drag between them. See §6c.
- **Space-to-preview / Quick Look** (Space): a floating preview window paging the
  view's entries (arrows), rendering images (`Gtk.Picture`), text/code (async
  bounded read → monospace), audio/video (`Gtk.Video`), else a metadata card.
- **Content search** (search funnel → "Contents" switch): full-text via `ripgrep`,
  reusing the streamed path→info resolve pipeline; name search stays the worker.
- **Conflict resolution + operations queue**: paste/drop preflight top-level name
  collisions → Replace / Skip / Keep Both (+ apply-to-all); a header operations
  button lists each running op with per-op progress + cancel (replaces the single
  bottom bar; archive ops flow through it too).
- **Disk-usage rings chart** (context menu → Analyze Disk Usage): a Baobab-style
  radial sunburst (`Gtk.DrawingArea` + cairo) of a folder's size tree — centre
  disc = the folder, each ring out one level, wedges sized by share, coloured with
  Baobab's own palette; hover highlights a wedge + its lineage and shows a
  name/size tooltip, big wedges are labelled, click a folder wedge drills in.
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
    format.ts              displayName / formatSize|Type|Modified|Accessed|Created|Owner|Group|Permissions / locationName
    columns.ts             list-view column registry (ColumnDef[]) + defaults + normalizeColumns — pure
    comparator.ts          folders-first Comparator + binary-search sortedIndex
    navigation.ts          History (back/forward stacks) — pure
    process-stream.ts      ProcessStream: line-streaming over Gio.Subprocess (opt. cwd)
    measure.ts             async recursive disk-usage walk (node fs) for Properties
    disk-usage.ts          scanTree(): nested size tree to a depth (rings chart), pure
    emitter.ts             re-exports Node EventEmitter (loop-safe, pure JS)
    types.ts               Entry, Place, Prefs, ViewConfig, SortKey, SearchFilter, CopyItem, Op*
  services/                one responsibility each; emit events; GTK-free
    directory-service.ts   load(dir): 'loading'|'items'|'ready'|'error'|'invalidated'
    search-service.ts      search(dir,q,{filter}): name worker | ripgrep (filter.contents)
    file-operations.ts     copy/move(Items)/delete/trash/rename/newFolder/link/restore/emptyTrash
                           long ops carry an id: 'begin'|'progress'|'done'|'error'; cancel(id)
    undo-service.ts        pure undo/redo stack of inverse closures; 'changed'
    thumbnail-service.ts   shared: fd-cache lookup + GdkPixbuf generation (idle); exports `thumbnails`
    archive-service.ts     extract/compress via CLI tools (ProcessStream); 'begin'|'done'|'error'
    clipboard-service.ts   in-app copy/cut state; 'changed' (system clipboard: ui/dnd.ts)
    places-service.ts      getPlaces()/getBookmarks()/getDevices() -> Place[]
    window-state.ts        persist/restore window geometry (JSON under user config dir)
  workers/
    search-worker.ts       pure-node BREADTH-FIRST walker -> JSON path per line on stdout
  ui/                      widgets only
    file-view.ts           grid+list+state stack; typeahead; Space→preview; focus-in; drop
    floating-bar.ts        overlay status pill (typeahead indicator) — NautilusFloatingBar
    cells.ts               grid/column cell factories (metaColumn from a ColumnDef); thumbnails; per-cell drag source
    column-chooser.ts      "Visible Columns" dialog (toggle/reorder list columns) over prefs.columns
    sidebar.ts             places view (over places-service)
    toolbar.ts             header: history / pathbar|location|search+filter / view menu
    pathbar.ts             breadcrumb buttons
    dialogs.ts             prompt / confirm / properties (+folder size) / about (Adw)
    context-menu.ts        buildContextMenu(): pure Gio.Menu model for the view
    conflict-dialog.ts     partitionConflicts() + resolveConflicts() (Replace/Skip/Keep Both)
    operations-queue.ts    header button + popover: per-op progress + cancel (fileOps/archive)
    progress-ring.ts       ProgressRing: circular progress paintable (nautilus-style)
    preview.ts             QuickLook: floating preview window, pages the view's entries
    preview-renderers.ts   renderPreview(info,file): image/text/av/metadata widgets
    sunburst.ts            SunburstView: Baobab-style radial rings chart (DrawingArea+cairo)
    disk-usage.ts          diskUsageDialog(): rings window, live scan, drill-down/back
    shortcuts.ts           Adw.ShortcutsDialog (data-driven, mirrors shortcuts-dialog.blp)
    preferences.ts         Adw.PreferencesDialog over prefs (view/sort/hidden)
    batch-rename.ts        multi-select rename (find/replace | numbered) + live preview
    search-filter.ts       search popover (What/When/Contents) -> SearchFilter
    compress.ts            compress dialog (name + format)
    open-with.ts           app chooser over Gio.AppInfo.getRecommendedForType
    dnd.ts                 DragSource / DropTarget + system-clipboard content provider
    style.ts, style.css    app stylesheet (adapted from ../nautilus/src/resources/style.css)
  pane.ts                  Pane: binds DirectoryService+SearchService <-> FileView (+history/search)
  tab.ts                   Tab: hosts 1–2 Panes (dual-pane) + active-pane; delegates to it
  window.ts                AppWindow: shell assembly, GAction wiring, ops queue, conflicts
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
- [x] **Grid/list cell padding.** `.mariner-grid-view`/`.mariner-list-view`
  on the scrollers, `.mariner-view-cell` on cell boxes — CSS ported near-verbatim
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
- [x] **Path bar (location bar)** — `src/ui/pathbar.ts` rewritten as a faithful
  port of `nautilus-pathbar.c`: a `.linked.mariner-pathbar` box wrapping a
  horizontal `Gtk.ScrolledWindow` (EXTERNAL/NEVER, natural-width, auto-scrolls to
  reveal the current folder, vertical wheel → horizontal scroll) of crumb
  buttons, plus a trailing `view-more` menu button. Special roots (filesystem =
  OS name via `g_get_os_info`, Home, Trash, Recent, Starred, Network, mounts)
  render as icon + bold label; normal folders as a dim `/` separator + bold
  label; ancestors are dim-labelled, the current dir gets `.current-dir` and
  opens the location entry (`win.location`) on click. Middle-click → new tab,
  Ctrl+click → new window, right-click → `pathbar.*` context menu (Open in New
  Window/Tab, Properties). Middle-ellipsize (7-char floor, 28 for current). CSS
  ported to `src/ui/style.css` (`.mariner-pathbar`, `.mariner-path-button`,
  `.current-dir`, scroll-edge undershoot fades). Header layout (`toolbar.ts`):
  the path/search stack is the hexpanding title widget and fills the full width.
  AdwHeaderBar reserves symmetric space around the title equal to the wider side,
  so the start/end are balanced to avoid gaps: start = back/forward history +
  search toggle; end = view controls (next to the window buttons). No "Up" or
  "New Folder" buttons; the crumb context menu still exposes New Folder via
  `win.new-folder`.
- [x] **Sidebar (places)** — `src/ui/sidebar.ts` rewritten to match
  `nautilus-sidebar.c` / `nautilus-sidebar-row.blp`: a single
  `.navigation-sidebar` `Gtk.ListBox` (single-selection, activate-on-single-
  click), rows built like the blp (start `Image` `margin-end: 8`, a
  middle-ellipsized hexpanding `Label` `margin-end: 2`, and a `media-eject-
  symbolic` button on removable devices that can eject/unmount). The Places /
  Bookmarks / Devices groups are split by **separators, not text headers**
  (nautilus draws these from `list_box_header_func`); we insert them as
  non-selectable/-activatable/-focusable separator rows (`.sidebar-separator-row`,
  keyboard-skipped) because node-gtk mis-marshals `GtkListBox.setHeaderFunc/
  setHeader`. CSS for the divider + eject button in `src/ui/style.css`.
  Note: this window emits ~8 harmless `G_IS_OBJECT` node-gtk render-time
  criticals per GSK snapshot regardless of the sidebar (present on HEAD too).

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
    wired. *Column chooser done (§6d); grid captions still TODO.*

### Remaining

- **Grid captions** — extra caption lines under grid-view icons (size/type/…),
  the grid-view counterpart of the list column chooser. The column registry
  (`core/columns.ts`) already provides labelled formatters to reuse.
- **Editable permissions** in Properties (chmod via `info`/`F.setAttribute`).
  Note: the Permissions *column* is read-only display only.
- ~~Column chooser~~ — **done** (list view; see §6d).
- ~~Content (full-text) search~~ — **done** (ripgrep; see §6c).

---

## 6b. Differentiator features (proposed — draw users over)

Parity with nautilus is essentially reached. These are *net-new* features
targeting the things nautilus users complain nautilus refuses to add. Ordered by
expected draw; each notes how it fits the existing architecture. None are
implemented yet.

### Headline three (highest draw)

1. **Dual-pane / split view** — two file views side-by-side, copy/move/drag
   between them, Tab to switch the focused pane. The single most-requested
   nautilus feature (rejected upstream for a decade); the reason people run
   Krusader/Dolphin/Total Commander. **Fit:** a `Tab` already binds one
   `DirectoryService`+`SearchService` to one `FileView`; a split is two of those
   in an `Adw` paned layout plus a shared "active pane" concept so the toolbar /
   GActions target the focused side. *High effort, highest draw.*
2. **Space-to-preview (Quick Look)** — Space on a selection opens a fast preview
   overlay (images, syntax-highlighted text/code, rendered markdown, PDF,
   audio/video), arrow keys move through the selection. macOS Finder's best
   feature; nautilus's `sushi` equivalent is weak/often absent. **Fit:** an
   overlay widget (reuse the `floating-bar.ts` overlay pattern) + a per-type
   renderer registry; the thumbnail cache already exists for images.
   *Medium effort, very high draw.*
3. **Git-aware file view** — status badges on files/folders
   (modified/untracked/staged), current branch in the pathbar, `.gitignore`
   dimming. Converts developers on its own. **Fit:** a new
   `services/git-service.ts` (shell `git status --porcelain=v2 -z` per repo,
   cache by dir, invalidate via the existing `FileMonitor`) + a badge in
   `cells.ts`.

### Strong second tier

- **Command palette (Ctrl+P / Ctrl+Shift+P)** — fuzzy-jump to any folder and run
  any action from the keyboard ("VS Code for files"). **Fit:** a searchable
  popover over recent/bookmarked paths + the existing GActions; typeahead
  matching logic already exists.
- **Content (full-text) search** — wire `ripgrep` into the existing
  out-of-process worker model (`workers/search-worker.ts` already streams
  results), with match previews. Also listed under §6 Remaining.
- **Tags / colored labels** — cross-folder organization (Finder-style), stored
  as xattrs (`user.xdg.tags`) or a sidecar SQLite; feeds tag-based smart
  searches.
- **Saved searches / smart folders** — a persisted query (name + `SearchFilter`
  + tags) shown in the sidebar and re-run live. `SearchFilter` is already
  serializable.

### Nice differentiators (lower effort)

- **Disk-usage treemap** — a treemap/sunburst view mode built on the existing
  async recursive `core/measure.ts` walk (absorbs a Baobab/WinDirStat-style app).
- **Miller columns** — a third view mode (macOS column browser / ranger-style)
  with strong keyboard navigation; nautilus lacks it.
- **Better conflict resolution + operations queue** — a per-file collision
  dialog (replace / keep-both / skip, apply-to-all) and a pause/resume/cancel
  operations queue, replacing the single pulsing progress bar.
- **Custom actions / scripting menu** — user-defined context-menu commands with
  token substitution (`%f`, `%u`, selection). Cheap extensibility hook.
- **Duplicate finder** — hash-based, surfaced as a smart view.

**Bet:** split view + git awareness + space-to-preview is a combination no
mainstream Linux file manager ships together. Fastest path to a visible "whoa":
space-to-preview or git badges.

---

## 6c. Differentiator build (LANDED — verified per §5)

Five of §6b shipped: dual pane, space-to-preview, ripgrep content search, disk
treemap, conflict resolution + ops queue. Priority was **clean long-term
architecture, decoupled modules, small files.** All typecheck (`npm run
typecheck`) and were verified headlessly (GSK PNG renders + service-level tests
against `/tmp`): dual-pane split/switch/unsplit; Quick Look image+text paging;
ripgrep content-vs-name matching; copyItems replace/keep-both/recursive/cancel +
conflict dialog + ops-queue rows; treemap recursive sizing + squarified render.
Verification harnesses were throwaway `/tmp/h-*.mjs` (per §5).

### Environment de-risking (probed up front)

- **cairo works** under node-gtk: `Gtk.DrawingArea.setDrawFunc(cb)` calls
  `cb(area, cr, width, height, userData)` (argc 5); cairo path/fill ops work.
- **cairo toy text API is dead** (`selectFontFace`/`showText`/`textExtents` →
  blank, zero extents). **Use `PangoCairo`** for text: `createLayout(cr)` +
  `layout.setText(s, -1)` + `setFontDescription(Pango.FontDescription.fromString(...))`
  + `PangoCairo.showLayout(cr, layout)` — verified, `getPixelSize()` correct.
- **ripgrep** `rg` 15.1.0 present at `/usr/bin/rg`.

### Architecture decisions

- **Dual pane — `Pane` extracted from `Tab`.** New `src/pane.ts` owns what `Tab`
  used to: `FileView` + `DirectoryService` + `SearchService` + `History` +
  location + search state + all the `view.on*` wiring. `src/tab.ts` becomes a
  thin container: 1–2 `Pane`s hosted in a `Gtk.Paned` inside an `Adw.Bin`
  (`this.container`, which is the `Adw.TabPage` child — the page child can't be
  swapped, so we re-child inside the Bin), tracks `activePane`, and **delegates**
  `view`/`location`/nav/search/`applyPrefs` getters to it so `window.ts` keeps
  calling `this.activeTab.*` almost unchanged. A pane becomes active on
  focus/click/context-menu; `win.toggle-split`/`win.swap-panes` actions added.
  Pane callbacks (activate/context/drop/preview) activate the pane, then call the
  existing `win.*(tab, …)` methods.
- **Space-to-preview.** `FileView` gains an `onPreview` callback fired on Space
  when the typeahead buffer is empty (replacing the old "leading space no-op").
  **Gotcha:** the grid/column view claims Space for selection-toggle at the
  target phase, so the typeahead `EventControllerKey` must run in the **CAPTURE**
  phase (`setPropagationPhase(CAPTURE)`) to see Space first — otherwise Space just
  deselects. Keys it doesn't consume (arrows/Enter/Ctrl-chords) return unhandled
  and propagate to the view as before.
  `src/ui/preview.ts` = a reusable `QuickLook` (one per window, lazy) hosting a
  content area + prev/next/close; `src/ui/preview-renderers.ts` = pure
  `renderPreview(info, file)` per content-type (image→`Gtk.Picture`,
  text/code→async node-read into monospace `TextView` capped at 512 KB,
  audio/video→`Gtk.Video`, else metadata card). Navigates within the entries the
  view is showing. **Gotcha:** the preview window is built **once and reused**
  (hidden on close, not destroyed) — each GtkWindow owns a GSK/Vulkan renderer,
  so recreating it per open leaks GPU memory until the device OOMs
  (`vkAllocateMemory … VK_ERROR_OUT_OF_DEVICE_MEMORY`). On close the preview
  widget is dropped and any `Gtk.Video` media stream stopped, to release its
  texture/GStreamer pipeline. Verified over 150 open/close/page cycles.
- **Ripgrep content search.** `SearchFilter` gains `contents: boolean`.
  `search-filter.ts` popover gets a "File contents" switch. `search-service.ts`:
  when `contents && query`, spawn `rg --files-with-matches --fixed-strings
  --ignore-case [--hidden] --no-ignore -- <q> <dir>` via `ProcessStream` (content
  mode emits **raw path lines**, name mode stays **JSON** from the worker — the
  service tracks which and parses accordingly); reuse the async path→`GFileInfo`
  resolve + the category/date `matchesFilter`. Missing `rg` →
  `GLib.findProgramInPath` guard → friendly error state.
- **Conflict resolution + ops queue.** `file-operations.ts` `Job` gains an `id`
  (all events carry it) + `cancel(id)`; new `copyItems/moveItems(CopyItem[])`
  where `CopyItem = {src, dest, replace?}` (replace = delete-existing-then-write,
  so nested copies never re-conflict), returning produced dests; `copy/move`
  become thin auto-rename wrappers (kept for redo / system-paste). `_paste` /
  `onDropFiles` become **async**: preflight **top-level** collisions,
  `src/ui/conflict-dialog.ts` (Replace / Skip / Keep Both + apply-to-all) →
  build plan → run → record undo from the returned dests. New
  `src/ui/operations-queue.ts` = a header `MenuButton` (hidden when idle) whose
  popover lists each active op with a per-op progress bar + cancel ✕, fed by
  `fileOps` + `archive` events; **replaces** the single bottom progress revealer.
- **Disk-usage rings chart** (Baobab-style; replaced an earlier squarified
  treemap on request). `src/core/disk-usage.ts` = `scanTree(dir, maxDepth,
  onProgress, isCancelled)` → a nested `UsageNode` tree (children recorded to
  `maxDepth`, `bytes` always the full recursive subtree), reported incrementally,
  cancellable (pure node fs). `src/ui/sunburst.ts` = `SunburstView`
  (`Gtk.DrawingArea` + cairo): centre disc = the scanned folder; each ring out is
  one tree level; every node a wedge whose sweep = its share of its parent.
  **Colours match Baobab exactly** (`wedgeColour`, ported from
  `baobab-chart.vala get_item_color`): the 6-colour GNOME palette
  (`#e01b24 #ff7800 #f6d32d #33d17a #3584e4 #9141ac`) interpolated by the wedge's
  angular start (`rel` 0..100, spread over thirds — so the ring runs red→orange→
  yellow→green), darkened by depth (`intensity = 1 − (depth−1)·0.3/RINGS`); the
  hovered wedge + its lineage to centre are normalised to full brightness. Hover
  also raises a **name/size/% tooltip** (`has-tooltip` + `query-tooltip`, Pango
  markup). Names are drawn tangentially (rotated to the ring, flipped upright) via
  PangoCairo, but only on wedges the full name fits — so only the big ones get
  labelled, like Baobab; polar hit-test (radius→ring, angle→wedge); click a folder
  wedge → drill. `src/ui/disk-usage.ts` hosts it in an `Adw` window (title/total
  header, spinner, Back + hover status). Opened via `win.disk-usage` from the
  folder + background context menus. `RINGS = 5` (= Baobab `MAX_DEPTH`).

### Scoping / decisions (v1) + follow-ups

- **Conflict resolution** handles **top-level** collisions only (the
  pasted/dropped items vs the destination); deep directory-merge conflicts are
  not surfaced — "Replace" of a directory is a true replace (delete-then-copy),
  not a merge. System-clipboard paste (`_pasteFromSystem`) stays auto-rename (the
  async clipboard read isn't routed through the dialog).
- **Disk-usage rings chart** shows `RINGS = 5` levels from the current root
  (scan depth 5; deeper contents still count toward wedge sizes), click-to-drill
  + Back. Local paths only (node fs). Wedges below `MIN_SWEEP` are skipped (their
  angle is preserved as a gap). Redraws on every incremental scan report (fine
  for typical trees; throttle if a huge dir stutters). Per-wedge names are drawn
  with PangoCairo (cairo toy-text is dead) only when the whole name fits the
  wedge; hover also shows name/size/% in the status bar.
- **Preview** renders text/image/av + a metadata fallback; **no** PDF/markdown
  rendering yet (PDF needs Poppler; markdown treated as text). Text is a bounded
  512 KB read.
- **Ops queue** is concurrent (cancel only, no pause/resume), matching the
  existing time-sliced Job model. cairo toy-text is dead → labels use PangoCairo.
- **Dual pane** focus-follows-mouse-less: a pane becomes active on focus-in /
  click / context-menu. Splitting moves focus to the new (right) pane because its
  initial navigation grabs focus — acceptable; F6 returns. Only explicit
  navigation grabs focus, so a background FileMonitor refresh won't steal it.
- **GSK render gotcha:** a `DrawingArea` window can snapshot to a *null* node for
  a few frames; don't spin a `return true` retry timer (keeps the frame dirty) —
  wait for the work to finish, then take one delayed snapshot (see the treemap
  harness).

---

## 6d. Customizable list columns (LANDED — verified per §5)

Lets the user choose which columns the list view shows and in what order,
mirroring GNOME Files' **Visible Columns** dialog (`nautilus-column-chooser.c`).

### Architecture

- **`core/columns.ts` — the column registry (pure, GTK-free).** A `ColumnDef`
  is `{ id, label, format(info)→string, rightAlign? }`; `COLUMN_DEFS` lists the
  optional meta columns in GNOME-Files order (size, type, modified, accessed,
  created, owner, group, permissions). The **Name** column is *not* here — it's
  always first and carries the icon/thumbnail (see `cells.ts nameColumn`).
  `defaultColumnConfig()` returns the default `ColumnConfig[]` (size/type/modified
  visible); `normalizeColumns()` reconciles a stored/edited config against the
  registry (keeps known ids in order, backfills missing as hidden, drops unknown)
  so a config stays valid across releases.
- **`ColumnConfig = { id, visible }` (in `core/types.ts`), ordered.** Added to
  `Prefs.columns`. Order is significant and drives both the ColumnView and the
  chooser. Like the rest of `prefs`, it's **in-memory / session-scoped** (nothing
  in this app persists prefs yet); `normalizeColumns` is ready if persistence is
  added later.
- **`format.ts` gained pure formatters** — `formatAccessed`/`formatCreated`
  (shared `formatDateTime` helper), `formatOwner`/`formatGroup`
  (`owner::user`/`owner::group`), `formatPermissions` (`unix::mode` → 10-char
  `ls -l` string, e.g. `drwxr-xr-x`). `gio.ts ATTRS` gained `time::access`,
  `time::created`, `owner::user`, `owner::group`, `unix::mode`.
- **`cells.ts metaColumn(def)`** builds a column straight from a `ColumnDef`
  (was a hardcoded `[title, fmt, right]` tuple + a static `COLUMNS` array, both
  removed). **`FileView.setColumns(configs)`** rebuilds the meta columns after
  the fixed Name column: it removes its tracked `_metaCols`, appends the visible
  ones in order, and **short-circuits on an unchanged visible-id signature** so
  it's cheap to call on every pref sync. Wired through `Pane.applyColumns()` +
  `Pane.syncView()` (so an unfocused tab catches up on its next navigation) and
  `Tab.applyColumns()` (fan-out to both panes).
- **`ui/column-chooser.ts` — the dialog.** `columnChooserDialog(parent, configs,
  onChange)` = an `Adw.Dialog` ("Visible Columns") hosting a boxed-list: a fixed
  **Name** `Adw.ActionRow` first, then an `Adw.SwitchRow` per column (switch =
  visibility) with **Move Up / Move Down** buttons. Changes apply **live** via
  `onChange` (like nautilus's `changed` signal) — no OK/Cancel — and a **Reset**
  header button restores defaults. `win.choose-columns` (view-menu "Visible
  Columns…") opens it, switching to the list view first so edits are visible.
- **Reordering uses explicit up/down buttons, not drag-and-drop.** Nautilus does
  both; we skip DnD because it's neither headlessly verifiable nor reliable under
  node-gtk (per §7), and menu/button reordering is a complete, keyboard-friendly
  UX. Toggling a switch doesn't rebuild the row list (keeps the switch); a move
  does.

### Scoping / decisions (v1)

- **Global columns**, not per-folder. Nautilus supports per-file column metadata
  (the chooser's "Only apply to current folder" banner); mariner has no per-file
  metadata store, so the chooser edits the single global `prefs.columns`. The
  banner/switch were intentionally omitted.
- **Permissions/Owner/Group columns are read-only display.** Editable perms stay
  a Properties TODO (§6 Remaining).
- **Grid captions** (the grid-view analogue) are not done; the registry's
  labelled formatters are ready to reuse for them.

### Verified (per §5)

`/tmp/h-columns.mjs` (18 assertions, all pass): default/normalize config helpers;
`formatPermissions`/`Owner`/`Group`/dates/size against a real file + a dir;
`FileView.setColumns` initial/custom-reorder/no-op/all-hidden. GSK PNG renders:
the list view with a custom `Name|Permissions|Owner|Modified` set (perms shown as
`-rw-r--r--`, owner `romgrk`, dates), and the chooser dialog itself.

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
