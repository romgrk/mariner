# Developer notes

Mariner is a [GNOME Files](https://gitlab.gnome.org/GNOME/nautilus) clone
written in **TypeScript** on top of
[node-gtk](https://github.com/romgrk/node-gtk), GTK4 + libadwaita. It drives the
same Adw/Gtk widgets Nautilus does, so the UI matches closely.

## Development

```sh
npm install          # installs node-gtk + typescript/@types/node
npm start            # node --import node-gtk/register src/main.ts
npm run typecheck    # tsc --noEmit
```

TypeScript runs with **no build step** via Node's native type stripping (Node ≥
22.6 strips `.ts` by default). Requires GTK ≥ 4.16, libadwaita ≥ 1.5, and their
typelibs (`Gtk-4.0`, `Adw-1`).

> The `pnpm-workspace.yaml` override links `node-gtk` to a sibling `../node-gtk`
> checkout for developing the two together; a plain `npm install` pulls
> `node-gtk` from the npm registry instead.

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

## Status & roadmap

GNOME Files parity plus net-new features are in: grid/list browsing, tabs, dual
pane, breadcrumb + location entry, places sidebar, live refresh, context-menu
operations, sort/show-hidden/zoom, recursive out-of-process + ripgrep content
search, Quick Look, command palette, and a disk-usage sunburst. See
[PLAN.md](PLAN.md) for the architecture, node-gtk gotchas, implementation notes,
and open ideas.

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

## Packaging

The AUR package (`mariner-git`) and its notes live in
[`packaging/aur/`](packaging/aur/).
