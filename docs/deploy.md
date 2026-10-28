# Deploying GTNH Planner

The site, the live service and Postgres run as one Docker compose project, `gtnh`, on the owner's
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
| `site` (`gtnh-site`) | `gtnh-site:<tag>` | edge, backend | `127.0.0.1:3300` | datasets (read-only), `files`, `client-files` | 4 GB |
| `live` (`gtnh-live`) | `gtnh-live:<tag>` | edge, backend | `127.0.0.1:3301` | `live-journal` | 600 MB |

- Networks: `edge` is a bridge on `172.30.61.0/24` (gateway `172.30.61.1`), the only one with a way out;
  `backend` is internal on `172.30.62.0/24`. The subnets are fixed because
  the firewall and `LIVE_TRUSTED_PROXIES` name them.
- The site and live reach Postgres over `backend` directly (Kysely over `pg`), each as its own login role:
  `gtnh_site` and `gtnh_live`, with the rights `db/grants.sql` gives (Migrations, below). `DATABASE_URL` is built in
  compose from the role's password, so `.env` holds passwords only. Postgres publishes no port; only the migrate
  run and the backup use the superuser.
- Only site and live publish ports, on loopback; nothing binds a public or ZeroTier address. The site trusts
  `X-Client-Ip` from any peer (`src/lib/server/http/client-address.ts`), which is safe only because Caddy and the
  stack's own containers are its only peers. Besides the loopback port, the site container answers on its edge
  address (`172.30.61.x:3000`) to host processes and to the live container; remote hosts are kept off it only by
  Docker's direct-routing guard and the firewall.
- Memory: the site's heap is capped at 3 GB (`NODE_OPTIONS` in the image) under a 4 GB limit, with both dataset
  versions prewarmed (about 1.4 to 2.1 GB resident). Live holds about four times `LIVE_MAX_PLAN_BYTES` (64 MB)
  plus 150 MB; its heap is 480 MB under 600 MB.
- One site container and one live service, never replicas: the rate limits serialise in process, and one live
  service owns each database's leases.
- Every container runs under `init: true` (tini, which hands SIGTERM to the site's `dist/server/server.mjs` and to
  live; the site image also sets `TINI_KILL_PROCESS_GROUP=1`), `no-new-privileges`, no capabilities
  (`cap_drop: ALL`), `restart: unless-stopped`, json-file logs of 3 x 10 MB. Every container's root filesystem is
  read-only: site and live with tmpfs `/tmp`, postgres with tmpfs `/tmp` and its socket directory. The site writes
  nothing in its image: the sitemap and llms.txt are held in memory for an hour, and the `.next/cache` tmpfs
  compose still mounts is left empty. Site and live run as uid 1000 over root-owned files.
- On SIGTERM the site stops taking connections, closes its idle keep-alive connections, lets open requests finish
  and releases the database pool (at most 2 s), then exits 143. Every answer whose head goes out after the stop
  began closes its connection and says `Connection: close`, so Caddy never reuses a socket about to close; when
  the request's body is still arriving, the site reads the rest within its drain bounds before it closes, so
  the answer is not lost to a reset. After 15 s it closes every connection still open. A SIGTERM during the
  prewarm waits for the prewarm's current step first: the worst stop measured was 19.3 s. Live stops within
  30 s, storing every open plan and releasing its leases.
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
| `POSTGRES_PASSWORD` | postgres, migrate | run | `openssl rand -hex 32`; the superuser, for the migrate run and the backup |
| `GTNH_SITE_DB_PASSWORD` | migrate, site | run | `openssl rand -hex 32`; the `gtnh_site` login (1Password `site-db-password`) |
| `GTNH_LIVE_DB_PASSWORD` | migrate, live | run | `openssl rand -hex 32`; the `gtnh_live` login (1Password `live-db-password`) |
| `DATABASE_URL` | site, live | run | `postgres://gtnh_site:<password>@postgres:5432/postgres` (live: `gtnh_live`), set by compose |
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
`LIVE_JOURNAL_DIR=/data/live-journal`. Never set: `LOCAL_DB` and `NODE_ENV` in `.env` (the env check refuses
both), a variable of the old REST layer (the env check refuses each by name), and the old `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` (unread; the site warns).

