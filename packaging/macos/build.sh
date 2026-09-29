#!/usr/bin/env bash
# Builds openCycle.app: a native launcher bundle that starts the openCycle
# server with real Bluetooth and opens the UI in the browser.
#
#   pnpm app                     build, then install into ~/Applications
#   pnpm app -- --out /tmp/x     build into another directory
#   pnpm app -- --sim            simulator + no Bluetooth (for trying it out)
#   pnpm app -- --no-build       reuse the existing apps/web/dist
#
# The repo path is baked into the bundle's Info.plist (OCRepoPath) at build
# time, so the app keeps working from wherever the clone lives. Move the clone
# and rebuild, or move it back.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/packaging/macos"
BUNDLE_ID="dev.opencycle.app"
APP_NAME="openCycle"
OUT_DIR="$HOME/Applications"
SIM=""
DATA_DIR=""
BLE=1
BUILD=1
BACKUP=1

usage() {
  cat <<'EOF'
usage: pnpm app [-- [options]]

  --out <dir>        install the bundle into <dir> (default ~/Applications)
  --sim[=2x2]        simulated trainers and no Bluetooth (default 2x2)
  --no-ble           never set OPENCYCLE_BLE=1
  --data-dir <path>  where the app keeps its database and FIT files
  --no-build         skip the web build
  --no-backup        do not back up an existing bundle at the target path
  -h, --help         this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --out=*) OUT_DIR="${1#*=}"; shift ;;
    --sim) SIM="2x2"; shift ;;
    --sim=*) SIM="${1#*=}"; shift ;;
    --no-ble) BLE=0; shift ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --data-dir=*) DATA_DIR="${1#*=}"; shift ;;
    --no-build) BUILD=0; shift ;;
    --no-backup) BACKUP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "pnpm app: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('$REPO/package.json').version")"
APP="$OUT_DIR/$APP_NAME.app"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opencycle-app.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> openCycle.app $VERSION"
echo "    repo:    $REPO"
echo "    install: $APP"
if [ -n "$SIM" ]; then echo "    mode:    simulator $SIM (no Bluetooth)"; fi
if [ -n "$DATA_DIR" ]; then echo "    data:    $DATA_DIR"; fi

if [ "$BUILD" = 1 ]; then
  echo "==> building the web client"
  (cd "$REPO" && pnpm build)
fi
if [ ! -f "$REPO/apps/web/dist/index.html" ]; then
  echo "pnpm app: no web build at apps/web/dist — drop --no-build" >&2
  exit 1
fi

echo "==> compiling the launcher"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  "$HERE/launcher.swift" -o "$WORK/openCycle"

echo "==> drawing the icon"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  "$HERE/make-icon.swift" -o "$WORK/make-icon"
rm -rf "$WORK/openCycle.iconset"
mkdir -p "$WORK/openCycle.iconset"
"$WORK/make-icon" "$WORK/icon-1024.png" 1024
for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
            "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" "512:icon_256x256@2x" \
            "512:icon_512x512" "1024:icon_512x512@2x"; do
  px="${spec%%:*}"; name="${spec##*:}"
  sips -z "$px" "$px" "$WORK/icon-1024.png" --out "$WORK/openCycle.iconset/$name.png" >/dev/null
done
iconutil -c icns -o "$WORK/openCycle.icns" "$WORK/openCycle.iconset"

echo "==> assembling the bundle"
if [ -e "$APP" ] && [ "$BACKUP" = 1 ]; then
  BACKUP_PATH="$APP.bak-$(date +%Y%m%d-%H%M%S)"
  echo "    backing up the existing bundle to $(basename "$BACKUP_PATH")"
  cp -R "$APP" "$BACKUP_PATH"
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/openCycle" "$APP/Contents/MacOS/openCycle"
cp "$WORK/openCycle.icns" "$APP/Contents/Resources/openCycle.icns"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>openCycle</string>
  <key>CFBundleIconFile</key><string>openCycle.icns</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>openCycle connects to your smart trainer and heart rate strap over Bluetooth.</string>
  <key>OCRepoPath</key><string>$REPO</string>
  <key>OCBle</key>$( [ "$BLE" = 1 ] && echo '<true/>' || echo '<false/>' )
$( [ -n "$SIM" ] && printf '  <key>OCSim</key><string>%s</string>\n' "$SIM" )
$( [ -n "$DATA_DIR" ] && printf '  <key>OCDataDir</key><string>%s</string>\n' "$DATA_DIR" )
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "==> signing (ad-hoc)"
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict "$APP"

echo
echo "openCycle.app is installed at:"
echo "  $APP"
echo
echo "Launch it with:  open -a $APP"
echo "Quit it with:    osascript -e 'tell application id \"$BUNDLE_ID\" to quit'"
