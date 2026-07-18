#!/usr/bin/env bash
# Launch Pao on macOS.
#
# Why this script: some terminals (notably VS Code's integrated terminal) export
# ELECTRON_RUN_AS_NODE=1, which makes `electron .` boot as plain Node — so
# `require("electron")` returns no app API and startup crashes with
# "Cannot read properties of undefined (reading 'commandLine')". We strip it here.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
echo "[pao] launching… grant Accessibility when prompted for typing/scroll reactions."
echo "[pao] quit from the 🐾 menu-bar icon, or press ⌥⌘Q."
exec env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