The image carries its build values as labels: `org.gtnh.build`, `org.gtnh.mod-and-community`,
`org.gtnh.site-url`. `tools/deploy/check-env.mjs` refuses a missing or short secret (the two role passwords
included, at least 32 characters), a password a connection URI would break on, a leftover variable of the old REST
layer, `LOCAL_DB` or `NODE_ENV`, a mod-and-community value
that differs from the image's label (every mod and community route would stay 404), a non-https live origin, and
a trusted proxy subnet wider than /24. It names the variable, never the value.

The image also holds its build record, `dist/client/build.json`: the switch, the build id and the site, live and
manifest URLs the client was built with, an unset one as `null`. The server build takes every one of them from it and
fails on a different value in its env, so the page and the server are always built alike. The env check, run in the
image, reads it too and refuses a label that disagrees with it, a `.env` switch other than the built one, a
`GTNH_TAG` that is not its build id, and a `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_LIVE_URL` or
`NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL` in `.env` that differs from the built value (the site serves the built one).
So a mismatched deploy stops at step 4, before the old container is replaced.

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
  - Everything else goes to `127.0.0.1:3300` with the same headers, `encode zstd gzip` (the site never compresses;
    an answer that already has a `Content-Encoding`, such as a client file served br or gzip, is left alone),
    `request_body max_size 8MB` for every request (the largest legitimate body is a 4 MB image or plan upload), a
    30 s body read timeout for POST, PUT and PATCH only, and `lb_try_duration 30s` to hold requests while the site
    restarts. On a body over a route's cap the site answers the 413 at once, then reads and discards the rest up to
    its drain bound (the 4.5 MiB hard cap, `PROXY_BODY_MAX_BYTES`, plus 4 MiB; 31 s without a byte, 35 s in all; both timers above Caddy's 30 s, so
    Caddy fires first and a stalled upload still gets the 413 rather than a 502) and closes. It stops reading at
    that bound, not at the route's cap, and an answer past the byte bound may be lost; Caddy's 8 MB limit and its
    30 s body timeout stay the outer bounds.
  - The Host header is passed through unchanged: the site's same-origin check compares Origin with Host.
  - JSON log in `/var/log/caddy/gtnh-stage.log`.
- `roles/firewall/templates/tungsten/rules.v4.j2`: drops traffic to `127.0.0.1:3300` and `:3301` arriving on
  any interface but `lo` (the loopback guard), and keeps the edge and backend subnets away from the host, the
  LAN and ZeroTier while internet egress stays. Applying a firewall change restarts Docker, and with it the whole
  stack: live sockets drop and reconnect, and the site prewarms again.
- Caddy's `stream_close_delay 5m` keeps upgraded live sockets open across a Caddy reload, so a vhost change
  does not cut live sessions.

What the infra side needs for the Express site, before or with its first deploy:

- Caddy: `encode zstd gzip` on the site route (above). It is harmless while an older image runs, since Caddy leaves
  an answer that already has a `Content-Encoding` alone.
- Compose: the site's `stop_grace_period` at 30 s. The worst stop, a SIGTERM during the prewarm with a request held
  plus the 15 s grace, was measured at 19.3 s, too close to today's 20 s. `tools/deploy/docker-compose.yml`
  changes first and the role's byte copy follows, as for any compose change.
- `KEEP_ALIVE_TIMEOUT` is no longer read. The server's own keep-alive and headers timeouts apply (Node's 5 s
  keep-alive, 60 s for the headers, 300 s for a request); a role that sets it should drop it.
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
6. postgres (`up -d --wait`, waited healthy), then `docker compose run --rm migrate`, which applies new migrations
   and sets the roles and grants (Migrations, below). A migration that fails stops the deploy before site and live
   restart.
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
  the prebuild step, `tools/build/`, the env check, `live-deps.mjs` and `tools/db/migrate.ts`), the Dockerfile and
  the bake file out of the context: they are neither sent nor hashed. The site build runs on every deploy, as the
  build id is baked into the bundles. Tailwind scans the same files in a checkout (`@source` in
  `src/app/globals.css`), so a checkout's build and the image's have the same CSS.
- `npm ci` depends on `package.json` and `package-lock.json` alone, with npm's download cache in a BuildKit cache
  mount (`gtnh-npm`): a deploy with the same lockfile reuses the install.
