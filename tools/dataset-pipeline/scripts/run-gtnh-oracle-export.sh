#!/usr/bin/env bash
set -euo pipefail

: "${GTNH_DATASET_OUT_DIR:?GTNH_DATASET_OUT_DIR is required}"
: "${GTNH_RAW_EXPORT_DIR:?GTNH_RAW_EXPORT_DIR is required}"
: "${GTNH_INSTANCE_DIR:?GTNH_INSTANCE_DIR is required}"
: "${GTNH_DATASET_VERSION_ID:?GTNH_DATASET_VERSION_ID is required}"
: "${GTNH_DATASET_VERSION_LABEL:?GTNH_DATASET_VERSION_LABEL is required}"
: "${GTNH_DATASET_CHANNEL:?GTNH_DATASET_CHANNEL is required}"

export GTNH_EXPORT_PACK_KIND="${GTNH_EXPORT_PACK_KIND:-client}"
export GTNH_EXPORT_TIMEOUT_SECONDS="${GTNH_EXPORT_TIMEOUT_SECONDS:-21600}"
export GTNH_EXPORT_MAX_MEMORY="${GTNH_EXPORT_MAX_MEMORY:-6G}"
export GTNH_RENDER_STACK_ICONS="${GTNH_RENDER_STACK_ICONS:-true}"
# Icons drawn per frame: each frame ends in a buffer swap, which cost a tenth of the icon pass at 64.
export GTNH_ICON_EXPORT_BATCH_SIZE="${GTNH_ICON_EXPORT_BATCH_SIZE:-256}"
export GTNH_ATLAS_ICON_SIZE="${GTNH_ATLAS_ICON_SIZE:-256}"
export GTNH_ICON_CACHE_DIR="${GTNH_ICON_CACHE_DIR:-$HOME/.cache/gtnh-factory-flow/icons/$GTNH_ATLAS_ICON_SIZE}"
export GTNH_EXPORT_DISABLE_CLIENT_UI_MODS="${GTNH_EXPORT_DISABLE_CLIENT_UI_MODS:-false}"
export GTNH_EXPORT_FAIL_FAST_ON_FATAL_LOGS="${GTNH_EXPORT_FAIL_FAST_ON_FATAL_LOGS:-true}"
export GTNH_EXPORT_MAX_RUNTIME_RESTARTS="${GTNH_EXPORT_MAX_RUNTIME_RESTARTS:-2}"
export GTNH_PACK_CACHE_DIR="${GTNH_PACK_CACHE_DIR:-}"
export GTNH_ORACLE_BUILD_CACHE_DIR="${GTNH_ORACLE_BUILD_CACHE_DIR:-}"
export GTNH_CLIENT_RUNTIME_CACHE_DIR="${GTNH_CLIENT_RUNTIME_CACHE_DIR:-}"

mkdir -p "$GTNH_DATASET_OUT_DIR" "$GTNH_RAW_EXPORT_DIR" "$GTNH_INSTANCE_DIR"

safe_dataset_id="$(printf '%s' "$GTNH_DATASET_VERSION_ID" | tr -c 'A-Za-z0-9._-' '_')"
safe_pack_kind="$(printf '%s' "$GTNH_EXPORT_PACK_KIND" | tr -c 'A-Za-z0-9._-' '_')"
if [[ -n "$GTNH_PACK_CACHE_DIR" ]]; then
  mkdir -p "$GTNH_PACK_CACHE_DIR"
  pack_archive="$GTNH_PACK_CACHE_DIR/${safe_dataset_id}-${safe_pack_kind}.zip"
else
  pack_archive="$GTNH_RAW_EXPORT_DIR/gtnh-pack.zip"
fi
runner_log="$GTNH_RAW_EXPORT_DIR/export-runner.log"
runtime_log="$GTNH_RAW_EXPORT_DIR/gtnh-runtime.log"
rendered_icon_dir="$(realpath -m "$GTNH_RAW_EXPORT_DIR/rendered-icons")"
nei_layout_dir="$(realpath -m "$GTNH_DATASET_OUT_DIR/textures/nei-layouts")"
oracle_output_dir="$(realpath -m "$GTNH_RAW_EXPORT_DIR/oracle-records")"
export GTNH_RENDERED_ICON_DIR="$rendered_icon_dir"

exec > >(tee -a "$runner_log") 2>&1

