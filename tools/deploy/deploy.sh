#!/usr/bin/env bash
# Deploys the committed HEAD to a target's Docker stack (docs/deploy.md).
#
#   tools/deploy/deploy.sh <target> [--rollback <tag>] [--measure-peer]
#
# <target> names tools/deploy/targets/<target>.env (gitignored; see
# stage.env.example). The images are built on the server's Docker daemon
# from `git archive HEAD`, so they hold exactly the committed tree and the
# server needs no checkout. Each step says its name; the first failure stops
# the deploy with a non-zero exit, and success means /api/version answered
# this build, never only the same APP_VERSION.
#
#   --rollback <tag>  runs an earlier release's images (they are kept on the
#                     server): the compose and env checks, release.env, the
#                     restarts and the version check. Migrations are additive,
#                     so none is undone.
#   --measure-peer    starts the live service with LIVE_TRUSTED_PROXIES empty
#                     and stops after the restarts, to read the peer address
#                     docker-proxy presents (its untrusted-peer warning).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

target="${1:-}"
shift || true
rollback=""
measure_peer=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) rollback="${2:?--rollback needs a tag}"; shift 2 ;;
    --measure-peer) measure_peer=1; shift ;;
    *) echo "deploy: unknown option $1" >&2; exit 2 ;;
  esac
done
if [ -n "$rollback" ] && ! [[ "$rollback" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{8}$ ]]; then
  echo "deploy: --rollback takes a release tag, <version>-<sha8>." >&2
  exit 2
fi
if [ -z "$target" ]; then
  echo "Usage: tools/deploy/deploy.sh <target> [--rollback <tag>] [--measure-peer]" >&2
  exit 2
fi
target_file="$here/targets/$target.env"
if [ ! -f "$target_file" ]; then
  echo "deploy: no $target_file (copy targets/$target.env.example)" >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$target_file"
: "${DEPLOY_SSH:?DEPLOY_SSH is not set in $target_file}"
: "${DEPLOY_DIR:?DEPLOY_DIR is not set in $target_file}"
: "${DATA_DIR:?DATA_DIR is not set in $target_file}"
: "${SITE_URL:?SITE_URL is not set in $target_file}"
MOD_AND_COMMUNITY="${MOD_AND_COMMUNITY:-}"
SITE_URL="${SITE_URL%/}"

step() { printf '\n== deploy: %s\n' "$*"; }
# Set once release.env names the new tag: a failure after that leaves it
# there, so any later `compose up` would start the release that failed.
release_written=0
previous=""
fail() {
  printf 'deploy: FAILED: %s\n' "$*" >&2
  if [ "$release_written" = 1 ]; then
    printf 'deploy: release.env now names %s, which did not finish.' "$TAG" >&2
    if [ -n "$previous" ]; then
      printf ' Go back with: tools/deploy/deploy.sh %s --rollback %s\n' "$target" "$previous" >&2
    else
      printf ' There is no earlier release to go back to.\n' >&2
    fi
  fi
  exit 1
}
# DEPLOY_SSH=local runs the server side on this machine (the workstation rehearsal).
remote() {
  if [ "$DEPLOY_SSH" = local ]; then bash -c "$*"; else ssh -o BatchMode=yes "$DEPLOY_SSH" "$@"; fi
}
docker_remote() {
  if [ "$DEPLOY_SSH" = local ]; then docker "$@"; else docker -H "ssh://$DEPLOY_SSH" "$@"; fi
}
# Every compose call runs on the server, so the paths resolve there. The
# first argument is a variable assignment for that call's shell, which wins
# over the env files in compose's interpolation: how --measure-peer empties
# one variable without touching .env.
compose_cmd() {
  local prefix="$1"
  shift
  remote "cd '$DEPLOY_DIR' && $prefix docker compose -f '$DEPLOY_DIR/docker-compose.yml' --env-file '$DEPLOY_DIR/.env' --env-file '$DEPLOY_DIR/release.env' $*"
}

wait_healthy() {
  local container="$1" seconds="$2" status=""
  local until=$((SECONDS + seconds))
  while [ "$SECONDS" -lt "$until" ]; do
    status="$(remote "docker inspect -f '{{.State.Health.Status}}' '$container'" 2>/dev/null || true)"
    if [ "$status" = "healthy" ]; then
      echo "$container is healthy"
      return 0
    fi
    sleep 3
  done
  remote "docker logs --tail 40 '$container'" >&2 || true
  fail "$container did not turn healthy within ${seconds}s (last status: ${status:-none})"
}

# --- 1. The tree -------------------------------------------------------------
step "1. the committed tree"
cd "$repo"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail "the tree has uncommitted changes: the images are built from HEAD, so commit or stash them first."
fi
if [ "$(git symbolic-ref --quiet --short HEAD || true)" != "main" ]; then
  fail "HEAD is not the main branch."
fi
git fetch --quiet origin main || fail "could not fetch origin/main."
if ! git merge-base --is-ancestor HEAD origin/main; then
  fail "HEAD is not on origin/main: push it first, so the deployed build is one anyone can check out."
fi

# --- 2. The compose file -----------------------------------------------------
step "2. the server's compose file"
local_compose="$(mktemp)"
server_compose="$(mktemp)"
trap 'rm -f "$local_compose" "$server_compose"' EXIT
git show HEAD:tools/deploy/docker-compose.yml > "$local_compose"
remote "cat '$DEPLOY_DIR/docker-compose.yml'" > "$server_compose" || fail "cannot read $DEPLOY_DIR/docker-compose.yml"
if ! node "$here/deploy-lib.mjs" same "$local_compose" "$server_compose"; then
  fail "the server's docker-compose.yml differs from tools/deploy/docker-compose.yml at HEAD. Update roles/gtnh/files/docker-compose.yml in the infra repo and apply it first."