- `npm run build` builds the client with Vite, prerenders the page and bundles the server with esbuild, in one `RUN`
  with one env; there is no build cache mount. The server build also takes every build value from the client's
  `dist/client/build.json` and fails on a different one (Environment, above).
- The site image is the server bundle and what it reads from its working folder `/app`: `dist/server/server.mjs`
  and `app.mjs`, `dist/client` (the page template, `page.json` with the script hashes, `build.json` and
  `/assets`), `public/`, the two site files `src/app/favicon.ico` and `src/app/opengraph-image.png`, the env check
  in `deploy/`, and in `node_modules` only the packages the bundle leaves external (express, pg, kysely, zod,
  highs) with their whole run-time closure, collected the way the live image's are (`live-deps.mjs` over
  `dist/server/meta.json`, the `site-deps` stage). The highs route and the solver read
  `node_modules/highs/build` from the working folder. As a smoke test, the build imports every package the bundle
  imports. The layers that rarely change (packages, public files) come first, so a deploy that leaves them alone
  reuses them.
- The live image holds `dist-live/` and only the packages it can load: the ones its bundle leaves external
  (esbuild's metafile names them) and their whole run-time closure from `package-lock.json`, dependencies, optional
  dependencies and peers, however late each is loaded (`tools/deploy/live-deps.mjs`, the `live-deps` stage). The
  layer changes only with the lockfile or the bundle's imports. As a smoke test, the build then imports every
  package the bundle imports.
- Nothing is pruned at build: each run image copies only the packages its bundle loads.

The cache lives in the server's BuildKit store, bounded only by dockerd's builder garbage collection; step 9 removes
old image tags, not build cache. Watch it with `docker buildx du` (the npm cache mount is a few hundred MB; the
rest is old layers). To trim it, `docker builder prune --filter until=168h` drops what no build used for a week and
keeps what the last deploys share; after a week without a deploy that includes the cache mount, and the next
deploy builds cold. A full `docker builder prune` always empties it. Either way the next deploy is correct, only
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

The migrate image runs the migration runner (`tools/db/migrate.ts`, bundled with `pg` inside to
`dist-db/migrate.mjs` by `npm run build:db`) over the image's copy of `db/`, on every deploy. It prints
`migrate: <file>` for each file it applies and `migrate: done`; a rerun prints only `migrate: done`. On a failure it
prints `migrate: <message>`, naming the file, and exits 1. `npm run db:migrate` runs the same from a checkout
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and both role passwords).

