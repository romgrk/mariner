# nautilus-clone

A [GNOME Files](https://gitlab.gnome.org/GNOME/nautilus) (nautilus) clone built
with [node-gtk](https://github.com/romgrk/node-gtk), GTK4 + libadwaita. It drives
the same Adw/Gtk widgets nautilus does, so the UI matches closely.

## Run

```sh
npm install              # or: link a local node-gtk build into node_modules/
npm start
```

Requires GTK ≥ 4.16, libadwaita ≥ 1.5, and their typelibs (`Gtk-4.0`, `Adw-1`).

## Status

Implemented (P0 + P1 from `PLAN.md`):

- Browse with **grid** and **list** views (shared selection), folders-first sort
- **Breadcrumb** path bar + **location entry** (Ctrl+L)
- **Tabs** (Adw.TabView), per-tab **history** (back/forward/up)
- **Sidebar** places (Recent, Home, special dirs, Trash, bookmarks, devices)
- Live directory refresh via `Gio.FileMonitor`
- **Context menu** + operations: new folder, rename, copy/cut/paste, move to
  trash, delete, properties, select-all, empty trash
- **Sort** (name/size/type/modified, asc/desc), **show hidden** (Ctrl+H), **zoom**
- In-folder **search** (Ctrl+F), responsive sidebar collapse, toasts

See `PLAN.md` for the full feature roadmap (P2/P3: real thumbnails, global
search, undo/redo, archive extract/compress, batch rename, DnD, column chooser).

## Layout

`src/main.mjs` (app + accels) · `src/window.mjs` (shell, tabs, actions, ops
wiring) · `src/tab.mjs` (slot: location + history + model + view) ·
`src/model.mjs` (directory listing + monitor) · `src/ops.mjs` (file operations) ·
`src/util.mjs` (GFile/format helpers) · `src/ui/*` (toolbar, pathbar, sidebar,
view, dialogs).

## node-gtk notes

- GFile/interface methods live on the interface **prototype** — routed through a
  `F` proxy in `util.mjs`.
- Under ESM, `app.run()` returns immediately; an explicit `GLib.MainLoop` is run
  in `activate` and quit on `window-removed`.
- List factory / signal callbacks drop the emitter arg (factory → `(listItem)`).
- **GVariants passed *into* JS signal callbacks are corrupted**, so menu actions
  are driven by action identity + JS state, never by reading the signal variant.
