# Deploying GTNH Planner

The site, the live service, Postgres and PostgREST run as one Docker compose project, `gtnh`, on the owner's
server tungsten, behind the host's Caddy. The app repo builds the images and deploys them
(`tools/deploy/`); the server side (directories, the `.env`, the Caddy vhost, firewall lines, backups) is the
infra repo's `gtnh` role, applied by the owner. Deploy only when the owner says so, once per instruction.

## Targets

| Target | URL | Reach | Mod and community |
|---|---|---|---|
| `stage` | https://stage.gtnhplanner.idebugger.net | ZeroTier only (Caddy binds the ZeroTier address, answers 403 to any non-private peer) | off |

A target is `tools/deploy/targets/<name>.env` on the deploying Mac (gitignored; `stage.env.example` names
the fields): `DEPLOY_SSH`, `DEPLOY_DIR` (`/opt/gtnh`), `DATA_DIR` (`/srv/gtnh`), `SITE_URL`, `MOD_AND_COMMUNITY`.
`SITE_URL` and `MOD_AND_COMMUNITY` are build values, so each public host is its own build and its own target.
The public site behind Cloudflare is a later step (below).

## What runs

`tools/deploy/docker-compose.yml` is the source of truth. The infra role ships a byte copy as
`/opt/gtnh/docker-compose.yml`, and the deploy refuses to run while the two differ: a compose change ships as an
infra commit first.

| Service | Image | Network | Port | Volumes | Memory |
|---|---|---|---|---|---|
| `postgres` (`gtnh-postgres`) | postgres 17, pinned by digest, as `5432:5432` | backend | none | `/srv/gtnh/postgres` (owned `5432:5432`, 0700) | 2 GB |
| `migrate` (one-shot, profile `tools`) | `gtnh-migrate:<tag>` | backend | none | none | |
| `postgrest` (`gtnh-postgrest`) | PostgREST v13, pinned by digest | backend | none | none | 256 MB |
| `site` (`gtnh-site`) | `gtnh-site:<tag>` | edge, backend | `127.0.0.1:3300` | datasets (read-only), `files`, `client-files` | 4 GB |
| `live` (`gtnh-live`) | `gtnh-live:<tag>` | edge, backend | `127.0.0.1:3301` | `live-journal` | 600 MB |

- Networks: `edge` is a bridge on `172.30.61.0/24` (gateway `172.30.61.1`), the only one with a way out;
  `backend` is internal on `172.30.62.0/24`. The subnets are fixed because
  the firewall and `LIVE_TRUSTED_PROXIES` name them.
- Only site and live publish ports, on loopback; nothing binds a public or ZeroTier address. The site trusts
  `X-Client-Ip` from any peer (`src/lib/server/client-address.ts`), which is safe only because Caddy and the
  stack's own containers are its only peers. Besides the loopback port, the site container answers on its edge
  address (`172.30.61.x:3000`) to host processes and to the live container; remote hosts are kept off it only by
  Docker's direct-routing guard and the firewall.
- Memory: the site's heap is capped at 3 GB (`NODE_OPTIONS` in the image) under a 4 GB limit, with both dataset
  versions prewarmed (about 1.4 to 2.1 GB resident). Live holds about four times `LIVE_MAX_PLAN_BYTES` (64 MB)
  plus 150 MB; its heap is 480 MB under 600 MB.
- One site container and one live service, never replicas: the rate limits serialise in process, and one live
  service owns each database's leases.
- Every container runs under `init: true` (tini, which hands SIGTERM to the site's `server.js` and to live; the
  site image also sets `TINI_KILL_PROCESS_GROUP=1`), `no-new-privileges`, no capabilities (`cap_drop: ALL`), `restart: unless-stopped`, json-file logs of
  3 x 10 MB. Every container's root filesystem is read-only: site and live with tmpfs `/tmp` (and the site's
  `.next/cache`), postgres with tmpfs `/tmp` and its socket directory. Site and live run as uid 1000 over
  root-owned files. PostgREST's admin server is off (nothing reads it, and every backend container could). The
  site keeps revalidated pages (the sitemap, llms.txt) in memory (`isrFlushToDisk: false`), since its `.next` is
  read-only. The site stops within its 20 s grace; live within 30 s, storing every open plan and releasing
  its leases on SIGTERM.