- One run at a time: it holds advisory lock 7361, and a run that cannot take it within 2 minutes fails ("another
  migration run holds the lock").
- Each file in `db/migrations/` (`NNNN-words.sql`, numbered from 0001 with no gaps) that the ledger
  `schema_migrations` does not hold is applied in its own transaction, which also writes its ledger row with its
  sha256 (of the text with LF line ends, so a CRLF checkout matches). A failing file rolls back alone.
- An applied file that has changed is refused by name: a schema change is always a new file.
- The transaction is the runner's, so a file holds no `begin`, `commit`, `rollback`, `abort`, `end`,
  `start transaction`, `savepoint`, `release` or `prepare transaction`, and nothing `concurrently`.
- A file leaves `standard_conforming_strings` and `backslash_quote` alone: every file shares the runner's one
  session, and the check reads strings with their defaults.
- Those checks read the file's text, with comments, string literals, quoted names and dollar bodies skipped. SQL
  built at run time, such as an `execute` of a concatenated string, is not read: the checks stop accidents, not a
  file written to get past them.
- Refused by name before anything is applied: a file breaking these rules, and any file in `db/migrations/` not
  named `NNNN-words.sql` (hidden files are passed over).
- Refused as a database: one whose `public` schema holds tables but no ledger ("this database was not set up by
  the migration runner"), and one that has Supabase's `anon` or `authenticated` role, where row security is what
  keeps tables off the public API key.

`0001-baseline.sql` is the whole schema for a fresh database. Then, every run, the runner makes the two logins the
direct client uses (`DATABASE_URL`, built by compose) with the passwords from `GTNH_SITE_DB_PASSWORD` and
`GTNH_LIVE_DB_PASSWORD`, and applies `db/grants.sql`, which revokes and grants their rights again in the same
transaction, so a grant the file drops is gone after the next deploy. A password reaches the server only as a
bound parameter, with statement, duration and parameter logging off for that transaction, and is never printed:

- `gtnh_site`: select, insert, update and delete on every app table and usage on the sequences; nothing on the
  ledger, no DDL, no truncate. Neither role may create temporary tables (`temporary` is revoked from `public`).
- `gtnh_live`: the columns the live store uses: select `id, username, is_admin, session_epoch` on
  `community_users`; select on `library_design_members`; select `user_id, id, plan, seq, plan_bytes, deleted_at,
  live_lease_until, live_lease_token` and update `plan, seq, plan_updated_at, updated_at, live_lease_until,
  live_lease_token` on `library_designs`. Nothing else.

Row security is off: with no policies it would hide every row from these roles, and who may see which rows is the
server's rules (`src/lib/server/services/access.ts`). `db-roles.test.ts` pins the grants and `migrations.test.ts`
the runner; a new table needs its line in `db/grants.sql`, or `db-roles.test.ts` fails.

## Datasets

```bash
node tools/dataset-pipeline/scripts/build-datasets.mjs all --export   # build both into public/datasets/gtnh
tools/deploy/publish-datasets.sh stage local-2.9.0-rc-2 local-2.8.1
```

The datasets are built only by `build-datasets.mjs` (`tools/dataset-pipeline/CLAUDE.md`, Build and publish: what a
fresh clone needs first, memory, disk, network and run times, and recovering from a failed export). It exports in
Docker, rebuilds, installs a version only when the checks below would pass, and points the power maps
(`src/lib/power/data`) at what it installed: commit those maps with the publish.

Publishing copies from this checkout's `public/datasets/gtnh` into `/srv/gtnh/datasets`, in the pipeline's
order (`tools/dataset-pipeline/CLAUDE.md`):

1. Refuses a version without `recipe-lookup-index.json.gz`, or a manifest listing a version that is neither given
   nor on the server. Refuses a version with no NEI order (`resourceOrder` in `resource-index.json.gz`) whose served
   copy has one (`GTNH_ALLOW_NO_NEI_ORDER=1` publishes it anyway), and warns about one that never had it.
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
under `scratch/rehearsal/`, the site and live on `127.0.0.1:3480` and `:3481`, and, in the rehearsal only, Postgres
published on `127.0.0.1:3482` for the tests against the real roles:

1. Build the three images from HEAD as the deploy does: in a directory holding `git archive HEAD`,
   `TAG=<tag> SITE_URL=http://127.0.0.1:3480 docker buildx bake -f tools/deploy/docker-bake.hcl --load`
   (`MOD_AND_COMMUNITY=on` for a build with the switch on; then `.env` says `on` too).
2. `scratch/rehearsal/.env` from `env.example` with real random values, `LIVE_ALLOWED_ORIGINS=http://127.0.0.1:3480`;
   `release.env` with `GTNH_TAG=<tag>`; `scratch/rehearsal/postgres` owned `5432:5432` (a non-root postgres cannot
   chown its directory, so a root-owned bind mount or named volume fails its initdb; `docker run --rm -v
   "$PWD/scratch/rehearsal/postgres:/d" alpine chown 5432:5432 /d` sets it); `scratch/rehearsal/datasets` a copy of
   `public/datasets/gtnh` (`cp -cR` clones it on APFS).
3. `docker compose -f tools/deploy/docker-compose.yml -f tools/deploy/compose.rehearsal.yml --env-file
   scratch/rehearsal/.env --env-file scratch/rehearsal/release.env ...`: `up -d --wait postgres`, `run --rm migrate`
   twice (the first prints `migrate: 0001-baseline.sql` and `migrate: done`, the second only `migrate: done`),
   `up -d --wait live site`.
4. The repository cases under the real roles:
   `REAL_DATABASE_URL=postgres://gtnh_site:<GTNH_SITE_DB_PASSWORD>@127.0.0.1:3482/postgres
   REAL_LIVE_DATABASE_URL=postgres://gtnh_live:<GTNH_LIVE_DB_PASSWORD>@127.0.0.1:3482/postgres npx vitest run
   src/lib/server/db/pg-real.local.test.ts --config vitest.local.config.ts`. It writes rows under fresh account
   names and deletes them after.
5. `check-env.mjs ... --rehearsal` accepts the http origin. A target file with `DEPLOY_SSH=local` runs
   `publish-datasets.sh` against `scratch/rehearsal`.
6. `node tools/deploy/smoke.mjs --base http://127.0.0.1:3480 --live http://127.0.0.1:3481`.
7. A database restart under load: rerun the smoke in a loop, with a signed-in `GET /api/library` polled every
   200 ms, and `docker restart gtnh-postgres` (or `docker stop`, a few seconds, `docker start`). Requests during the
   outage answer 500 with the down sentence ("The community database is not responding. Try again in a few
   minutes."), the site answers again within 30 s of Postgres being back (at most the breaker's 15 s), site and
   live keep their `StartedAt` and restart count, and a live room opens again (`tools/live/test-client.mjs`). The
   smoke signs up twice a run against the register limit (5 an hour per address): between runs, `delete from
   community_events where action = 'register'` as `postgres`, in the rehearsal database only.
8. `docker compose ... --profile tools down`, remove the images, then remove `scratch/rehearsal`.

## Smoke test

`node tools/deploy/smoke.mjs --base https://stage.gtnhplanner.idebugger.net --caddy` checks the version and build,
live health, headers (nosniff, HSTS over https, the security headers on an unknown path's 404), a page policy that
allows its scripts by hash and never by `'unsafe-inline'` (`--no-expect-hashed-csp` skips that for a build older
than the Express site), the 308 with `Refresh` for `/api/version/` and `//api/version`, `/API/version` 404, a
cross-site POST to `/API/community/auth/logout` refused, the dataset gate, the live service's internal routes kept
off the site, board image uploads (a URL on this site, served `image/png`, nosniff, immutable; a text file 415; a
9 MB body 413 at the edge), the mod-and-community switch, two throwaway accounts (a design saved by one session read
by another; a foreign Origin 403) and a headless browser pass (Welcome, a new design, a recipe card, `highs.wasm`,
a 2.8.1 plan asking the 2.8.1 dataset, no page errors, no policy violation, no hydration message). With `--caddy`
it also checks that `/` and a script under `/assets/` come gzip-encoded when asked, and that a lookup index's bytes
are the same with and without `Accept-Encoding`. Live editing end to end is
`tools/live/test-client.mjs --base <site>`: register, create, share, `join --for 150`, send, unshare.

## Diagnose

On the server, in `/opt/gtnh`:

```bash
docker compose --env-file .env --env-file release.env ps
docker compose --env-file .env --env-file release.env logs --tail 200 site    # or live, postgres
docker logs gtnh-site 2>&1 | grep '\[db\]'          # dropped connections, a missing DATABASE_URL, unread variables
docker logs gtnh-site 2>&1 | grep 'neither X-Client-Ip nor CF-Connecting-IP'    # requests without Caddy's header
docker logs gtnh-live 2>&1 | grep 'untrusted peer'       # LIVE_TRUSTED_PROXIES misses the proxy
docker exec gtnh-postgres psql -U postgres -Atc "select name, applied_at from schema_migrations"
docker exec gtnh-postgres psql -U postgres -c "select application_name, state, count(*) from pg_stat_activity
  where usename in ('gtnh_site', 'gtnh_live') group by 1, 2"    # pool use: at most 10 site and 6 live
```

Caddy's JSON log for the vhost is `/var/log/caddy/gtnh-stage.log`. A slow first API call after a start means the
prewarm or the deploy regressed; the site's healthcheck allows 180 s before counting failures.

Every route answering 500 "The community database is not responding. Try again in a few minutes." means the site
cannot reach Postgres or it does not answer in time (5 s to connect, 15 s a statement): after 5 such failures in a
row the site stops sending for 15 s, then tries again, so it recovers by itself once Postgres is back; no site or
live restart is needed. A 503 from the library or accounts with Postgres up means the site has no `DATABASE_URL`
(the startup log says so). "permission denied" in a log is a query outside its role's grants: the grant belongs in
`db/grants.sql`, applied by the next migrate run.

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
- The public site moves to this stack with a fresh database: no data is copied from the hosted project it runs
  on today, so accounts, posts and library plans start empty, and a plan whose board images point at the old
  host's storage is not supported.
