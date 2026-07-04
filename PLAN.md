# Mariner — plan

Mariner is a GNOME Files clone in **node-gtk + TypeScript** (GTK4 + libadwaita).
This is the single source of truth for picking the project up — read it before
changing code. User-facing docs live in `README.md`.

Status: nautilus parity reached, plus net-new features (dual pane, Quick Look,
command palette, ripgrep content search, disk-usage sunburst, batch rename,
in-place archive browsing, FileManager1 "Show in folder"). See §2.

---

## 1. Run & environment

```sh
pnpm install       # installs typescript + @types/node (node-gtk stays a local symlink)
pnpm start         # = node --import node-gtk/register src/main.ts
pnpm typecheck     # = tsc --noEmit  (needs pnpm install first)
```

- **TypeScript, no build step.** Node strips `.ts` types at load; imports use
  explicit `.ts` extensions. `tsconfig.json` enforces erasable-only syntax
  (`erasableSyntaxOnly`, `verbatimModuleSyntax`): no `enum`/`namespace`/parameter
  properties, and `import type` (or inline `import { type X }`) for type-only
  imports — else Node keeps the import and crashes on the missing runtime export.
- **Node 26** (system default). `node_modules/node-gtk` is a symlink to the
  local `~/worktrees/node-gtk-lazy` build (node-v147 ABI only — do **not**
  switch to Node 22, that build has no v127 binding). Upstream node-gtk 4.x
  does not run on Node 24+; the lazy branch is what makes 26 work.
- Requires **GTK ≥ 4.16** and **libadwaita ≥ 1.5** with their typelibs
  (`Gtk-4.0`, `Adw-1`); verified on GTK 4.22.4 / libadwaita 1.9.1.
- `src/gi.d.ts` declares `gi:` modules as `any` (no generated GI types).

---

## 2. Current state

Implemented and verified (headless GSK renders per §5 + service-level tests):

- **Browse** — async, incremental, cancellable listing; grid (`Gtk.GridView`) and
  list (`Gtk.ColumnView`) share one `MultiSelection`; folders-first sort; explicit
  loading / results / empty / error states (`Gtk.Stack` of `Adw.StatusPage`).
- **Navigate** — double-click/Enter opens (dir → navigate, file →
  `AppInfo.launchDefaultForUri`); breadcrumb pathbar; back/forward/up; per-tab
  history; location entry (Ctrl+L).
- **Tabs** — `Adw.TabView`, new/close/switch, per-tab history + search state.
- **Dual pane** (F3) — a tab hosts 1–2 `Pane`s in a `Gtk.Paned`; the focused pane
  (framed) drives the toolbar/actions; F6 / Alt+W switches; copy/move/drag across
  panes (Ctrl+Shift+C / Ctrl+Shift+X).
- **Sidebar** — Recent, Home, XDG dirs, Trash, bookmarks
  (`~/.config/gtk-3.0/bookmarks`; add/remove via action, context menu, palette —
  no reorder or custom labels yet), Computer, mounted volumes
  (`Gio.VolumeMonitor`).
- **Search** (Ctrl+F) — recursive, out-of-process (`workers/search-worker.ts`),
  breadth-first; streams matches over a GLib-serviced pipe, resolves metadata
  async. Results are **batched** (service coalesces 50 ms; view applies one
  splice) — a ~10k-match search stalls the main loop ≤ ~200 ms. A floating
  "Searching…" pill (spinner + Cancel, 200 ms grace) shows while streaming;
  Enter moves focus to the results. Funnel filter (category + date window); a
  **Contents** switch does full-text via `ripgrep`.
- **Typeahead** — plain typing fuzzy-ranks rows (fzy scorer with `ignoreTail`,
  so equally-good matches keep view/sort order) and selects the top match; a
  bottom-right floating pill shows the query; resets after ~1s.
- **Selection tools** — Select Items Matching (Ctrl+S, `*`/`?` glob, replaces
  the selection) and a nautilus-style selection summary in the floating pill
  ("12 items selected (348 MB)"; typeahead query wins while typing).