- The images run `npm ci` with their own npm (11.19), which needs lockfile entries an older npm leaves out (the
  `@emnapi` packages): a lockfile an older npm rewrote fails the image build. Regenerate it with the image's npm:
  `docker run --rm -v "$PWD":/w -w /w <the Dockerfile's NODE_IMAGE> npm install --package-lock-only --ignore-scripts`.
- The site and live never chmod or chown their volumes: the infra role creates `files`, `client-files` and
  `live-journal` as `idebugger` (uid 1000, the containers' `node`), mode 0700. `client-files` starts empty; the site
  claims only an empty directory or its own.

## Environment

One `/opt/gtnh/.env` (0600, rendered by the infra role from 1Password vault `Infra`, item `gtnh`) feeds every
service, so the salt and the internal token are the same on site and live by construction.
`/opt/gtnh/release.env` (`GTNH_TAG`, `GTNH_PREVIOUS_TAG`) is the deploy's. Every compose call passes both:
`--env-file .env --env-file release.env`. `tools/deploy/env.example` lists every name with its 1Password field
and how to make it.

| Variable | Who | When | Value |
|---|---|---|---|
| `POSTGRES_PASSWORD` | postgres, migrate | run | `openssl rand -hex 32` |
| `POSTGREST_AUTHENTICATOR_PASSWORD` | migrate, postgrest | run | `openssl rand -hex 32` |
| `POSTGREST_JWT_SECRET` | postgrest | run | `openssl rand -hex 32` (at least 32 characters) |
| `POSTGREST_SERVICE_TOKEN` | site, live | run | `printf %s "$POSTGREST_JWT_SECRET" \| node tools/deploy/service-token.mjs` |
| `POSTGREST_URL` | site, live | run | `http://postgrest:3000` (set by compose) |
| `COMMUNITY_HASH_SALT` | site, live | run | `openssl rand -hex 32`; changing it signs everyone out |
| `LIVE_INTERNAL_TOKEN` | site, live | run | `openssl rand -hex 32` |
| `LIVE_INTERNAL_URL` | site | run | `http://live:3001` (set by compose) |
| `LIVE_ALLOWED_ORIGINS` | live | run | the site's https origin |
| `LIVE_TRUSTED_PROXIES` | live | run | `172.30.61.1`, the edge gateway (measured, below) |
| `LIVE_MAX_PLAN_BYTES`, `LIVE_MAX_ROOMS` | live | run | optional, 64 MB and 500 |
| `COMMUNITY_ADMIN_TOKEN` | site | run | optional; deletes any community post |
| `GTNH_PREWARM_FULL_DATASETS` | site | run | optional |
| `NEXT_PUBLIC_MOD_AND_COMMUNITY` | site, live | build and run | empty on stage; the two must be equal |
| `NEXT_PUBLIC_SITE_URL` | site | build | the target's `SITE_URL` |
| `NEXT_PUBLIC_LIVE_URL` | site | build | `/live` (the image's default) |
| `NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL` | site | build | `/datasets/gtnh/datasets.manifest.json` (default) |
| `GTNH_BUILD_ID` | site, live, migrate | build | `<version>-<sha8>`, the image tag |
| `GTNH_TAG`, `GTNH_PREVIOUS_TAG` | compose | run | `release.env` |

The images set the rest: `NODE_ENV=production`, `PORT`, `GTNH_PREWARM_ON_STARTUP=1`, `FILE_STORE_DIR=/data/files`,
`GTNH_CLIENT_FILES_DIR=/data/client-files`, `LIVE_HOST=0.0.0.0`, `LIVE_PORT=3001`,
`LIVE_JOURNAL_DIR=/data/live-journal`. Never set: `LOCAL_DB` (with `NODE_ENV=production` neither process
starts), `NODE_ENV` in `.env`, and the old `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (unread; the site warns).

The image carries its build values as labels: `org.gtnh.build`, `org.gtnh.mod-and-community`,
`org.gtnh.site-url`. `tools/deploy/check-env.mjs` refuses a missing or short secret, a service token PostgREST
would not accept, `LOCAL_DB` or `NODE_ENV`, a mod-and-community value that differs from the image's label (every
mod and community route would stay 404), a non-https live origin, and a trusted proxy subnet wider than /24. It
names the variable, never the value.

## Server side (infra repo)

Every server change goes through `iDeBugger/infra`, applied by the owner with `/opt/infra/bin/apply.sh`. No script
here uses sudo or edits a file the role manages.

- `roles/gtnh/tasks/main.yml`, `defaults/main.yml`: `/opt/gtnh` (compose and the 0600 `.env`), `/srv/gtnh` and
  its children (`datasets` 0755, `datasets-staging`, `files`, `client-files`, `live-journal`, `backups`, all
  `idebugger`; `postgres` owned `5432:5432`, 0700). No `compose up`: the first start is a deploy. A running-stack
  assert once `release.env` exists.
- `roles/gtnh/files/docker-compose.yml`: the byte copy of `tools/deploy/docker-compose.yml` (the role also asserts
  the postgres `user: "5432:5432"` line). `roles/gtnh/templates/dotenv.j2`: the `.env`.
- `roles/caddy/templates/Caddyfile.j2`, the `stage.gtnhplanner.idebugger.net` block, in this order:
  - `bind` the ZeroTier address; TLS by DNS-01 through the Cloudflare plugin.
  - `handle @outside` answers 403 to any peer outside the private ranges.
  - `handle @prewarm` answers 404 to `/api/datasets/<id>/prewarm`: nobody outside needs the readiness wait.
  - `/live` and `/live/*` only go to `127.0.0.1:3301`, so the live service's `/internal/*` stays unreachable,
    with `X-Client-Ip {client_ip}` set and `CF-Connecting-IP` dropped. No body limit or body timeout on this
    route: a read timeout on an upgraded socket would cut a live session.
  - Everything else goes to `127.0.0.1:3300` with the same headers, `request_body max_size 8MB` for every request
    (the largest legitimate body is a 4 MB image or plan upload) and a 30 s body read timeout for
    POST, PUT and PATCH only (the app cannot stop Next waiting for a slow body's end), and `lb_try_duration 30s`
    to hold requests while the site restarts.
  - The Host header is passed through unchanged: the site's same-origin check compares Origin with Host.
  - JSON log in `/var/log/caddy/gtnh-stage.log`.
- `roles/firewall/templates/tungsten/rules.v4.j2`: drops traffic to `127.0.0.1:3300` and `:3301` arriving on
  any interface but `lo` (the loopback guard), and keeps the edge and backend subnets away from the host, the
  LAN and ZeroTier while internet egress stays. Applying a firewall change restarts Docker, and with it the whole
  stack: live sockets drop and reconnect, and the site prewarms again.
- Caddy's `stream_close_delay 5m` keeps upgraded live sockets open across a Caddy reload, so a vhost change
  does not cut live sessions.
- `roles/backup/files/server-backup`: a `pg_dump -Fc` of `gtnh-postgres` into `/srv/gtnh/backups/gtnh.dump`
  before restic, and `/opt/gtnh`, `/srv/gtnh/backups`, `/srv/gtnh/files` in the backup. Not backed up: the
  Postgres directory (the dump is the backup), the datasets (republished from the Mac), client files (the site
  rewrites them), the live journal (flushed at every stop). Restore steps are in the infra repo's `BOOTSTRAP.md`.

## Deploy

```bash
tools/deploy/deploy.sh stage
```

Each step prints its name and, when it ends, its time; the first failure stops the deploy with a non-zero exit and
says which check failed. The site's restart prints how long it took to turn healthy, which is how long the site is
down (below).

1. The tree: no uncommitted tracked change, the `main` branch, HEAD on `origin/main` (push first).
2. The server's `/opt/gtnh/docker-compose.yml` is the same bytes as `tools/deploy/docker-compose.yml` at HEAD.
3. `TAG=<APP_VERSION>-<sha8>`; the site, live and migrate images are built on the server's Docker daemon
   (`docker -H ssh://... buildx bake`, `tools/deploy/docker-bake.hcl`) from `git archive HEAD`, with the target's
   build values and `GTNH_BUILD_ID=$TAG`. The images hold exactly the committed tree; the server needs no checkout.
   One bake builds all three, so the context goes over once and the site and live share one build (Build cache,
   below). The build's log is printed only on a failure. The server's Docker needs the buildx plugin
   (`docker buildx version`), which Docker's own packages install with the engine.
4. The env check runs in a one-off `gtnh-site:$TAG` container against `/opt/gtnh/.env`, with the image's
   mod-and-community label; the image's site URL must be the target's.
5. `release.env` gets `GTNH_TAG=$TAG` and the previous tag (0600, written through a temp file).
6. postgres (waited healthy), postgrest, then `docker compose run --rm migrate`.
7. live, waited healthy; then the site, waited healthy (its restart costs the prewarm, which Caddy's
   `lb_try_duration` covers).
8. From the Mac: `/api/version` answers this version AND this build (`build` field) within 300 s, and
   `/live/health` is ok. A build that failed, a container that never turned healthy, or an old build answering
   under the same `APP_VERSION` is a failure, never a success.
9. The three newest tags of each image are kept, older ones removed (one still used by a stopped container
   stays, with a note).

### Build cache

The Dockerfile is laid out so a deploy rebuilds and rewrites only what its commit changed:

- `.dockerignore` keeps docs, notes (`*.md`), test files (`*.test.*`, `src/test-support`), the solver's test corpus
  (`src/lib/solver/plan/__fixtures__/corpus`; the other fixtures stay, `/dev/clean-card` imports one), `tools/` (but
  the prebuild step, the env check, the service token, `live-deps.mjs` and `tools/deploy/db`), the Dockerfile and
  the bake file out of the context: they are neither sent nor hashed. `next build` still runs on every deploy, as
  the build id is baked into the bundles, but from its cache (next bullet). Tailwind scans the same files in a
  checkout (`@source` in `src/app/globals.css`), so a checkout's build and the image's have the same CSS.
- `npm ci` depends on `package.json` and `package-lock.json` alone, with npm's download cache in a BuildKit cache
  mount (`gtnh-npm`): a deploy with the same lockfile reuses the install.
- `next build` keeps `.next/cache` (Turbopack's cache and the type check's state) in a cache mount
  (`gtnh-next-cache`), so it compiles only what changed.
- The site image is Next's standalone output (`output: "standalone"` in `next.config.ts`): `server.js`, the traced
  server files and only the packages they load (about 60 MB, against the 470 MB the whole run-time install was),
  then `.next/static`, `public/` and the card route's fonts. The config is serialized into `server.js` at build;
  nothing reads `next.config.ts` at run time. The layers that rarely change (packages, public files, fonts) come
  first, so a deploy that leaves them alone reuses them.
- The live image holds `dist-live/` and only the packages it can load: the ones its bundle leaves external
  (esbuild's metafile names them) and their whole run-time closure from `package-lock.json`, dependencies, optional
  dependencies and peers, however late each is loaded (`tools/deploy/live-deps.mjs`, the `live-deps` stage). The
  layer changes only with the lockfile or the bundle's imports. As a smoke test, the build then imports every
  package the bundle imports.
- Nothing is pruned at build: the old `npm prune --omit=dev` after `next build` ran on every deploy.

The cache lives in the server's BuildKit store, bounded only by dockerd's builder garbage collection; step 9 removes
old image tags, not build cache. Watch it with `docker buildx du` (the two cache mounts are a few hundred MB; the
rest is old layers). To trim it, `docker builder prune --filter until=168h` drops what no build used for a week and
keeps what the last deploys share; after a week without a deploy that includes the two cache mounts, and the next
deploy builds cold. A full `docker builder prune` always empties them. Either way the next deploy is correct, only
slower.

### Downtime

The site and live run one container each, with fixed names and fixed loopback ports (`127.0.0.1:3300`, `:3301`) that
the firewall and Caddy name. `compose up -d site` stops the old container (it finishes its open requests and exits
143) and starts the new one, which answers once the default dataset is prewarmed. Caddy's `lb_try_duration 30s` holds
requests over that gap; a request that waits longer gets a 502. Running the new container beside the old one would
need a second port or name and a Caddy upstream switch, which this layout does not have.

A failure after step 5 leaves `release.env` naming the release that failed, so a later `compose up` would start
it; the script then prints the rollback to the previous release (`deploy.sh <target> --rollback <previous>`).

`tools/deploy/deploy.sh stage --rollback <tag>` reruns steps 2, 4, 5, 7 and 8 with an earlier tag's images.
Migrations are additive, so none is undone. `--measure-peer` starts live with `LIVE_TRUSTED_PROXIES` empty and
stops after step 7, for the peer measurement below.

`APP_VERSION` and the changelog follow AGENTS.md: stage deploys need no bump (the build id is the deploy marker);
the bump-and-changelog rule applies to the public release.

### The live service's trusted proxy

Caddy reaches the live container through docker-proxy, whose peer is the `edge` network's gateway, not loopback.
With `LIVE_TRUSTED_PROXIES` unset or wrong, every player shares that address and the per-address limits (60
upgrades a minute, `/live/nearby`) refuse everyone at once. To measure it: `deploy.sh stage --measure-peer`, then on
the server send an upgrade with `X-Client-Ip` (the script prints the curl; `/live/nearby` answers 404 before
reading the address while the mod switch is off) and `docker logs gtnh-live 2>&1 | grep 'untrusted peer'`. On
OrbStack and with Docker's default userland proxy it is `172.30.61.1`. A different address goes into the infra
role's `gtnh_trusted_proxies` and here.

## Migrations

`supabase/schema.sql` and every file in `supabase/migrations/` are additive and idempotent, and the migrate image
applies all of them on every deploy (`tools/deploy/db/migrate.sh`): `db/roles.sql` (`service_role` nologin
bypassrls, `authenticator` login noinherit with the configured password), `schema.sql`, the migrations in name
order, `db/grants.sql` (everything in `public` to `service_role`, also by default), then
`notify pgrst, 'reload schema'`. The authenticator's password reaches psql through the environment
(`\getenv` in `roles.sql`), never its command line, which shows in the host's process list. Row security stays on with no policies; there is no anon role, so a request
without the token is 401. A new migration must survive a second run, as the local database also loads every file
on every open.

## Datasets

```bash
tools/deploy/publish-datasets.sh stage local-2.9.0-rc-2 local-2.8.1
```

From this checkout's `public/datasets/gtnh` (the pipeline's output) into `/srv/gtnh/datasets`, in the pipeline's
order (`tools/dataset-pipeline/CLAUDE.md`):

1. Refuses a version without `recipe-lookup-index.json.gz`, or a manifest listing a version that is neither given
   nor on the server.
2. Textures first, additively, straight into the served tree: `rsync -a --ignore-existing`, never `--delete`, never
   a swapped `textures/`. Texture URLs are cached for a year and saved plans name old files.
3. The data, staged in `/srv/gtnh/datasets-staging` (outside the served root, starting from the served copy so only
   changes travel), then moved in entry by entry, each old entry set aside first. Never `recipes.json`.
4. The manifest last, through staging and `mv`.
5. On the server: no `recipes.json`, no `.tmp`, `.old-*` or `.pre-*` under the root, every published gzip's sha256
   equal to the local one.
6. A site restart, the build check again, then over the network: the served manifest is the local file, a rendered
   texture per version is 200 and `immutable`, `recipes.json` is not 200.

Only the version directories are written, with modes 755 for directories and 644 for files (rsync's `--chmod`,
written symbolically for macOS's openrsync; step 5 checks the modes the server's rsync applied); the datasets root
itself is the infra role's.

## Rehearsal on a workstation

`tools/deploy/compose.rehearsal.yml` runs the real compose file on OrbStack or Docker Desktop with its volumes
under `scratch/rehearsal/`, the site and live on `127.0.0.1:3480` and `:3481`, and PostgREST on `:3482`:

1. Build the three images from HEAD as the deploy does: in a directory holding `git archive HEAD`,
   `TAG=<tag> SITE_URL=http://127.0.0.1:3480 docker buildx bake -f tools/deploy/docker-bake.hcl`.
2. `scratch/rehearsal/.env` from `env.example` with real random values, `LIVE_ALLOWED_ORIGINS=http://127.0.0.1:3480`;
   `release.env` with `GTNH_TAG=<tag>`; `scratch/rehearsal/postgres` owned `5432:5432` (a non-root postgres cannot
   chown its directory, so a root-owned bind mount or named volume fails its initdb).
3. `docker compose -f tools/deploy/docker-compose.yml -f tools/deploy/compose.rehearsal.yml --env-file
   scratch/rehearsal/.env --env-file scratch/rehearsal/release.env ...`: `up -d --wait postgres`, `run --rm migrate`
   (twice: the same output, no error), `up -d postgrest live site`.
4. `REAL_POSTGREST_URL=http://127.0.0.1:3482 REAL_POSTGREST_TOKEN=<service token> npx vitest run
   src/lib/server/local-db/postgrest-real.local.test.ts --config vitest.local.config.ts`.
5. `check-env.mjs ... --rehearsal` accepts the http origin. A target file with `DEPLOY_SSH=local` runs
   `publish-datasets.sh` against `scratch/rehearsal`.
6. `node tools/deploy/smoke.mjs --base http://127.0.0.1:3480 --live http://127.0.0.1:3481`.
7. `docker compose ... --profile tools down`, then remove `scratch/rehearsal`.

## Smoke test

`node tools/deploy/smoke.mjs --base https://stage.gtnhplanner.idebugger.net --caddy` checks the version and build,
live health, headers (nosniff, HSTS over https, the image optimizer off), the dataset gate, the live service's
internal routes kept off the site, board image uploads (a URL on this site, served `image/png`, nosniff, immutable;
a text file 415; a 9 MB body 413 at the edge), the mod-and-community switch, two throwaway accounts (a design saved
by one session read by another; a foreign Origin 403) and a headless browser pass (Welcome, a new design, a recipe
card, `highs.wasm`, a 2.8.1 plan asking the 2.8.1 dataset, no page errors). Live editing end to end is
`tools/live/test-client.mjs --base <site>`: register, create, share, `join --for 150`, send, unshare.

## Diagnose

On the server, in `/opt/gtnh`:

```bash
docker compose --env-file .env --env-file release.env ps
docker compose --env-file .env --env-file release.env logs --tail 200 site    # or live, postgres, postgrest
docker logs gtnh-site 2>&1 | grep 'neither X-Client-Ip nor CF-Connecting-IP'    # requests without Caddy's header
docker logs gtnh-live 2>&1 | grep 'untrusted peer'       # LIVE_TRUSTED_PROXIES misses the proxy
```

Caddy's JSON log for the vhost is `/var/log/caddy/gtnh-stage.log`. A slow first API call after a start means the
prewarm or the deploy regressed; the site's healthcheck allows 180 s before counting failures.

## Cloudflare later

Not done yet; for the public site:

- Domain: whether `gtnhplanner.com` moves to tungsten; its zone, a proxied record, Universal SSL (one level deep,
  so a two-level name needs Advanced Certificate Manager).
- Reaching the origin: a public `bind` with 443 open only to Cloudflare's ranges, or a Cloudflare Tunnel. Either
  way Caddy's global `servers { trusted_proxies static <Cloudflare ranges>; client_ip_headers CF-Connecting-IP }`,
  keep `header_up X-Client-Ip {client_ip}`, and stop dropping `CF-Connecting-IP`. With a tunnel the live service's
  trusted proxy is unchanged (Caddy still reaches it through docker-proxy).
- Cloudflare settings: WebSockets on (clients ping every 25 s against the 100 s idle cut), Always Use HTTPS, HSTS
  six months without includeSubDomains, a rate limit on `/api/datasets/` (600 a minute per address, block 10
  minutes), a WAF rule on query length over 2048.
- `LIVE_ALLOWED_ORIGINS` gains the public origin; the public site is its own build and target.
- Board image reads (`GET /api/community/images/...`, up to 4 MB from disk each) spend one unit of the address's
  dataset budget; floods from many addresses need Cloudflare's cache (the answers are `immutable`) or a rate rule.
- Moving the public site off the hosted Supabase project is a data step: dump and restore the community tables,
  copy the `plan-previews` objects into the file store (the code no longer reads Supabase
  Storage), and accept that stored plans' board images keep their `supabase.co` URLs while that bucket exists.
