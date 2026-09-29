#!/usr/bin/env bash
# Build the whole fleet: import -> finish -> bake/export -> validate -> smoke.
#
#   bash assets/ships/run_all.sh                 # every hull in fleet_config.FLEET
#   bash assets/ships/run_all.sh striker zenith  # a subset
#
# Blender can be overridden with BLENDER=/path/to/blender. Cycles runs on CPU
# throughout: Metal GPU bakes come out empty in --background on macOS.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
cd "$REPO"

if [ "$#" -gt 0 ]; then
  HULLS=("$@")
else
  read -r -a HULLS <<<"$(python3 -c "
import sys; sys.path.insert(0, '$HERE')
import fleet_config as C
print(' '.join(C.FLEET))
")"
fi

echo ">>> fleet: ${HULLS[*]}"

for hull in "${HULLS[@]}"; do
  echo "=== $hull: import"
  "$BLENDER" --background --factory-startup --python "$HERE/import_base.py" -- "$hull" 2>&1 | grep -E '^>>>|Error' || true
  echo "=== $hull: finish"
  "$BLENDER" --background --factory-startup --python "$HERE/finish.py" -- "$hull" 2>&1 | grep -E '^>>>|Error' || true
  echo "=== $hull: bake + export"
  "$BLENDER" --background --factory-startup --python "$HERE/bake_export.py" -- "$hull" 2>&1 | grep -E '^>>>|DISK|Error' || true
  echo "=== $hull: validate + proof render"
  "$BLENDER" --background --factory-startup --python "$HERE/validate_glb.py" -- "$hull" 2>&1 | grep -E '^>>>|Error' || true
done

echo "=== fleet contact sheet + silhouette metrics"
"$BLENDER" --background --factory-startup --python "$HERE/validate_glb.py" -- --sheet 2>&1 | grep -vE '^(Read prefs|Blender quit|found bundled|Fra:)' \
  | grep -viE 'INFO:|deprecat|Saved:' || true

echo "=== three.js smoke"
node "$HERE/smoke_three.mjs"

echo ">>> fleet built:"
ls -la "$REPO/apps/web/public/assets/ships/"
echo ">>> contact sheet: $HERE/renders/fleet_game.png"