- **Operations** (async, time-sliced, progress + toasts) — new folder, rename,
  copy, cut/paste (move), trash, delete, empty trash, symlink, restore-from-trash;
  recursive with conflict resolution (Replace / Skip / Keep Both, apply-to-all;
  directory "Replace" is a real recursive **merge**) and a header **operations
  queue** (per-op progress + **pause/resume** + cancel; completed ops linger as
  ✓ until "Clear"). Real percentages for cross-fs file copies (chunked stream)
  and zip/7z/plain-tar extraction (entry count). **Undo/redo** (Ctrl+Z/Y) of
  all of it (merges excepted — see §6).
- **Trash extras** — a Trash-only "Original Location" column
  (`trash::orig-path`) and a "Restore to…" action (context menu + palette)
  that restores the selection into a picked folder via `Gtk.FileDialog`.
- **Quick Look** (Space) — floating preview paging the view's entries: images
  (`Gtk.Picture`), text/code (bounded async read → monospace), audio/video
  (`Gtk.Video`), else a metadata card.
- **Command palette** (Ctrl+P) — one ranked list of context actions + dual-pane
  copy/move + recently-visited folders (frecency); fuzzy scorer
  (`core/fuzzy-match.ts`); runs the existing `win.*` GActions.
- **Disk usage** (context → Analyze Disk Usage) — Baobab-style radial sunburst
  (`Gtk.DrawingArea` + cairo): hover highlights a wedge + lineage, click a folder
  wedge drills in.
- **Batch rename** — multi-select find/replace or numbered, live preview.
- **Archive** — Extract Here / Compress… (zip/tar.*/7z/rar via CLI tools);
  double-click **browses the archive in place** as a virtual folder via gvfs
  `archive://` (`core/archive-uri.ts` builds/decodes the doubly-escaped URI;
  DirectoryService mounts on demand on NOT_MOUNTED and retries once; Up from
  the archive root exits it; archive URIs stay out of recent-folders).
