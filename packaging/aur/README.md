# AUR packaging — `mariner-git`

This directory holds everything needed to publish Mariner to the
[AUR](https://aur.archlinux.org/) as a VCS package that builds from the
GitHub `HEAD`.

## What gets installed

| Path | Contents |
| --- | --- |
| `/usr/lib/mariner/src/` | the app's TypeScript sources (run directly via Node type-stripping) |
| `/usr/lib/mariner/node_modules/` | `node-gtk` with its native addon, compiled against system GTK |
| `/usr/bin/mariner` | launcher — `node --import .../node-gtk/lib/esm/register.mjs .../src/main.ts "$@"` |
| `/usr/share/applications/com.github.romgrk.mariner.desktop` | menu entry (handles `inode/directory`, so Mariner can be the default file manager) |
| `/usr/share/icons/hicolor/scalable/apps/com.github.romgrk.mariner.svg` | app icon (matched to the app-id, so the window/taskbar pick it up automatically) |
| `/usr/share/metainfo/com.github.romgrk.mariner.metainfo.xml` | AppStream metadata for software centers |

The launcher passes a folder path or `file://` URI straight through, so
`mariner ~/Documents` and "Open With → Mariner" both open that folder. Set it as
the default with `xdg-mime default com.github.romgrk.mariner.desktop inode/directory`.

## Test the build locally (no GitHub push required)

The `source=` points at GitHub, but you can point it at this working tree to
smoke-test the package before anything is pushed:

```sh
cp -r packaging/aur /tmp/mariner-pkg && cd /tmp/mariner-pkg
sed -i 's#git+https://github.com/romgrk/mariner.git#git+file:///home/romgrk/src/mariner#' PKGBUILD
makepkg -f            # builds; add -si to also install
```

`makepkg` clones the repo, so commit your changes first (a `file://` clone only
sees committed history).

## Publish to the AUR

1. Create and push the upstream repo (the `url`/`source` assume
   `github.com/romgrk/mariner`):
   ```sh
   cd /home/romgrk/src/mariner
   git remote add origin git@github.com:romgrk/mariner.git
   git push -u origin master        # or main
   ```
2. Clone the (empty) AUR repo and drop the packaging files in:
   ```sh
   git clone ssh://aur@aur.archlinux.org/mariner-git.git
   cd mariner-git
   cp /home/romgrk/src/mariner/packaging/aur/{PKGBUILD,mariner.install} .
   makepkg --printsrcinfo > .SRCINFO   # regenerate to capture the real pkgver
   git add PKGBUILD mariner.install .SRCINFO
   git commit -m "Initial import: mariner-git"
   git push
   ```

The checked-in `.SRCINFO` here is a placeholder (`pkgver=0.0.1.r0.g0000000`);
always regenerate it with `makepkg --printsrcinfo` so it reflects the real
commit count/hash.

## Tagged-release variant (`mariner`)

Once you cut a GitHub release, a non-VCS package is a small diff from this one:

```sh
pkgname=mariner
pkgver=0.0.1
source=("$pkgname-$pkgver.tar.gz::https://github.com/romgrk/mariner/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('<sha256 of the tarball>')
# drop the pkgver() function; in build()/package() use "$srcdir/$pkgname-$pkgver"
# drop provides=/conflicts= (the package name is already `mariner`)
```

Everything else (depends, makedepends, build, package) is identical.

## Caveats

- **Source build, not a prebuilt.** `node-gtk`'s `install` script is
  `node-pre-gyp install --fallback-to-build`, which *prefers* a prebuilt binary
  from its S3 host. Those prebuilts only exist for a handful of Node ABIs (at the
  time of writing: Node 20/22/24) and never for Arch's rolling `nodejs`, so the
  fallback would compile anyway. The PKGBUILD forces this with
  `npm_config_build_from_source=true` — no opaque binary is downloaded; the addon
  is compiled against the system libraries.
- **Native ABI.** The compiled `.node` is tied to the exact Node ABI it was built
  against, and the launcher pins `/usr/bin/node` at runtime. Build in a clean
  chroot (e.g. `makechrootpkg`) or with the system `nodejs` on `PATH` so the two
  match — not, say, an `nvm` Node. After a major Arch Node upgrade, rebuild the
  package. (`nodejs>=22.18` is required for unflagged TypeScript stripping.)
- **License.** The project is MIT-licensed (`LICENSE` at the repo root); the
  PKGBUILD declares `license=('MIT')` to match.
- **Network during `build()`.** `npm install` fetches `node-gtk` from the
  registry — standard for Node-based AUR packages, but it means the build is not
  fully offline/reproducible.
