# Mariner

A native file manager for the GNOME desktop, modeled closely on
[GNOME Files](https://gitlab.gnome.org/GNOME/nautilus) (Nautilus). It's built on
GTK4 and libadwaita, so it looks and feels right at home on GNOME.

## Features

- **Grid and list views** with adjustable zoom
- **Tabbed browsing** with independent per-tab history and a breadcrumb path bar
- **Places sidebar** with bookmarks and mounted volumes
- **File operations** — copy, move, rename, trash, and delete, with live progress
- **Fast recursive search** that streams matches as they're found, including
  in-file content search when [ripgrep](https://github.com/BurntSushi/ripgrep)
  is installed
- **Archives** — extract and create `.zip` and `.tar` archives
- **Batch rename**, **image thumbnails**, disk-usage view, and the usual
  context-menu actions, sorting, and show-hidden toggle

## Install

### Arch Linux (AUR)

```sh
# with an AUR helper
paru -S mariner-git      # or: yay -S mariner-git

# or manually
git clone https://aur.archlinux.org/mariner-git.git && cd mariner-git
makepkg -si
```

Mariner then appears in your application menu with an icon. To make it your
default file manager:

```sh
xdg-mime default com.github.nodegtk.mariner.desktop inode/directory
```

### From source

Requires **Node ≥ 22.18**, **GTK ≥ 4.16**, and **libadwaita ≥ 1.5**, plus a C
toolchain and the GTK / GObject-Introspection headers (to build the native
bindings on first install).

```sh
git clone https://github.com/romgrk/mariner.git && cd mariner
npm install      # fetches and builds node-gtk
npm start
```

## Usage

Launch Mariner from your application menu, or open a specific folder from the
terminal:

```sh
mariner ~/Documents          # installed
npm start -- ~/Documents     # from source
```

## Contributing

Mariner is written in TypeScript on top of
[node-gtk](https://github.com/romgrk/node-gtk), with no build step. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the architecture overview and development
notes.

## License

[MIT](LICENSE) © Rom Grk