- **FileManager1** — implements `org.freedesktop.FileManager1` ("Show in
  folder" from browsers, `gio open`, download notifications). node-gtk can't
  host D-Bus objects (§4), so a small **gjs translator** (`data/filemanager1.js`)
  owns the bus name and forwards to `mariner --select` / `--properties`;
  `FileView.setPendingReveal` selects the URIs as the folder streams in.
  Becoming the default is opt-in via `mariner-set-default` (per-user service
  override + `inode/directory` MIME; see `docs/default-file-manager.md`).
- **Extras** — Open With…, Open in New Tab, Open in Terminal, Set as Wallpaper,
  Create Link. User-defined **custom actions** in the context menu live on the
  `feat/custom-user-actions` branch (documented in the README, not yet merged).
- **Thumbnails** — images, freedesktop cache + GdkPixbuf on idle.
- **Clipboard / DnD** — cut/copy publish to the system clipboard; drag files out,
  drop files in (see §6).
- **View prefs** — sort (name/size/type/modified, asc/desc), show hidden (Ctrl+H),
  zoom (Ctrl+± / Ctrl+0), list/grid (Ctrl+1/2); Preferences dialog;
  **customizable list columns** (Visible Columns chooser: size/type/modified/
  accessed/created/owner/group/permissions; Name always first).
- **Dialogs** — new folder, rename, batch rename, confirm-delete, properties
  (+ async folder size), compress, open-with, preferences, keyboard shortcuts,
  about.
- **Live refresh** via `Gio.FileMonitor` (debounced).
- **Interaction** — the view grabs focus on load/navigation (typeahead works
  without a click); scroll resets on navigation, kept on refresh; empty-space
  click clears the selection; window remembers its size. Accelerators in
  `accels.ts` drive both app-level accels and a window `Gtk.ShortcutController`.

---

## 3. Architecture

Decoupled layers: **services are GTK-free and event-based** (extend Node's
`EventEmitter`); **UI is widgets only**; **per-pane/tab controllers** wire them.

```
src/
  core/                  pure primitives — no UI, no service logic
    gio.ts               F proxy (GFile interface methods via prototype), ctors, ATTRS
    format.ts            displayName / formatSize|Type|Modified|Owner|Group|Permissions / locationName
    columns.ts           list-column registry (ColumnDef[]) + defaults + normalizeColumns
    comparator.ts        folders-first Comparator + binary-search sortedIndex
    navigation.ts        History (back/forward stacks)
    process-stream.ts    ProcessStream: line-streaming over Gio.Subprocess (opt. cwd)
    measure.ts           async recursive disk-usage walk (node fs) for Properties
    disk-usage.ts        scanTree(): nested size tree to a depth (sunburst)
    drives.ts            mounted-partition list from /proc/mounts + statfs (Computer)
    glob.ts              * / ? glob matcher for Select Items Matching (Ctrl+S)
    archive-uri.ts       build/decode gvfs archive:// root URIs (double escaping)
    fuzzy-match.ts       fzy subsequence scorer (vendored from ~/src/zym); ignoreTail
                         option drops the shorter-is-better tail penalty (typeahead)
    emitter.ts           re-exports Node EventEmitter
    types.ts             Entry, Place, Prefs, ViewConfig, SortKey, SearchFilter, CopyItem, Op*
  services/              one responsibility each; emit events; GTK-free
    directory-service.ts   load(dir): loading|items|ready|error|invalidated;
                           mounts archive:// locations on demand
    search-service.ts      search(dir,q,{filter}): name worker | ripgrep (filter.contents);
                           coalesces resolved matches into 50ms batches
    volume-monitor.ts      centralized Gio.VolumeMonitor access (first get() is sync)
    file-operations.ts     copy/move/delete/trash/rename/newFolder/link/restore/emptyTrash;
                           per-op id begin|progress|done|error; cancel(id)
    undo-service.ts        undo/redo stack of inverse closures
    thumbnail-service.ts   fd-cache lookup + GdkPixbuf generation (idle)
    archive-service.ts     extract/compress via CLI tools (ProcessStream)
    clipboard-service.ts   in-app copy/cut state (system clipboard: ui/dnd.ts)
    places-service.ts      getPlaces()/getBookmarks()/getDevices() -> Place[]
    window-state.ts        persist/restore window geometry (JSON under user config dir)
    recent-folders.ts      visited-folder store w/ frecency (JSON); feeds the palette
    view-prefs.ts          persist view mode + list columns (JSON under user config dir)
  workers/
    search-worker.ts       pure-node breadth-first walker -> JSON path per line on stdout
  ui/                    widgets only
    file-view.ts           grid+list+state stack; typeahead; Space→preview; focus-in;
                           drop; bulk splice insert; setPendingReveal (FileManager1)
    floating-bar.ts        overlay status pill: typeahead query, selection summary,
                           search spinner+Cancel (search > typeahead > selection)
    cells.ts               grid/column cell factories (metaColumn from ColumnDef); thumbnails; drag source
    column-chooser.ts      Visible Columns dialog (toggle/reorder)
    sidebar.ts             places view (over places-service)
    toolbar.ts             header: history / pathbar|location|search+filter / view menu
    pathbar.ts             breadcrumb buttons
    dialogs.ts             prompt / confirm / properties / about
    context-menu.ts        buildContextMenu(): pure Gio.Menu model
    command-palette.ts     Ctrl+P palette
    conflict-dialog.ts     partitionConflicts() + resolveConflicts()
    operations-queue.ts    header button + popover: per-op progress + cancel
    progress-ring.ts       circular progress paintable
    preview.ts             QuickLook window (preview-renderers.ts renders per type)
    sunburst.ts            SunburstView (DrawingArea + cairo); ui/disk-usage.ts hosts it
    computer.ts            Computer view (partitions + usage bars over core/drives.ts)
    shortcuts.ts           Adw.ShortcutsDialog (data-driven)
    preferences.ts         Adw.PreferencesDialog over prefs
    batch-rename.ts        multi-select rename + live preview
    search-filter.ts       search popover (What/When/Contents) -> SearchFilter
    compress.ts            compress dialog (name + format)
    open-with.ts           app chooser over Gio.AppInfo
    dnd.ts                 DragSource / DropTarget + system-clipboard provider
    style.ts, style.css    app stylesheet (adapted from nautilus)
  pane.ts                Pane: binds DirectoryService+SearchService <-> FileView (+history/search)
  tab.ts                 Tab: hosts 1–2 Panes; tracks active pane; delegates to it
  window.ts              AppWindow: shell assembly, GAction wiring, ops queue, conflicts
  accels.ts              ACCELS table + formatAccel/accelHint
  main.ts                Adw.Application, accelerators, GLib.MainLoop lifecycle;
                         CLI modes: --select / --properties (FileManager1 reveal)
bin/mariner              installed launcher, sh shim (exec node --import hooks + main.ts)
data/filemanager1.js     gjs D-Bus translator hosting org.freedesktop.FileManager1
```

### Data flow

- **Listing** — `Tab.navigate` → `DirectoryService.load` emits `loading` →
  `items` (batches) → `ready`. The pane maps each `GFileInfo` to `{info, file}`
  and calls `FileView.addEntries` (sorted insert). `invalidated` (FileMonitor) →
  reload unless a recursive search is showing.
- **Search** — `AppWindow._setSearch(true)` → `Pane.beginSearch`; typing →
  `SearchService.search` (worker or ripgrep); each result → `addEntries`;
  `end` → finish.
- **Operations** — window actions call `FileOperations`; events drive the ops
  queue + toasts; the FileMonitor refreshes afterward.

### Invariants

- **`Entry = {info: GFileInfo, file: GFile}`.** The GFile is also stashed as
  `info._file` so it survives a round-trip through `Gio.ListStore` (node-gtk keeps
  wrapper identity + JS props stable).
- **Sorting is done in JS** (binary-search insert / `Array.sort`), never
  `Gtk.CustomSorter` (its JS compare gets `undefined` args under node-gtk).
- **Cancellation** — services hold a `Gio.Cancellable` per op; a new `load`/
  `search` cancels the previous; async callbacks bail on `token.isCancelled()`.
- **Menu actions use action identity + JS state, never the signal's GVariant**
  (see §4). Sort is 4 mutually-exclusive boolean actions kept in sync with
  `prefs.sortKey`.
- `FileView` keeps the full unfiltered dataset in `this.all`, so toggling
  hidden/sort `rebuild()`s without re-listing.
- **Never insert per-item into the bound `Gio.ListStore` for large batches** —
  every `insert` fires an `items-changed` the selection model + both views
  process (~14 s for 20k rows). Merge into the sorted array and apply **one
  `splice(0, n, merged)`** (~640× faster); selection is re-applied by key.
- **Persisted as JSON under the user config dir**: window geometry
  (`window-state.ts`), recent folders (`recent-folders.ts`), and view mode + list
  columns (`view-prefs.ts`). The rest of `Prefs` — sort key/direction,
  show-hidden, zoom (`iconSize`) — is still in-memory / session-scoped.

---

## 4. node-gtk gotchas (most bugs came from these)

- **GFile / interface methods live on the interface prototype**, not the instance
  — always go through the `F` proxy (`F.getPath(file)`,
  `F.enumerateChildren(file, …)`); async finishers too
  (`F.enumerateChildrenFinish(file, res)`).
- **Under ESM `app.run()` returns immediately.** `main.ts` creates an explicit
  `GLib.MainLoop`, runs it in `activate`, and quits on `window-removed` when no
  windows remain — without it, GLib timeouts/async never fire. (`fs.watch` /
  libuv handles aren't serviced under the GLib loop either — use `Gio.FileMonitor`
  + `GLib.timeoutAdd`.)
- **Signal callbacks drop the emitter (first) arg.** `clicked` → 0 args;
  `change-state` → 1; gesture `pressed` → `(nPress, x, y)`; factory setup/bind →
  `(listItem)`; key `key-pressed` → `(keyval, keycode, state)`.
- **GVariants passed INTO a JS callback are corrupted** (NULL/garbage) — only read
  variants you created in JS; this is why menu actions use identity + JS state.
  `GVariant.getString()` returns `[str, len]`.
- **Async-ready callbacks get `(sourceObject, GAsyncResult, userData)`** — the
  result is `args[1]`.
- **`Gio.DataInputStream.readLineFinish` returns `[bytes, len]`**, bytes a plain
  `number[]` (decode with `Buffer.from`); **EOF is an empty array, not null**,
  so `readLine*` cannot distinguish a blank line from EOF — never emit blank
  protocol lines, or use `ProcessStream`'s blank-line-safe raw reader (read
  raw bytes, split on `\n`). `ProcessStream` finalizes on stdout+stderr EOF
  (`waitAsync` was unreliable).