echo "GTNH export runner started at $(date -u --iso-8601=seconds)"
echo "Dataset: $GTNH_DATASET_VERSION_ID ($GTNH_DATASET_CHANNEL $GTNH_DATASET_VERSION_LABEL)"
echo "Memory: $GTNH_EXPORT_MAX_MEMORY"
echo "Timeout: ${GTNH_EXPORT_TIMEOUT_SECONDS}s"
echo "Pack kind: $GTNH_EXPORT_PACK_KIND"
echo "GTNH 1.7.10 icon exporter: $GTNH_RENDER_STACK_ICONS"
echo "Icon export batch size: $GTNH_ICON_EXPORT_BATCH_SIZE"
echo "Atlas icon size: $GTNH_ATLAS_ICON_SIZE"
echo "Shared icon cache: $GTNH_ICON_CACHE_DIR"
echo "Disable client UI-only mods: $GTNH_EXPORT_DISABLE_CLIENT_UI_MODS"
echo "Fail fast on fatal runtime logs: $GTNH_EXPORT_FAIL_FAST_ON_FATAL_LOGS"
echo "Runtime auto restarts: $GTNH_EXPORT_MAX_RUNTIME_RESTARTS"
echo "Pack cache: ${GTNH_PACK_CACHE_DIR:-disabled}"
echo "Oracle build cache: ${GTNH_ORACLE_BUILD_CACHE_DIR:-disabled}"
echo "Client runtime cache: ${GTNH_CLIENT_RUNTIME_CACHE_DIR:-disabled}"

node tools/dataset-pipeline/scripts/download-gtnh-pack.mjs "$pack_archive"

rm -rf "$GTNH_INSTANCE_DIR/pack"
mkdir -p "$GTNH_INSTANCE_DIR/pack"
unzip -q "$pack_archive" -d "$GTNH_INSTANCE_DIR/pack"
chmod -R u+rwX "$GTNH_INSTANCE_DIR/pack"

if ! instance_root="$(node tools/dataset-pipeline/scripts/find-gtnh-instance-root.mjs "$GTNH_INSTANCE_DIR/pack" 2>/tmp/gtnh-find-root.err)"; then
  nested_pack="$(find "$GTNH_INSTANCE_DIR/pack" -maxdepth 3 -type f -name '*.zip' 2>/dev/null | sort | head -n 1)"
  if [[ -z "$nested_pack" ]]; then
    cat /tmp/gtnh-find-root.err >&2
    exit 1
  fi

  rm -rf "$GTNH_INSTANCE_DIR/pack-content"
  mkdir -p "$GTNH_INSTANCE_DIR/pack-content"
  unzip -q "$nested_pack" -d "$GTNH_INSTANCE_DIR/pack-content"
  chmod -R u+rwX "$GTNH_INSTANCE_DIR/pack-content"
  instance_root="$(node tools/dataset-pipeline/scripts/find-gtnh-instance-root.mjs "$GTNH_INSTANCE_DIR/pack-content")"
fi
export GTNH_INSTANCE_ROOT="$instance_root"
mkdir -p "$instance_root/mods"

oracle_project="tools/dataset-pipeline/gtnh-calc-oracle"
# The pack picks the GregTech the mod compiles against (dependencies.gradle), so one
# source tree builds a different jar per pack: the pack goes in the cache key too. The key
# covers the sources only: build/, .gradle/ and run/ (a local runClient's natives, configs and
# saves) are the project's ignored outputs and never change the jar.
GTNH_ORACLE_PACK="${GTNH_ORACLE_PACK:-2.9}"
oracle_patch_hash="$(
  {
    echo "gtnhPack=$GTNH_ORACLE_PACK"
    find "$oracle_project" -type f \
      ! -path '*/build/*' \
      ! -path '*/.gradle/*' \
      ! -path "$oracle_project/run/*" \
      -print0 | sort -z | xargs -0 sha256sum
  } | sha256sum | awk '{print $1}'
)"
oracle_cached_jar=""
if [[ -n "$GTNH_ORACLE_BUILD_CACHE_DIR" ]]; then
  mkdir -p "$GTNH_ORACLE_BUILD_CACHE_DIR"
  oracle_cached_jar="$GTNH_ORACLE_BUILD_CACHE_DIR/gtnh-calc-oracle-$GTNH_ORACLE_PACK-$oracle_patch_hash.jar"
fi

