#!/bin/sh
# Make Mariner the default file manager for the current user.
#
# Two things make "open a folder" and "show in folder" land on Mariner:
#
#   1. inode/directory MIME default  → opening a folder (Nautilus's job) opens
#      Mariner. Handled by `xdg-mime default`.
#   2. org.freedesktop.FileManager1  → a browser's "Show in folder", a download
#      notification, `gio open`, etc. call this D-Bus interface to reveal a file.
#      We install a *per-user* activation service (in $XDG_DATA_HOME, which wins
#      over the system /usr/share one Nautilus ships) that starts Mariner's gjs
#      FileManager1 translator on demand.
#
# This is per-user and reversible (see --undo); it never touches system files,
# so it does not conflict with an installed nautilus package.
#
# Usage:
#   set-default-file-manager.sh            # install
#   set-default-file-manager.sh --undo     # remove
#
# In a git checkout, `mariner` is not on $PATH. Point the service at your dev
# launcher with MARINER_EXEC, e.g.:
#   MARINER_EXEC="node --import $PWD/node_modules/node-gtk/lib/esm/register.mjs $PWD/src/main.ts" \
#     packaging/set-default-file-manager.sh

set -eu

DESKTOP_ID=com.github.romgrk.mariner.desktop
BUS_NAME=org.freedesktop.FileManager1
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
SERVICE_DIR=$DATA_HOME/dbus-1/services
SERVICE_FILE=$SERVICE_DIR/$BUS_NAME.service

if [ "${1:-}" = "--undo" ]; then
  rm -f "$SERVICE_FILE"
  echo "Removed $SERVICE_FILE"
  echo "Note: your inode/directory default is unchanged; reset it with"
  echo "  xdg-mime default org.gnome.Nautilus.desktop inode/directory"
  exit 0
fi

# Locate the gjs FileManager1 translator: prefer an installed copy, else the
# one next to this script in a checkout (../data/filemanager1.js).
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for cand in \
  /usr/lib/mariner/filemanager1.js \
  /usr/local/lib/mariner/filemanager1.js \
  "$SCRIPT_DIR/../data/filemanager1.js"
do
  if [ -f "$cand" ]; then FM1_SCRIPT=$cand; break; fi
done
if [ -z "${FM1_SCRIPT:-}" ]; then
  echo "error: could not find filemanager1.js (looked in /usr/lib/mariner and $SCRIPT_DIR/../data)" >&2
  exit 1
fi

GJS=$(command -v gjs || true)
if [ -z "$GJS" ]; then
  echo "error: gjs is not installed (needed to host the FileManager1 D-Bus service)" >&2
  exit 1
fi

# Build the Exec line. If MARINER_EXEC is set (dev checkout), thread it through
# so the service launches your dev build instead of a `mariner` on $PATH.
if [ -n "${MARINER_EXEC:-}" ]; then
  EXEC="/bin/sh -c 'MARINER_EXEC=\"$MARINER_EXEC\" exec \"$GJS\" \"$FM1_SCRIPT\"'"
else
  EXEC="$GJS $FM1_SCRIPT"
fi

mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[D-BUS Service]
Name=$BUS_NAME
Exec=$EXEC
EOF
echo "Installed $SERVICE_FILE"

# Make Mariner the folder handler too (best-effort).
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default "$DESKTOP_ID" inode/directory && \
    echo "Set $DESKTOP_ID as the inode/directory handler"
fi

# If something already owns the name (e.g. a running Nautilus), the change only
# takes full effect once that owner exits — activation only fires with no owner.
if command -v gdbus >/dev/null 2>&1 &&
   gdbus call --session --dest org.freedesktop.DBus \
     --object-path /org/freedesktop/DBus \
     --method org.freedesktop.DBus.GetNameOwner "$BUS_NAME" >/dev/null 2>&1; then
  echo
  echo "Note: $BUS_NAME currently has an owner (probably a running Nautilus)."
  echo "      Quit it (e.g. 'nautilus -q') or log out and back in for Mariner to take over."
fi

echo "Done."