- **`GLib.getMonotonicTime()` returns a BigInt** — `Number(...)` before math.
  Same for other guint64 getters: **`Gtk.Bitset.getSize()` /
  `SelectionModel.getSize()`** — `=== 0` never matches without `Number(...)`.
- **`Gtk.SelectionModel.setSelection` mis-marshals** — loop `selectItem`
  instead. **`Gtk.ListScrollFlags.SELECT` collapses a multi-selection** when
  scrolling — use `FOCUS`.
- **node-gtk cannot HOST a D-Bus object** — `registerObject` aborts,
  `registerObjectWithClosures` is absent, `addFilter` double-frees (its
  GClosure marshaller is signal-only). Host interfaces in a **gjs helper**
  (`data/filemanager1.js`); outbound/client-side D-Bus calls work fine.
- **GType**: no `.$gtype`; use `GObject.typeFromName('GFileInfo')` (or
  `instance.__gtype__`), e.g. for `Gio.ListStore.new(type)`. Build vfunc widgets
  by subclassing then `new` (registers the GType); prefer
  `Gtk.SignalListItemFactory` over `BuilderListItemFactory`.
- **`Adw.Breakpoint.addSetter`** needs a boxed `GObject.Value`, not a raw JS `true`.
- **`Adw.ActionRow` renders its subtitle as Pango markup** — escape any
  file-derived string (`&`, `<`, `>`) or the row renders blank (not
  node-gtk-specific, but it bit Properties).
