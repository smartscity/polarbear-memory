#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo to remove the system package. Project Memory data is not deleted." >&2
  exit 1
fi

BIN_PATH=/usr/local/bin/polarbear-memory
INSTALL_PATH=/usr/local/lib/polarbear-memory

if [ -L "$BIN_PATH" ] && [ "$(readlink "$BIN_PATH")" = "../lib/polarbear-memory/polarbear-memory" ]; then
  rm "$BIN_PATH"
fi
if [ -d "$INSTALL_PATH" ]; then
  rm -rf "$INSTALL_PATH"
fi
pkgutil --forget com.smartscity.polarbear-memory >/dev/null 2>&1 || true
echo "Polarbear Memory application files removed. User data and repository knowledge were preserved."
