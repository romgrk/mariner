# nautilus-clone

A [GNOME Files](https://gitlab.gnome.org/GNOME/nautilus) (nautilus) clone built
with [node-gtk](https://github.com/romgrk/node-gtk) in **TypeScript**, GTK4 +
libadwaita. It drives the same Adw/Gtk widgets nautilus does, so the UI matches
closely.

## Run

```sh
npm install      # links node-gtk; installs typescript + @types/node for checking
npm start        # node --import node-gtk/register src/main.ts
npm run typecheck
```

TypeScript runs with **no build step** via Node's native type stripping (Node ≥
22.6 strips `.ts` by default). Requires GTK ≥ 4.16, libadwaita ≥ 1.5, and their
typelibs (`Gtk-4.0`, `Adw-1`).

## Architecture

Decoupled layers; the service layer is GTK-free and event-based, the UI layer
renders, and per-tab controllers wire them together.

```
src/
  core/        pure/runtime primitives (no UI logic)
    gio.ts            GFile proxy, constructors, attribute set
    format.ts         display name / size / type / date helpers
    comparator.ts     folders-first sort + binary-search insert
    navigation.ts     back/forward history (pure)
    process-stream.ts line-streaming over Gio.Subprocess (GLib-native async)
    emitter.ts        EventEmitter base
    types.ts          shared domain types (Entry, Place, Prefs, …)
  services/    GTK-free, emit events; one responsibility each
    directory-service.ts  async incremental enumeration + FileMonitor
    search-service.ts     spawns the worker, streams + resolves results
    file-operations.ts    time-sliced copy/move/delete/… with progress
    clipboard-service.ts  copy/cut state
    places-service.ts     sidebar places / bookmarks / volumes
  workers/
    search-worker.ts  pure-node recursive walker → NDJSON on stdout
  ui/          widgets only
    file-view.ts  grid + list + state stack (loading/empty/error/results)
    cells.ts · sidebar.ts · toolbar.ts · pathbar.ts · dialogs.ts
  tab.ts       per-tab controller (binds services ↔ view, owns nav + search)
  window.ts    shell assembly, actions, file-op progress UI
  main.ts      Adw.Application, accelerators, lifecycle
```

**Recursive search** is the reference flow for the async standard: it runs in a
**separate process** (`search-worker.ts`), streams matches back over a pipe
(serviced by the GLib loop, where libuv handles are not), resolves each match's
metadata asynchronously, and the view appends results **incrementally** with
explicit **loading / results / empty / error** states. Directory listing uses the
same async, incremental, cancellable approach (`enumerateChildrenAsync` +
batched `nextFilesAsync`). File operations run time-sliced on the idle loop so
large copies never block the UI, reporting progress in a bottom bar.

## Status

P0 + P1 + the async-architecture pass complete: grid/list browsing, breadcrumb +
location entry, tabs with per-tab history, places sidebar, live refresh,
context-menu operations (new folder, rename, copy/cut/paste, trash, delete,
properties), sort, show-hidden, zoom, recursive out-of-process search, and proper
loading/empty/error states. See `PLAN.md` for the P2/P3 roadmap (thumbnails,
undo/redo, archive extract/compress, batch rename, DnD, column chooser).

## node-gtk notes (gotchas hit while building)

- GFile/interface methods live on the interface **prototype** — routed via the
  `F` proxy in `core/gio.ts`.
- Under ESM `app.run()` returns immediately; an explicit `GLib.MainLoop` runs in
  `activate`, quit on `window-removed`.
- List factory / signal callbacks drop the emitter arg (factory → `(listItem)`).
- **GVariants passed into JS signal callbacks are corrupted**, so menu actions
  are driven by action identity + JS state, never the signal variant.
- `Gio.DataInputStream.readLineFinish` returns `[number[], len]`; at **EOF
  node-gtk returns an empty array** (not null), so a zero-length read = EOF
  (the line protocol must never emit blank lines).
- `GLib.getMonotonicTime()` returns a **BigInt** — convert before arithmetic.