- **`GtkListBox.setHeaderFunc/setHeader` mis-marshals** — draw sidebar group
  dividers as non-focusable separator rows instead.
- **Event phase** — the grid/column view claims Space/arrows at the target phase,
  so the typeahead/preview key controller runs in the **CAPTURE** phase to
  intercept first; keys it doesn't consume propagate on.
- **Each GtkWindow owns a GSK/Vulkan renderer** — build reusable windows (Quick
  Look, palette) **once** and hide/reuse them; recreating per open leaks GPU
  memory until the device OOMs.
- **cairo** works via `DrawingArea.setDrawFunc(cb)` (`cb(area, cr, w, h, data)`),
  but the **toy text API is dead** — use `PangoCairo` (`createLayout`/
  `showLayout`) for all text.
- camelCase everything (`getHomeDir`, `newForPath`); enums via the namespace
  (`Gtk.Orientation.VERTICAL`).

---

## 5. Verifying changes (headless Wayland box)

Compositor screenshots are blocked, so **render the window to a PNG via GSK** (no
compositor):

```js
import Gtk from 'gi:Gtk-4.0'; import Adw from 'gi:Adw-1'; import GLib from 'gi:GLib-2.0'
import { AppWindow } from '/abs/path/src/window.ts'
import { fileForPath } from '/abs/path/src/core/gio.ts'
const loop = GLib.MainLoop.new(null, false)
const app = new Adw.Application('com.test.x', 0)
app.on('activate', () => {
  const w = new AppWindow(app, fileForPath('/home/you'))
  GLib.timeoutAdd(0, 1400, () => {              // let it lay out
    const win = w.window, width = win.getWidth(), height = win.getHeight()
    const pt = Gtk.WidgetPaintable.new(win), s = Gtk.Snapshot.new()
    pt.snapshot(s, width, height)
    const node = s.toNode()                     // null on an un-drawn frame → queueDraw + retry
    if (node) win.getRenderer().renderTexture(node, null).saveToPng('/tmp/out.png')
    loop.quit(); return false
  })
  loop.run()
})
app.run()
```

Run with `node --import node-gtk/register /tmp/harness.mjs` **from the repo dir**
(so `node-gtk/register` resolves). Filter noise:
`2>&1 | grep -vE "Vulkan|Gdk-WARNING"`. A `.mjs` harness may import the app's
`.ts` modules directly; drive behaviour via controller methods
(`w.activeTab.navigate(...)`, `w._setSearch(true)`). Services test headless
against `/tmp` dirs. A `DrawingArea` window can snapshot to a *null* node for a
few frames — wait for the work to finish, then take one delayed snapshot rather
than spinning a `return true` retry timer. (~8 harmless `G_IS_OBJECT` render-time
criticals per GSK snapshot are expected — present on HEAD too.)

---

## 6. Known limitations