fi
echo "the same file"

# --- 3. The images -----------------------------------------------------------
if [ -n "$rollback" ]; then
  TAG="$rollback"
  step "3. rollback to $TAG (images kept on the server)"
  for image in site live migrate; do
    remote "docker image inspect 'gtnh-$image:$TAG' >/dev/null" || fail "gtnh-$image:$TAG is not on the server."
  done
else
  TAG="$(node "$here/deploy-lib.mjs" build-id)"
  step "3. build $TAG on the server"
  for image in site live migrate; do
    echo "building gtnh-$image:$TAG"
    git archive HEAD | docker_remote build --quiet --target "$image" \
      --build-arg "NEXT_PUBLIC_SITE_URL=$SITE_URL" \
      --build-arg "NEXT_PUBLIC_MOD_AND_COMMUNITY=$MOD_AND_COMMUNITY" \
      --build-arg "GTNH_BUILD_ID=$TAG" \
      --tag "gtnh-$image:$TAG" - || fail "building gtnh-$image:$TAG"
  done
fi
VERSION="${TAG%-*}"

# --- 4. The environment ------------------------------------------------------
step "4. the server's environment against gtnh-site:$TAG"
label="$(remote "docker image inspect -f '{{index .Config.Labels \"org.gtnh.mod-and-community\"}}' 'gtnh-site:$TAG'")"
built_url="$(remote "docker image inspect -f '{{index .Config.Labels \"org.gtnh.site-url\"}}' 'gtnh-site:$TAG'")"
if [ "$built_url" != "$SITE_URL" ]; then
  fail "gtnh-site:$TAG was built for another site URL than this target's SITE_URL."
fi
remote "docker run --rm --read-only --network none -v '$DEPLOY_DIR/.env:/run/gtnh.env:ro' --entrypoint node 'gtnh-site:$TAG' /app/deploy/check-env.mjs /run/gtnh.env --image-label '$label' --set 'GTNH_TAG=$TAG'" \
  || fail "the environment check refused $DEPLOY_DIR/.env (each problem is named above)."

# --- 5. release.env ----------------------------------------------------------
step "5. release.env"
previous="$(remote "sed -n 's/^GTNH_TAG=//p' '$DEPLOY_DIR/release.env' 2>/dev/null" || true)"
if [ "$previous" = "$TAG" ]; then
  previous="$(remote "sed -n 's/^GTNH_PREVIOUS_TAG=//p' '$DEPLOY_DIR/release.env' 2>/dev/null" || true)"
fi
remote "umask 077 && printf 'GTNH_TAG=%s\nGTNH_PREVIOUS_TAG=%s\n' '$TAG' '$previous' > '$DEPLOY_DIR/release.env.tmp' && mv '$DEPLOY_DIR/release.env.tmp' '$DEPLOY_DIR/release.env'"
release_written=1
echo "GTNH_TAG=$TAG GTNH_PREVIOUS_TAG=${previous:-none}"

# --- 6. Database -------------------------------------------------------------
if [ -z "$rollback" ]; then
  step "6. postgres, postgrest and the migrations"
  compose_cmd "" up -d --wait postgres || fail "postgres did not start healthy."
  compose_cmd "" up -d postgrest || fail "postgrest did not start."
  compose_cmd "" run --rm migrate || fail "the migrations failed (the file is named above)."
fi

# --- 7. Live, then the site --------------------------------------------------
step "7. restart live, then the site"
if [ "$measure_peer" = 1 ]; then
  compose_cmd "LIVE_TRUSTED_PROXIES=" up -d --no-deps live || fail "live did not start."
else
  compose_cmd "" up -d --no-deps live || fail "live did not start."
fi
wait_healthy gtnh-live 120
compose_cmd "" up -d --no-deps site || fail "the site did not start."
wait_healthy gtnh-site 400

if [ "$measure_peer" = 1 ]; then
  step "stopped for the peer measurement"
  echo "live runs with no trusted proxy. On the server:"
  # An upgrade, not /live/nearby: with the mod switch off that answers 404 before reading the address.
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\"
  echo "    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \\"
  echo "    -H 'Origin: $SITE_URL' -H 'X-Client-Ip: 203.0.113.9' http://127.0.0.1:3301/live"
  echo "  docker logs gtnh-live 2>&1 | grep 'untrusted peer'"
  echo "then deploy again without --measure-peer."
  exit 0
fi

# --- 8. From here, over the network ------------------------------------------
step "8. $SITE_URL answers this build"
node "$here/deploy-lib.mjs" wait "$SITE_URL/api/version" "$VERSION" "$TAG" 300 \
  || fail "$SITE_URL/api/version does not name $TAG."
health="$(curl -fsS --max-time 15 "$SITE_URL/live/health" || true)"
case "$health" in
  *'"ok":true'*) echo "live: $health" ;;
  *) fail "$SITE_URL/live/health is not ok: ${health:-no answer}" ;;
esac

# --- 9. Old images -----------------------------------------------------------
step "9. keep the three newest releases of each image"
for image in site live migrate; do
  remote "docker image ls 'gtnh-$image' --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2 | tail -n +4" |
    while read -r old; do
      if [ -n "$old" ] && [ "$old" != "$TAG" ] && [ "$old" != "$previous" ]; then
        # An image a stopped container still uses stays; the deploy has succeeded already.
        if remote "docker image rm 'gtnh-$image:$old'" >/dev/null 2>&1; then
          echo "removed gtnh-$image:$old"
        else
          echo "kept gtnh-$image:$old (still in use)"
        fi
      fi
    done
done

step "done: $TAG is live at $SITE_URL"