if [[ -n "$oracle_cached_jar" && -f "$oracle_cached_jar" ]]; then
  echo "Using cached GTNH calculation oracle jar: $oracle_cached_jar"
  oracle_jar="$oracle_cached_jar"
else
  chmod +x "$oracle_project/gradlew"
  gradle_java_paths=()
  while IFS= read -r java_bin; do
    gradle_java_paths+=("$(dirname "$(dirname "$java_bin")")")
  done < <(find /opt/java/jvm17 /opt/java/openjdk /opt/java/jdk-25 -path '*/bin/java' -type f 2>/dev/null | sort)
  if (( ${#gradle_java_paths[@]} > 0 )); then
    gradle_java_paths_csv="$(IFS=,; echo "${gradle_java_paths[*]}")"
    export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.java.installations.paths=$gradle_java_paths_csv -Dorg.gradle.java.installations.auto-download=false"
  fi
  # Jar names carry the git commit, not the pack, so jars from an earlier commit or pack
  # would sit beside this build's. Clearing them first leaves only the jar built here.
  if [[ -d "$oracle_project/build/libs" ]]; then
    find "$oracle_project/build/libs" -maxdepth 1 -type f -name '*.jar' -delete
  fi
  if [[ -x /opt/java/jdk-25/bin/java ]]; then
    (cd "$oracle_project" && JAVA_HOME=/opt/java/jdk-25 PATH="/opt/java/jdk-25/bin:$PATH" ./gradlew --no-daemon build -PgtnhPack="$GTNH_ORACLE_PACK")
  else
    (cd "$oracle_project" && ./gradlew --no-daemon build -PgtnhPack="$GTNH_ORACLE_PACK")
  fi
  echo "GTNH calculation oracle build outputs:"
  find "$oracle_project/build/libs" -maxdepth 1 -type f -name '*.jar' -printf '  %f\n' | sort
  runtime_jars=()
  while IFS= read -r jar; do
    runtime_jars+=("$jar")
  done < <(
    find "$oracle_project/build/libs" -maxdepth 1 -type f -name '*.jar' \
      ! -name '*-sources.jar' \
      ! -name '*-dev.jar' \
      ! -name '*-dev-preshadow.jar' \
      ! -name '*-preshadow.jar' \
      | sort
  )
  if (( ${#runtime_jars[@]} != 1 )); then
    echo "GTNH calculation oracle build should leave one runtime jar, found ${#runtime_jars[@]}." >&2
    exit 1
  fi
  oracle_jar="${runtime_jars[0]}"
  echo "GTNH calculation oracle runtime jar ($GTNH_ORACLE_PACK): $(basename "$oracle_jar")"
  if [[ -n "$oracle_cached_jar" ]]; then
    cp "$oracle_jar" "$oracle_cached_jar"
    echo "Cached GTNH calculation oracle jar: $oracle_cached_jar"
  fi
fi
find "$instance_root/mods" -type f \( -iname '*recex*.jar' -o -iname '*recipe*export*.jar' -o -iname '*gtnh*calc*oracle*.jar' \) -print -delete
cp "$oracle_jar" "$instance_root/mods/"

cat > "$instance_root/eula.txt" <<'EOF'
eula=true
EOF
mkdir -p "$rendered_icon_dir"
mkdir -p "$nei_layout_dir"
mkdir -p "$oracle_output_dir"
mkdir -p "$GTNH_ICON_CACHE_DIR"

if [[ -f "$instance_root/server.properties" ]]; then
  sed -i 's/^online-mode=.*/online-mode=false/' "$instance_root/server.properties"
fi

if [[ "$GTNH_EXPORT_DISABLE_CLIENT_UI_MODS" == "true" ]]; then
  disabled_mod_dir="$instance_root/mods/.disabled-for-oracle-export"
  mkdir -p "$disabled_mod_dir"
  while IFS= read -r mod_jar; do
    echo "Disabling client UI/NEI-only mod for oracle export: $(basename "$mod_jar")"
    mv "$mod_jar" "$disabled_mod_dir/"
  done < <(
    find "$instance_root/mods" -maxdepth 1 -type f \
      \( -iname 'visualprospecting-*.jar' \) \
      | sort
  )
fi

export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Dgtnh.oracle.autorun=true -Dgtnh.oracle.outputDir=$oracle_output_dir -Dgtnh.oracle.datasetVersionId=$GTNH_DATASET_VERSION_ID"
if [[ "$GTNH_RENDER_STACK_ICONS" == "true" ]]; then
  export JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS -Dgtnh.oracle.renderIcons=true -Dgtnh.oracle.iconDir=$rendered_icon_dir -Dgtnh.oracle.iconCacheDir=$GTNH_ICON_CACHE_DIR -Dgtnh.oracle.iconSize=$GTNH_ATLAS_ICON_SIZE -Dgtnh.oracle.iconExportBatchSize=$GTNH_ICON_EXPORT_BATCH_SIZE -Dgtnh.oracle.neiLayoutDir=$nei_layout_dir -Djava.awt.headless=false"
fi
export _JAVA_OPTIONS="${_JAVA_OPTIONS:-} -Xms4G -Xmx${GTNH_EXPORT_MAX_MEMORY}"

if [[ "$GTNH_EXPORT_PACK_KIND" == "client" ]]; then
  if [[ -n "$GTNH_CLIENT_RUNTIME_CACHE_DIR" ]]; then
    client_runtime_dir="$GTNH_CLIENT_RUNTIME_CACHE_DIR/${safe_dataset_id}"
  else
    client_runtime_dir="$GTNH_INSTANCE_DIR/client-runtime"
  fi
  launch_script="$(node tools/dataset-pipeline/scripts/prepare-forge-client-launch.mjs "$instance_root" "$client_runtime_dir")"
  bash tools/dataset-pipeline/scripts/install-ae2fc-nei-compat-shim.sh "$instance_root" "$client_runtime_dir" "$GTNH_RAW_EXPORT_DIR"
  if command -v xvfb-run >/dev/null 2>&1 && [[ -z "${DISPLAY:-}" ]]; then
    runtime_command="xvfb-run -a bash '$launch_script'"
  else
    runtime_command="bash '$launch_script'"
  fi
else
  start_script="$(find "$instance_root" -maxdepth 2 -type f \( -iname '*start*server*.sh' -o -iname 'startserver*.sh' -o -iname 'ServerStart*.sh' \) | sort | head -n 1)"

  if [[ -z "$start_script" ]]; then
    echo "No GTNH server start script found in $instance_root" >&2
    exit 1
  fi

  chmod +x "$start_script"
  start_script="$(realpath "$start_script")"
  runtime_command="bash '$start_script'"
fi

runtime_pid=""
tail_pid=""
runtime_attempt=0

start_runtime() {
  runtime_attempt=$((runtime_attempt + 1))
  echo "Starting GTNH runtime attempt $runtime_attempt at $(date -u --iso-8601=seconds)"
  {
    echo ""
    echo "=== GTNH runtime attempt $runtime_attempt started at $(date -u --iso-8601=seconds) ==="
  } >>"$runtime_log"
  setsid bash -lc "cd '$instance_root' && $runtime_command" >>"$runtime_log" 2>&1 &
  runtime_pid=$!
  if (( runtime_attempt == 1 )); then
    tail -n +1 -f "$runtime_log" &
  else
    tail -n 0 -f "$runtime_log" &
  fi
  tail_pid=$!
}

stop_runtime() {
  if [[ -n "${tail_pid:-}" ]]; then
    kill "$tail_pid" 2>/dev/null || true
  fi
  if [[ -n "${runtime_pid:-}" ]]; then
    kill -TERM "-$runtime_pid" 2>/dev/null || true
  fi
  sleep 5
  if [[ -n "${runtime_pid:-}" ]]; then
    kill -KILL "-$runtime_pid" 2>/dev/null || true
  fi
}

restart_runtime_after_failure() {
  local runtime_exit="$1"
  if (( runtime_attempt > GTNH_EXPORT_MAX_RUNTIME_RESTARTS )); then
    return 1
  fi

  if [[ "$runtime_exit" == "137" || "$runtime_exit" == "134" ]] || grep -Eiq 'OutOfMemoryError|Java heap space|GC overhead limit exceeded|unable to create new native thread|Killed process|Killed$' "$runtime_log"; then
    echo "GTNH runtime exited with code $runtime_exit and appears memory-related; restarting runtime ($runtime_attempt/${GTNH_EXPORT_MAX_RUNTIME_RESTARTS} restarts used)."
    stop_runtime
    find "$oracle_output_dir" -type f -name '*.json' -delete 2>/dev/null || true
    raw_oracle_json=""
    start_runtime
    return 0
  fi

  return 1
}

fail_from_runtime_log() {
  local reason="$1"
  echo "$reason" >&2
  echo "Recent GTNH runtime log:" >&2
  tail -n 160 "$runtime_log" >&2 || true
  stop_runtime
  exit 1
}

detect_fatal_runtime_log() {
  [[ "$GTNH_EXPORT_FAIL_FAST_ON_FATAL_LOGS" == "true" ]] || return 1
  [[ -s "$runtime_log" ]] || return 1

  grep -Eq \
    'Fatal errors were detected during the transition|Minecraft ran into a problem! Report saved to:|---- Minecraft Crash Report ----|Caught exception from [A-Za-z0-9_.:-]+' \
    "$runtime_log"
}

raw_oracle_json=""
deadline=$((SECONDS + GTNH_EXPORT_TIMEOUT_SECONDS))
start_runtime

while (( SECONDS < deadline )); do
  if detect_fatal_runtime_log; then
    fail_from_runtime_log "GTNH runtime emitted a fatal Forge/Minecraft crash log before completing the oracle export."
  fi

  # Top level only: machine-data/ below it holds JSON files that are not the export.
  raw_oracle_json="$(find "$oracle_output_dir" -maxdepth 1 -type f -name '*.json' 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -n "$raw_oracle_json" ]]; then
    current_size="$(stat -c%s "$raw_oracle_json")"
    sleep 5
    if detect_fatal_runtime_log; then
      fail_from_runtime_log "GTNH runtime emitted a fatal Forge/Minecraft crash log while waiting for the oracle export to settle."
    fi
    next_size="$(stat -c%s "$raw_oracle_json")"
    if [[ "$current_size" == "$next_size" ]]; then
      if [[ "$GTNH_RENDER_STACK_ICONS" == "true" ]]; then
        echo "Detected stable oracle JSON file; waiting for queued icon batch and client shutdown: $raw_oracle_json"
      else
        echo "Detected completed oracle export: $raw_oracle_json"
        break
      fi
    fi
  fi

  if ! kill -0 "$runtime_pid" 2>/dev/null; then
    set +e
    wait "$runtime_pid"
    runtime_exit=$?
    set -e
    if [[ -n "$raw_oracle_json" && "$runtime_exit" == "0" ]]; then
      echo "GTNH runtime exited after completing oracle export and icon batch."
      break
    fi
    echo "GTNH runtime process exited with code $runtime_exit before producing an oracle export." >&2
    if restart_runtime_after_failure "$runtime_exit"; then
      sleep 5
      continue
    fi
    exit "$runtime_exit"
  fi

  sleep 5
done

stop_runtime

if [[ -z "$raw_oracle_json" ]]; then
  echo "GTNH calculation oracle did not produce a JSON export under $oracle_output_dir" >&2
  exit 1
fi

cp "$raw_oracle_json" "$GTNH_RAW_EXPORT_DIR/oracle-export.json"
# The Tree Growth Simulator, Bacterial Vat and radio hatch side files the oracle writes beside
# its export, for tools/audits/import-machine-side-data.mjs.
rm -rf "$GTNH_RAW_EXPORT_DIR/machine-data"
if [[ -d "$oracle_output_dir/machine-data" ]]; then
  cp -r "$oracle_output_dir/machine-data" "$GTNH_RAW_EXPORT_DIR/machine-data"
  echo "Machine data: $(ls "$GTNH_RAW_EXPORT_DIR/machine-data" | tr '\n' ' ')"
else
  echo "GTNH calculation oracle wrote no machine-data/ under $oracle_output_dir" >&2
fi
echo "Normalizing oracle export into dataset recipes.json"
node tools/dataset-pipeline/scripts/normalize-oracle-export.mjs "$raw_oracle_json" "$GTNH_DATASET_OUT_DIR/recipes.json"
echo "Applying texture icons to normalized dataset"
node tools/dataset-pipeline/scripts/apply-texture-icons.mjs "$instance_root" "$GTNH_DATASET_OUT_DIR/recipes.json" "$GTNH_DATASET_OUT_DIR"
echo "Computing GTNH asset fingerprint"
fingerprint_name="${GTNH_EXPORT_PHASE:-runtime}-asset-fingerprint.json"
node tools/dataset-pipeline/scripts/compute-asset-fingerprint.mjs "$instance_root" "$GTNH_DATASET_OUT_DIR/textures/$fingerprint_name"
echo "Oracle export post-processing completed"