- **Clipboard / DnD** — cut/copy publish uri-list + gnome-copied-files so paste
  works across file managers; inbound paste is best-effort. Drag/drop is
  implemented but only construction-verified (needs a real compositor).
  Rubber-band uses GTK's `enable-rubberband`, disabled during item drags so DnD
  works (GTK#5670).
- **Conflict resolution** — "Replace" of a directory is a real recursive merge
  (labelled "Merge"): destination-only files are preserved, and colliding leaf
  files prompt per-file (Replace/Skip/Keep Both, honouring "apply to all").
  Move-merges rmdir the emptied source shells; merges skip undo (overwritten
  originals can't be restored) with a toast. System-clipboard paste stays
  auto-rename.
- **Thumbnails** — images only (no video/PDF generation); other types use the
  freedesktop cache when already present. Not persisted back.
- **Preview** — text/image/av + metadata fallback; no PDF/markdown rendering
  (markdown treated as text); text is a bounded 512 KB read.
- **Ops queue** is concurrent with per-op cancel + pause/resume (file jobs drop
  their idle source; archive ops SIGSTOP/SIGCONT the child). A completed op fills
  its bar, flashes the header button, and lingers as a ✓ until dismissed via
  "Clear" (cancelled ops vanish immediately).
- **Disk-usage sunburst** shows 5 rings from the current root (deeper contents
  still count toward sizes); local paths only; redraws on each incremental scan.
- **Search** matches name only (category/date/contents filters apply on top).
- **Archive browsing** is read-only (gvfs `archive://` backend) and needs
  `gvfsd-archive`; editing inside an archive means Extract → edit → Compress.
- **FileManager1** needs `gjs` at runtime for the translator service; Mariner
  never becomes the default silently — only via `mariner-set-default`.
- **Command palette** jumps only to recently-visited folders (no arbitrary-path
  completion or file search); recent folders persist in `recent-folders.json`,
  never pruned below 200.
- **Bookmarks** support add/remove but not reorder or custom labels;
  permissions/owner/group columns and the Properties permissions row are
  read-only (no chmod); no network/remote locations; no starred files. XDG
  special dirs are hidden when they resolve to `$HOME`. (See README "Not yet
  supported".)
- Large **cross-filesystem** single-file copies stream in chunks and show a real
  byte percentage (same-fs copies keep native `g_file_copy` for reflink/metadata,
  so they're near-instant); zip/7z/plain-tar extraction shows a real entry-count
  percentage. Compressed-tar/rar extraction and all compression still **pulse**
  (a cheap total isn't available).
- `tsc` isn't vendored — `pnpm install` before `pnpm typecheck`; the app runs
  without it.

---

## 7. Ideas / not yet built

Parity with nautilus is reached; these are net-new draws, none implemented:

- **Git-aware view** — status badges + branch in the pathbar + `.gitignore`
  dimming, via a `services/git-service.ts` (`git status --porcelain=v2 -z` cached
  per repo, invalidated by the FileMonitor) + a `cells.ts` badge.
- **Tags / colored labels** — cross-folder organization via xattrs
  (`user.xdg.tags`) or a sidecar store; feeds tag-based smart searches.
- **Saved searches / smart folders** — a persisted `SearchFilter` (already
  serializable) shown in the sidebar and re-run live.
- **Grid captions** — caption lines under grid icons (the grid analogue of the
  column chooser); the `core/columns.ts` formatters are ready to reuse.
- **Editable permissions** in Properties (chmod via `F.setAttribute`).
- **Miller columns** — a third column-browser view mode with strong keyboard nav.
- **Duplicate finder** — hash-based, surfaced as a smart view.
- **Persist remaining view prefs** — sort key/direction, show-hidden, and zoom
  reset each launch (only view mode + columns persist); extend `view-prefs.ts`,
  optionally keyed per-folder for nautilus-style per-directory view memory.
- **Bookmark reorder / custom labels**, **network/remote locations** (GVfs
  SFTP/SMB), **starred files** — see README "Not yet supported".
- **Diff / compare** two selected files (leans on dual pane; shells out).
- **PDF / markdown rendering** in Quick Look (markdown is treated as text today).

Planned refactor (deferred until in-flight feature branches land, to avoid
multi-way rebases): split the ~1000-line `window.ts` god object into
palette-items + a file-ops controller.
