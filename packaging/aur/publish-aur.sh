#!/usr/bin/env bash
#
# Publish the mariner-git package to the AUR.
#
# Syncs this directory's PKGBUILD + mariner.install into a clone of the AUR repo,
# regenerates .SRCINFO, commits, and (only when asked) pushes. The app sources
# themselves are NOT uploaded — the PKGBUILD's source=git+https clones them from
# GitHub at build time, so make sure your packaging commits are pushed to
# origin/master first.
#
# Usage:
#   ./publish-aur.sh ["commit message"]      # sync + commit, then DRY RUN (no push)
#   AUR_PUSH=1 ./publish-aur.sh ["message"]  # sync + commit + push to the AUR
#
# Env:
#   AUR_WORKDIR   where to keep the AUR clone (default: ~/src/mariner-git-aur)
#   AUR_PUSH=1    actually push (default: dry run — you review, then push)
#
set -euo pipefail

AUR_PKG="mariner-git"
AUR_URL="ssh://aur@aur.archlinux.org/${AUR_PKG}.git"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # packaging/aur
WORK_DIR="${AUR_WORKDIR:-$HOME/src/${AUR_PKG}-aur}"
FILES=(PKGBUILD mariner.install)

msg()  { printf '\033[1;34m::\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v makepkg >/dev/null || die "makepkg not found (install base-devel)."
for f in "${FILES[@]}"; do
  [[ -f "$SRC_DIR/$f" ]] || die "missing $SRC_DIR/$f"
done

# Warn if the packaging commits aren't on origin/master yet — the AUR build
# clones the app from GitHub, so unpushed packaging would build stale sources.
if git -C "$SRC_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if ! git -C "$SRC_DIR" diff --quiet origin/master -- "$SRC_DIR" 2>/dev/null; then
    msg "WARNING: packaging differs from origin/master — did you 'git push' first?"
  fi
fi

# 1. Clone the AUR repo, or reuse an existing clone (verifying it's really ours).
if [[ -d "$WORK_DIR/.git" ]]; then
  origin="$(git -C "$WORK_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "$AUR_URL" ]] || die "$WORK_DIR exists but origin is '$origin', not $AUR_URL"
  msg "Reusing AUR clone at $WORK_DIR"
  git -C "$WORK_DIR" pull --ff-only 2>/dev/null || true   # empty repo (new pkg) -> no-op
else
  msg "Cloning $AUR_URL -> $WORK_DIR"
  git clone "$AUR_URL" "$WORK_DIR"
fi

# 2. Sync the packaging files.
msg "Copying: ${FILES[*]}"
for f in "${FILES[@]}"; do cp "$SRC_DIR/$f" "$WORK_DIR/$f"; done

# 3. Regenerate .SRCINFO from the PKGBUILD (AUR rejects a PKGBUILD/.SRCINFO
#    mismatch). For a -git package the pkgver here is the placeholder; it is
#    recomputed at build time by pkgver(), which is expected and accepted.
msg "Regenerating .SRCINFO"
( cd "$WORK_DIR" && makepkg --printsrcinfo > .SRCINFO )

# 4. Commit if anything changed.
cd "$WORK_DIR"
git add "${FILES[@]}" .SRCINFO
if git diff --cached --quiet; then
  msg "No changes to publish — AUR is already up to date."
  exit 0
fi
msg "Staged changes:"; git --no-pager diff --cached --stat
git commit -m "${1:-upgpkg: sync mariner-git packaging}"

# 5. Push only when explicitly asked (this is a public, hard-to-undo action).
if [[ "${AUR_PUSH:-0}" == "1" ]]; then
  msg "Pushing to the AUR"
  git push
  msg "Done — https://aur.archlinux.org/packages/${AUR_PKG}"
else
  msg "DRY RUN: committed locally in $WORK_DIR but not pushed."
  msg "Review it, then:  (cd '$WORK_DIR' && git push)"
  msg "Or re-run with:   AUR_PUSH=1 $0"
fi
