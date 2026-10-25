#!/usr/bin/env bash
# Publishes dataset versions from this checkout's public/datasets/gtnh (the
# pipeline's output) to a target's datasets volume, in the pipeline's order
# (tools/dataset-pipeline/CLAUDE.md):
#
#   tools/deploy/publish-datasets.sh <target> <versionId>...
#
# 1. Textures first, additively, straight into the served tree: never
#    --delete, never a swapped textures/. Their URLs are cached for a year and
#    stored plans name old files.
# 2. Then the data, staged outside the served root and moved in entry by entry.
# 3. The manifest last, so no browser is told of files not yet there.
# 4. Checks on the server, a site restart, and checks over the network.
#
# Only the version directories are written and given modes; the datasets root
# itself is the infra role's, and so are client-files and live-journal. The
# server never holds a raw recipes.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
local_root="$repo/public/datasets/gtnh"

target="${1:-}"
shift || true
if [ -z "$target" ] || [ $# -eq 0 ]; then
  echo "Usage: tools/deploy/publish-datasets.sh <target> <versionId>..." >&2
  exit 2
fi
target_file="$here/targets/$target.env"
[ -f "$target_file" ] || { echo "publish: no $target_file" >&2; exit 2; }
# shellcheck source=/dev/null
. "$target_file"
: "${DEPLOY_SSH:?}" "${DEPLOY_DIR:?}" "${DATA_DIR:?}" "${SITE_URL:?}"
SITE_URL="${SITE_URL%/}"
root="$DATA_DIR/datasets"
staging="$DATA_DIR/datasets-staging"
ids=("$@")
# Directories 755 and files 644 (D755,F644), written symbolically: macOS's
# openrsync takes no octal modes.
modes="Du=rwx,Dgo=rx,Fu=rw,Fgo=r"

step() { printf '\n== publish: %s\n' "$*"; }
fail() { printf 'publish: FAILED: %s\n' "$*" >&2; exit 1; }
# DEPLOY_SSH=local runs the server side on this machine (the workstation rehearsal).
remote() {
  if [ "$DEPLOY_SSH" = local ]; then bash -c "$*"; else ssh -o BatchMode=yes "$DEPLOY_SSH" "$@"; fi
}
dest() {
  if [ "$DEPLOY_SSH" = local ]; then printf '%s' "$1"; else printf '%s:%s' "$DEPLOY_SSH" "$1"; fi
}
# Published names are the pipeline's characters only; anything else would be
# unreachable through the site's gate, and is refused before it is quoted.
for id in "${ids[@]}"; do
  [[ "$id" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]] || fail "\"$id\" is not a dataset version name."
done

# --- 1. What is published ----------------------------------------------------
step "1. the local datasets"
manifest="$local_root/datasets.manifest.json"
[ -f "$manifest" ] || fail "no $manifest"
for id in "${ids[@]}"; do
  [ -f "$local_root/$id/recipe-lookup-index.json.gz" ] || fail "$id has no recipe-lookup-index.json.gz: not a built dataset."
done
listed="$(node -e 'for (const v of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).versions) console.log(v.id)' "$manifest")"
for id in $listed; do
  given=0
  for g in "${ids[@]}"; do [ "$g" = "$id" ] && given=1; done
  if [ "$given" = 0 ] && ! remote "test -f '$root/$id/recipe-lookup-index.json.gz'"; then
    fail "the manifest lists $id, which is neither given nor on the server."
  fi
done
for id in "${ids[@]}"; do
  echo "$listed" | grep -qx "$id" || fail "$id is not in the local manifest."
done
echo "publishing: ${ids[*]}"

remote "umask 022 && test -d '$root' && mkdir -p '$staging'" || fail "$root is missing (the infra role creates it)."

# --- 2. Textures -------------------------------------------------------------
for id in "${ids[@]}"; do
  step "2. textures of $id, additively"
  if [ -d "$local_root/$id/textures" ]; then
    remote "umask 022 && mkdir -p '$root/$id/textures'"
    rsync -a --ignore-existing --chmod="$modes" \
      "$local_root/$id/textures/" "$(dest "$root/$id/textures/")"
  else
    echo "no textures/ in $id"
  fi
done

# --- 3. Data, staged then moved in -------------------------------------------
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for id in "${ids[@]}"; do
  step "3. data of $id"
  # The staging copy starts from what is served, so only changed bytes travel.
  remote "umask 022 && rm -rf '$staging/$id' && mkdir -p '$staging/$id' && if [ -d '$root/$id' ]; then rsync -a --exclude textures/ --exclude recipes.json '$root/$id/' '$staging/$id/'; fi"
  rsync -a --delete --chmod="$modes" --exclude recipes.json --exclude textures/ \
    "$local_root/$id/" "$(dest "$staging/$id/")"
  # Each staged entry replaces the served one; the old one is set aside
  # outside the root first, so the served name is never half written.
  remote "set -e; umask 022; mkdir -p '$root/$id'; old='$staging/.old-$id-$stamp'; mkdir -p \"\$old\";
    for entry in '$staging/$id'/* '$staging/$id'/.[!.]*; do
      [ -e \"\$entry\" ] || continue
      name=\"\$(basename \"\$entry\")\"
      [ \"\$name\" = textures ] && continue
      if [ -e '$root/$id/'\"\$name\" ]; then mv '$root/$id/'\"\$name\" \"\$old/\$name\"; fi
      mv \"\$entry\" '$root/$id/'\"\$name\"
    done
    rmdir '$staging/$id' 2>/dev/null || true"
done

# --- 4. The manifest, last ---------------------------------------------------
step "4. the manifest"
rsync -a --chmod=Fu=rw,Fgo=r "$manifest" "$(dest "$staging/datasets.manifest.json")"
remote "mv '$staging/datasets.manifest.json' '$root/datasets.manifest.json'"

# --- 5. On the server --------------------------------------------------------
step "5. checks on the server"
raw="$(remote "find '$root' -name recipes.json")"
[ -z "$raw" ] || fail "a raw recipes.json is on the server: $raw"
stray="$(remote "find '$root' \\( -name '.tmp*' -o -name '.old-*' -o -name '.pre-*' \\)")"
[ -z "$stray" ] || fail "leftovers under $root: $stray"
for id in "${ids[@]}"; do
  local_sums="$(cd "$local_root/$id" && find . -name '*.gz' -not -path './textures/*' -type f | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done)"
  server_sums="$(remote "cd '$root/$id' && find . -name '*.gz' -not -path './textures/*' -type f | LC_ALL=C sort | while read -r f; do printf '%s  %s\\n' \"\$(sha256sum \"\$f\" | cut -d' ' -f1)\" \"\$f\"; done")"
  [ "$local_sums" = "$server_sums" ] || fail "the published gzips of $id differ from the local ones."
  echo "$id: $(echo "$local_sums" | wc -l | tr -d ' ') gzips match"
done
remote "rm -rf '$staging'/.old-*-'$stamp'"

# --- 6. Restart and over the network -----------------------------------------
step "6. restart the site and check what it serves"
before="$(curl -fsS --max-time 15 "$SITE_URL/api/version")" || fail "$SITE_URL/api/version does not answer."
version="$(node -e 'console.log(JSON.parse(process.argv[1]).version)' "$before")"
build="$(node -e 'console.log(JSON.parse(process.argv[1]).build)' "$before")"
remote "cd '$DEPLOY_DIR' && docker compose -f '$DEPLOY_DIR/docker-compose.yml' --env-file '$DEPLOY_DIR/.env' --env-file '$DEPLOY_DIR/release.env' restart site"
node "$here/deploy-lib.mjs" wait "$SITE_URL/api/version" "$version" "$build" 400 || fail "the site did not come back."
served="$(mktemp)"
trap 'rm -f "$served"' EXIT
curl -fsS --max-time 30 "$SITE_URL/datasets/gtnh/datasets.manifest.json" -o "$served" || fail "the manifest is not served."
node "$here/deploy-lib.mjs" same "$served" "$manifest" || fail "the served manifest differs from the local one."
echo "manifest: the local file"
for id in "${ids[@]}"; do
  texture="$(cd "$local_root/$id/textures/rendered" 2>/dev/null && find . -name '*.png' -type f -print -quit | sed 's|^\./||')"
  if [ -n "$texture" ]; then
    headers="$(curl -fsS --max-time 30 -o /dev/null -D - "$SITE_URL/datasets/gtnh/$id/textures/rendered/$texture")" || fail "$id texture $texture is not served."
    echo "$headers" | grep -qi '^cache-control:.*immutable' || fail "$id texture is not served immutable."
    echo "$id: texture served immutable"
  fi
  status="$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' "$SITE_URL/datasets/gtnh/$id/recipes.json")"
  [ "$status" != 200 ] || fail "$SITE_URL/datasets/gtnh/$id/recipes.json answers 200."
  echo "$id: recipes.json answers $status"
done
step "done: ${ids[*]} published to $SITE_URL"
