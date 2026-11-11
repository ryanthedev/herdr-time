#!/bin/sh
# install.sh: copy mods/time into Herdr (<home>/mods/time). Herdr hot-reloads it.
# HERDR_APP_HOME picks a test window's home instead of ~/.config/herdr-app.
set -e
cd "$(dirname "$0")/.."
DEST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/time"
mkdir -p "$DEST"
cp mods/time/main.js mods/time/mod.json "$DEST/"
echo "installed to $DEST"
herdr-app check "$DEST"
