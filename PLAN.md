# Nautilus clone — plan

GTK4 file manager in node-gtk, UI as close to GNOME Files as possible.
Closeness is free: we drive the **same** Gtk4 + libadwaita widgets nautilus does.

> **Status:** P0 + P1 done, plus a TypeScript + decoupled-service-layer rewrite
> (async/incremental directory listing, out-of-process streaming search with
> loading/empty/error states, time-sliced file operations). See README for the
> architecture. P2/P3 remain.

## Stack
- node-gtk (ESM, `node --import node-gtk/register src/main.mjs`)
- `gi:Gtk-4.0`, `gi:Adw-1`, `gi:Gio-2.0`, `gi:GLib-2.0`, `gi:Gdk-4.0`, `gi:Pango-1.0`
- Local: gtk 4.22.4, libadwaita 1.9.1, node 22 — all present.
- Build UI in JS code (no blueprint compiler); same widget tree as nautilus .blp.

## File layout (src/)
- `main.mjs`        Adw.Application, actions, accels
- `window.mjs`      Adw.ApplicationWindow: split-view + tabview + breakpoint
- `ui/toolbar.mjs`  headerbar: history / pathbar↔location↔search stack / view-controls / new-folder
- `ui/pathbar.mjs`  breadcrumb buttons
- `ui/sidebar.mjs`  places: home, recent, trash, bookmarks, mounts/volumes, network
- `ui/view.mjs`     slot = grid|list view over the model (GtkGridView/ColumnView)
- `ui/cells.mjs`    name/icon cell factory, list columns
- `ui/dialogs.mjs`  rename, new-folder, properties, prefs, shortcuts, about, conflict
- `model/directory.mjs`  Gio enumerate → GListStore of file items + monitor
- `model/file.mjs`       file-item: name, gicon, size, mtime, type, perms
- `model/bookmarks.mjs`  read/write ~/.config/gtk-3.0/bookmarks
- `model/history.mjs`    per-slot back/forward stack
- `ops/operations.mjs`   copy/move/trash/delete/rename/mkdir/link via Gio
- `ops/compress.mjs`     extract/compress (shell to libarchive/`tar`)

## UI tree (mirror of nautilus-window.blp)
```
Adw.ApplicationWindow [view]
└ Adw.ToastOverlay
  └ Adw.OverlaySplitView (max-sidebar 240)
    ├ sidebar: Adw.ToolbarView
    │   top  Adw.HeaderBar [search-everywhere | "Files" | menu]
    │   body Sidebar (places ListBox)
    │   bot  progress indicator
    └ content: Adw.ToolbarView
        top  Toolbar (Adw.HeaderBar, see below)
        top  Adw.TabBar → Adw.TabView (1 page = 1 slot)
        bot  ActionBar (responsive: history + view controls)
Adw.Breakpoint (max-width 682sp) → collapse sidebar, move controls to actionbar
```
Toolbar headerbar: `[start]` sidebar-toggle, back, forward · `[title]` Stack{pathbar|location-entry|search} + search-toggle · `[end]` view-controls SplitButton(grid⇄list + popover: zoom±, sort, hidden, columns, captions) + new-folder.

## Features (priority order)
**P0 — usable browser**
- Enumerate a dir → grid view of icon+name (GtkGridView + GtkSignalListItemFactory)
- Default theme icons via `Gio.content_type_get_icon` / folders
- Double-click folder → navigate; open file → `gio open`/default app
- Pathbar breadcrumbs; click to jump
- Back / forward / up; per-tab history
- Sidebar places (home, recent, trash, bookmarks, mounts); click → navigate
- Tabs: new/close/switch (Adw.TabView)
- Directory live-refresh (Gio.FileMonitor)

**P1 — file management**
- List view (Gtk.ColumnView: name, size, type, modified) + grid⇄list toggle
- Selection (rubber-band, ctrl/shift, select-all)
- Context menu (open, open-with, cut/copy/paste, rename, trash, compress, properties…)
- Operations: copy, move, trash, delete, rename, new folder, paste, create link
- Rename popover; new-folder dialog
- Sort (name/size/type/modified, asc/desc); show hidden (ctrl+H)
- Cut/copy/paste via Gdk.Clipboard
- Drag & drop (move/copy between dirs and from outside)
- Progress indicator + toasts (incl. undo-delete)

**P2 — search & polish**
- Location entry (ctrl+L) to type a path
- Search current folder (recursive name match) + search-everywhere
- Properties window (info, permissions, open-with default)
- Zoom levels (grid icon size, list row size)
- Thumbnails for images
- Preferences, keyboard-shortcuts window, about dialog
- Undo/redo of operations
- Extract/compress archives
- Bookmarks add/remove/reorder

**P3 — extras** (only if time): batch rename, column chooser, captions, set-as-wallpaper, trash restore, network mounts, recoloring/tags.

## Keybinds (match nautilus)
ctrl+L location · ctrl+F search · ctrl+H hidden · ctrl+T new tab · ctrl+W close · alt+←/→ history · alt+↑ up · F2 rename · Del trash · ctrl+C/X/V · ctrl+A select-all · ctrl+Z/Y undo.

## node-gtk gotchas (from prior work)
- GInterface methods (GFile.getPath, enumerateChildren) live on `.prototype`, not instances — call via the class proto or use sync variants carefully.
- CustomSorter/CustomFilter JS callbacks may receive `undefined` args — prefer Gtk built-in sorters (Gtk.StringSorter/NumericSorter via expressions) or sort the GListStore manually.
- fs.watch / libuv handles are NOT serviced under the GLib loop — use Gio.FileMonitor + GLib.timeoutAdd for all async/watching.
- `app.run()` returns immediately under ESM — call last; quit from close/destroy handler.
- Build virtual/vfunc widgets by subclassing then `new` (registers GType); use Gtk.SignalListItemFactory (JS callbacks) over BuilderListItemFactory.

## Milestones
1. Window shell + sidebar + empty grid + navigation (P0)
2. List view + selection + context menu + core ops (P1)
3. Search + properties + dialogs + thumbnails + undo (P2)
