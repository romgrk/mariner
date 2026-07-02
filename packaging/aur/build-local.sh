#!/usr/bin/env bash
#
# Build the mariner-git package from the current working TREE — including
# uncommitted, staged and untracked changes — instead of cloning origin/master
# the way the published PKGBUILD does. For local testing only; never publish the
# generated PKGBUILD.
#
# It derives a throwaway PKGBUILD from the canonical one, reusing build() and
# package() verbatim (so they can never drift), but:
#   - bakes in a static pkgver (mirrors the real formula, + ".dirty" when the
#     tree has uncommitted changes) instead of the git-based pkgver(), and
#   - replaces the git+https source with a prepare() that rsyncs your working
#     tree into makepkg's $srcdir.
#
# Always builds fresh in a fixed directory.
#
# Usage:
#   ./build-local.sh                  # build; print the resulting .pkg.tar.zst
#   ./build-local.sh -i               # build, then `sudo pacman -U` the result
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # packaging/aur
REPO_ROOT="$(cd "$SRC_DIR/../.." && pwd)"
BUILD_DIR="$HOME/.cache/mariner-aur-build"

msg() { printf '\033[1;34m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

install_pkg=0
[[ "${1:-}" == "-i" || "${1:-}" == "--install" ]] && install_pkg=1

command -v makepkg >/dev/null || die "makepkg not found (install base-devel)."
command -v rsync   >/dev/null || die "rsync not found (needed to copy the working tree)."
[[ -f "$SRC_DIR/PKGBUILD" && -f "$SRC_DIR/mariner.install" ]] \
  || die "missing PKGBUILD or mariner.install in $SRC_DIR"

# pkgver mirrors the PKGBUILD's own formula: <package.json version>.rN.gHASH,
# plus a ".dirty" suffix whenever the tree has any uncommitted/untracked change,
# so a working-tree test build can never be confused with a real one.
ver="$(sed -n 's/[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$REPO_ROOT/package.json" | head -n1)"
pkgver="$(printf '%s.r%s.g%s' "${ver:-0.0.0}" \
           "$(git -C "$REPO_ROOT" rev-list --count HEAD)" \
           "$(git -C "$REPO_ROOT" rev-parse --short HEAD)")"
[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || pkgver+=".dirty"

# Always start from a clean build directory.
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp "$SRC_DIR/mariner.install" "$BUILD_DIR/"

# Generate the working-tree PKGBUILD. The sed:
#   - pins pkgver to the value computed above
#   - empties source=() and sha256sums=() (nothing is fetched)
#   - deletes the git-based pkgver() function block
# then we append a prepare() that copies the tree in. node_modules is excluded
# so build() does a clean `npm install` against system GTK — exactly like the
# published package (this also avoids copying the dev node-gtk symlink).
{
  sed -e "s|^pkgver=.*|pkgver=$pkgver|" \
      -e "s|^source=.*|source=()|" \
      -e "s|^sha256sums=.*|sha256sums=()|" \
      -e "/^pkgver() {/,/^}/d" \
      "$SRC_DIR/PKGBUILD"
  cat <<EOF

# --- injected by build-local.sh: build from the working tree ---
_worktree='$REPO_ROOT'
prepare() {
  rsync -a --delete \\
    --exclude='.git/' \\
    --exclude='node_modules/' \\
    "\$_worktree"/ "\$srcdir/\$_pkgname"/
}
EOF
} > "$BUILD_DIR/PKGBUILD"

msg "Source tree: $REPO_ROOT"
msg "Build dir:   $BUILD_DIR"
msg "pkgver:      $pkgver"
( cd "$BUILD_DIR" && makepkg -f )

pkg="$(cd "$BUILD_DIR" && ls -1t mariner-git-*.pkg.tar.* 2>/dev/null \
        | grep -v -- '-debug-' | head -n1)"
[[ -n "$pkg" ]] || die "build finished but no package file found in $BUILD_DIR"
pkg="$BUILD_DIR/$pkg"
msg "Built: $pkg"

if [[ $install_pkg == 1 ]]; then
  msg "Installing with pacman -U"
  sudo pacman -U --noconfirm "$pkg"
else
  msg "Test it:  sudo pacman -U '$pkg'  &&  mariner"
fi
