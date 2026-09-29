#!/bin/zsh
# openCycle rig launcher — runs inside openCycle.app so BLE gets a proper
# TCC identity (NSBluetoothAlwaysUsageDescription in the app's Info.plist).
# Default: dev server with real BLE. Override: put a one-shot command in
# /tmp/opencycle-app-cmd; it is consumed (moved aside) and executed instead.
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null 2>&1 || true
export PATH="/opt/homebrew/bin:$PATH"

cd "$(dirname "$0")/.." || exit 1

CMD_FILE=/tmp/opencycle-app-cmd
if [ -f "$CMD_FILE" ]; then
  mv "$CMD_FILE" "${CMD_FILE}.running"
  echo "[rig-app] one-shot: $(cat "${CMD_FILE}.running")"
  /bin/zsh "${CMD_FILE}.running"
  rc=$?
  echo "[rig-app] one-shot exited: $rc"
  exit $rc
fi

echo "[rig-app] starting dev server with OPENCYCLE_BLE=1"
export OPENCYCLE_BLE=1
exec pnpm dev:server
