# Making Mariner your default file manager

Two separate mechanisms decide whether "open a folder" and "show this file in
the file manager" land on Mariner or on Nautilus:

1. **`inode/directory` MIME default** — opening a folder (from another app, a
   file chooser, `xdg-open`) launches whichever app is registered for
   `inode/directory`. Mariner's `.desktop` file already declares it; you just
   need to make Mariner the *preferred* one.

2. **`org.freedesktop.FileManager1`** — a cross-desktop D-Bus interface that
   apps call to **reveal a specific file**: a browser's "Show in folder", a
   completed-download notification, `gio open`, GTK/Qt "open containing folder",
   etc. Whoever owns this bus name answers those calls. It exposes three
   methods:

   | Method | Mariner does |
   | --- | --- |
   | `ShowFolders(uris, startupId)` | opens each URI as a folder |
   | `ShowItems(uris, startupId)` | opens each item's parent folder and selects the item |
   | `ShowItemProperties(uris, startupId)` | reveals the items and opens Properties |

## The quick way

```sh
mariner-set-default          # installed package
# — or, from a git checkout —
MARINER_EXEC="node --import $PWD/node_modules/node-gtk/lib/esm/register.mjs $PWD/src/main.ts" \
  packaging/set-default-file-manager.sh
```

This sets the `inode/directory` default and installs a **per-user** D-Bus
activation service at
`~/.local/share/dbus-1/services/org.freedesktop.FileManager1.service`. A per-user
service file overrides the system one (Nautilus ships
`/usr/share/dbus-1/services/org.freedesktop.FileManager1.service`), so this needs
no root and does not conflict with an installed `nautilus` package.

Undo it with `mariner-set-default --undo` (or
`packaging/set-default-file-manager.sh --undo`).

> If Nautilus is **currently running** it already owns the bus name; D-Bus
> activation only fires when the name is unowned. Quit it (`nautilus -q`) or log
> out and back in for Mariner to take over.

## Why a separate `gjs` process

Mariner runs on **node-gtk**, whose GObject-introspection bindings cannot host a
D-Bus object: `g_dbus_connection_register_object`, its
`_with_closures` variant, and message filters all depend on closure/vtable
marshalling node-gtk does not implement (its GClosure marshaller is hardcoded
for signal dispatch, and it does not add the transfer-full reference a filter's
return value needs — it crashes). So the interface is hosted by a small **gjs**
script, [`data/filemanager1.js`](../data/filemanager1.js), which owns the name
and translates each method into a `mariner` command:

```
ShowItems(["file:///…/report.pdf"])  →  mariner --select   file:///…/report.pdf
ShowFolders(["file:///…/Downloads"]) →  mariner            file:///…/Downloads
ShowItemProperties(["file:///…/x"])  →  mariner --properties file:///…/x
```

`mariner --select`/`--properties` open the parent folder and select the
item(s) — the CLI entry points that back the reveal.

## Manual / system-wide setup

If you have removed Nautilus and want a **system-wide** activation service
instead of the per-user override, install the reference file
[`data/org.freedesktop.FileManager1.service`](../data/org.freedesktop.FileManager1.service)
(its `Exec` points at `/usr/lib/mariner/filemanager1.js`, where the package
installs the gjs script):

```sh
sudo install -Dm644 data/org.freedesktop.FileManager1.service \
  /usr/share/dbus-1/services/org.freedesktop.FileManager1.service
```

Set the folder handler by hand with:

```sh
xdg-mime default com.github.romgrk.mariner.desktop inode/directory
```
