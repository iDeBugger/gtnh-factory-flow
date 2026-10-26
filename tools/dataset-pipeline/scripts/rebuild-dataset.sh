#!/usr/bin/env bash
# One dataset version from its raw export, inside the pipeline image (build-datasets.mjs runs it):
# normalize, icon hints from the pack's mod jars, asset fingerprint, resource index (with NEI's
# order), recipe index and shards, faint fluid icons. The result is $GTNH_BUILD_DIR/dataset, a
# fresh directory; recipes.json is moved beside it, since it is never published.
set -euo pipefail

: "${GTNH_DATASET_VERSION_ID:?GTNH_DATASET_VERSION_ID is required}"
: "${GTNH_DATASET_VERSION_LABEL:?GTNH_DATASET_VERSION_LABEL is required}"
: "${GTNH_INSTANCE_DIR:?GTNH_INSTANCE_DIR is required}"
: "${GTNH_BUILD_DIR:?GTNH_BUILD_DIR is required}"

raw="$GTNH_BUILD_DIR/raw-export"
dataset="$GTNH_BUILD_DIR/dataset"
scripts="tools/dataset-pipeline/scripts"

[[ -f "$raw/oracle-export.json" ]] || { echo "No raw export at $raw/oracle-export.json: export first." >&2; exit 1; }

# The pack zip unzips to an instance, or to a zip holding one (run-gtnh-oracle-export.sh).
instance_root=""
for candidate in "$GTNH_INSTANCE_DIR/pack" "$GTNH_INSTANCE_DIR/pack-content"; do
  if [[ -d "$candidate" ]] && instance_root="$(node "$scripts/find-gtnh-instance-root.mjs" "$candidate" 2>/dev/null)"; then
    break
  fi
  instance_root=""
done
[[ -n "$instance_root" ]] || { echo "No unpacked pack in $GTNH_INSTANCE_DIR: export first." >&2; exit 1; }
echo "Instance: $instance_root"

stage() { echo "== $1 ($(date -u +%H:%M:%S))"; }

rm -rf "$dataset"
mkdir -p "$dataset/textures"
# The game writes NEI's slot layouts beside the export, not into the raw export.
if [[ -d "$GTNH_BUILD_DIR/export/textures/nei-layouts" ]]; then
  cp -R "$GTNH_BUILD_DIR/export/textures/nei-layouts" "$dataset/textures/nei-layouts"
else
  echo "WARNING: no NEI layouts in $GTNH_BUILD_DIR/export/textures/nei-layouts" >&2
fi

stage normalize
GTNH_RENDERED_ICON_DIR="$raw/rendered-icons" \
  node "$scripts/normalize-oracle-export.mjs" "$raw/oracle-export.json" "$dataset/recipes.json"
stage "icon hints"
node "$scripts/resolve-icon-hints.mjs" "$instance_root" "$dataset/recipes.json" "$dataset"
stage "asset fingerprint"
node "$scripts/compute-asset-fingerprint.mjs" "$instance_root" "$dataset/textures/client-asset-fingerprint.json"
stage "resource index"
node "$scripts/build-resource-index.mjs" "$dataset/recipes.json"
stage "recipe index"
node "$scripts/build-recipe-index.mjs" "$dataset/recipes.json" "$dataset"
stage "fluid icon alpha"
node "$scripts/normalize-fluid-icon-alpha.mjs" "$dataset" --rename

mv "$dataset/recipes.json" "$GTNH_BUILD_DIR/recipes.json"
stage done
