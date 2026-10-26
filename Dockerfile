# The site, the live service and the database setup, built from the
# committed tree (the deploy sends `git archive HEAD` as the context and
# builds the three targets in one bake: docs/deploy.md). By hand:
#
#   docker build --target site --build-arg NEXT_PUBLIC_SITE_URL=https://... --build-arg GTNH_BUILD_ID=<version>-<sha8> .
#   docker build --target live ... .
#   docker build --target migrate --build-arg GTNH_BUILD_ID=... .   (no site URL: it skips the Next build)
#
# Both run as the image's `node` user (uid 1000) with root-owned, read-only
# application files. Datasets, uploaded files, client files and the live
# journal are mounted volumes; nothing in the image is written at run time
# but /tmp and the site's .next/cache (tmpfs in compose).
#
# Layers are ordered so a deploy rewrites only what changed: the package
# installs depend on package.json and package-lock.json alone, npm's download
# cache and Next's build cache (Turbopack's and the type check's) persist in
# BuildKit cache mounts between builds, and the run images copy their
# unchanging parts first.

# Node 24 as CI. Pinned by digest: a tag can be moved, a digest cannot.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=gtnh-npm,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund

FROM deps AS build
# Build values: baked into the bundles, the same for every container of the image.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_LIVE_URL=/live
ARG NEXT_PUBLIC_MOD_AND_COMMUNITY=
ARG NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL=/datasets/gtnh/datasets.manifest.json
ARG GTNH_BUILD_ID
# Every absolute link the site writes names this origin; a build without it
# would name the development server.
RUN test -n "$NEXT_PUBLIC_SITE_URL" || { echo "NEXT_PUBLIC_SITE_URL is required" >&2; exit 1; } \
 && node -e 'const u = new URL(process.argv[1]); if (!/^https?:$/.test(u.protocol) || u.origin !== process.argv[1].replace(/\/+$/, "")) { console.error("NEXT_PUBLIC_SITE_URL must be an http(s) origin"); process.exit(1); }' "$NEXT_PUBLIC_SITE_URL"
# The image has no git, so next.config.ts takes the build's identity from here.
RUN test -n "$GTNH_BUILD_ID" || { echo "GTNH_BUILD_ID is required (<version>-<sha8>)" >&2; exit 1; }
COPY . .
# .next/cache is a cache mount: `next build` reuses the previous build's
# Turbopack cache and type-check state, and none of it lands in a layer.
# Modes only for what comes from the git tree, whose files can be 664: the
# run images copy them as they are, and a chmod there would rewrite a layer.
RUN --mount=type=cache,id=gtnh-next-cache,target=/app/.next/cache,sharing=locked \
    NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    NEXT_PUBLIC_LIVE_URL="$NEXT_PUBLIC_LIVE_URL" \
    NEXT_PUBLIC_MOD_AND_COMMUNITY="$NEXT_PUBLIC_MOD_AND_COMMUNITY" \
    NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL="$NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL" \
    GTNH_BUILD_ID="$GTNH_BUILD_ID" \
    NEXT_TELEMETRY_DISABLED=1 \
    npm run build \
 && npm run build:live -- --metafile=dist-live/meta.json \
 && chmod -R a+rX,go-w public src/app/fonts tools/deploy

# The live service's run-time packages: the ones its bundle leaves external
# (esbuild --packages=external; the build's metafile names them) and their
# whole run-time closure from package-lock.json, however late each is loaded
# (tools/deploy/live-deps.mjs). It reruns when the bundle changes, but its
# output changes only with the lockfile or the bundle's imports, and the live
# image's layer of it is reused otherwise.
FROM deps AS live-deps
COPY tools/deploy/live-deps.mjs /tools/live-deps.mjs
COPY --from=build /app/dist-live/meta.json /tools/meta.json
RUN node /tools/live-deps.mjs package-lock.json /tools/meta.json /app /live

FROM ${NODE_IMAGE} AS site
WORKDIR /app
RUN mkdir -p /app/public/datasets/gtnh /app/.next/cache /data/files /data/client-files \
 && chown node:node /app/.next/cache /data/files /data/client-files
# Next's standalone output (next.config.ts): server.js with the traced server
# files and the packages they load, the config serialized inside. Next leaves
# the client files and public/ to be copied beside it. Public files carry no
# datasets: they are a volume. The card route reads its fonts through
# process.cwd(). Unchanging parts first: a deploy whose packages, public
# files and fonts are the same reuses those layers.
COPY --from=build /app/.next/standalone/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/src/app/fonts ./src/app/fonts
# The deploy runs the env check in this image, against the server's .env.
COPY --from=build /app/tools/deploy/check-env.mjs /app/tools/deploy/service-token.mjs ./deploy/
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/.next/standalone/server.js /app/.next/standalone/package.json ./
COPY --from=build /app/.next/standalone/.next ./.next
# HOSTNAME: Docker sets it to the container id, and server.js listens on it.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    GTNH_PREWARM_ON_STARTUP=1 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    UV_THREADPOOL_SIZE=8 \
    FILE_STORE_DIR=/data/files \
    GTNH_CLIENT_FILES_DIR=/data/client-files \
    TINI_KILL_PROCESS_GROUP=1
# Declared here, after every RUN and COPY: a build argument in scope is part
# of each later RUN's cache key, and the build id changes with every commit.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MOD_AND_COMMUNITY=
ARG GTNH_BUILD_ID
LABEL org.gtnh.build=$GTNH_BUILD_ID \
      org.gtnh.mod-and-community=$NEXT_PUBLIC_MOD_AND_COMMUNITY \
      org.gtnh.site-url=$NEXT_PUBLIC_SITE_URL
USER node
EXPOSE 3000
# Run under compose's `init: true` (tini), which hands SIGTERM to server.js:
# it stops taking connections, finishes the open requests and exits 143.
# TINI_KILL_PROCESS_GROUP also reaches anything it starts. No npm wrapper,
# which would swallow the signal.
CMD ["node", "server.js"]

FROM ${NODE_IMAGE} AS live
WORKDIR /app
RUN mkdir -p /data/live-journal && chown node:node /data/live-journal
COPY --from=live-deps /live/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist-live ./dist-live
# A smoke test: every package the bundle imports loads here (a package it
# loads later, as pg loads pgpass, is covered by the closure, not by this).
RUN node --input-type=module -e 'import { readFileSync } from "node:fs"; const meta = JSON.parse(readFileSync("dist-live/meta.json", "utf8")); const packages = new Set(Object.values(meta.outputs).flatMap((output) => output.imports).filter((entry) => entry.external && !entry.path.startsWith("node:")).map((entry) => entry.path)); for (const name of packages) { await import(name); } console.log("live packages:", [...packages].join(" "));'
ENV NODE_ENV=production \
    LIVE_HOST=0.0.0.0 \
    LIVE_PORT=3001 \
    LIVE_JOURNAL_DIR=/data/live-journal \
    NODE_OPTIONS=--max-old-space-size=480
# Declared here, after every RUN and COPY: a build argument in scope is part
# of each later RUN's cache key, and the build id changes with every commit.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MOD_AND_COMMUNITY=
ARG GTNH_BUILD_ID
LABEL org.gtnh.build=$GTNH_BUILD_ID \
      org.gtnh.mod-and-community=$NEXT_PUBLIC_MOD_AND_COMMUNITY \
      org.gtnh.site-url=$NEXT_PUBLIC_SITE_URL
USER node
EXPOSE 3001
CMD ["node", "dist-live/live.mjs"]

# The migration runner, bundled with `pg` inside (npm run build:db), from
# the two files it is made of: it never waits for the Next build or needs
# its build arguments.
FROM deps AS db-build
COPY tools/db/migrate.ts ./tools/db/migrate.ts
COPY src/lib/server/db/migrations.ts ./src/lib/server/db/migrations.ts
RUN npm run build:db

# The database's setup, run once per deploy (`docker compose run --rm
# migrate`): the runner, which needs no node_modules, and the SQL it applies
# (db/), so the server needs no checkout.
FROM ${NODE_IMAGE} AS migrate
COPY --from=db-build /app/dist-db/migrate.mjs /deploy/migrate.mjs
COPY db/ /deploy/db/
RUN chmod -R a+rX,go-w /deploy
# Declared here, after every RUN and COPY: a build argument in scope is part
# of each later RUN's cache key, and the build id changes with every commit.
ARG GTNH_BUILD_ID
LABEL org.gtnh.build=$GTNH_BUILD_ID
USER node
CMD ["node", "/deploy/migrate.mjs", "/deploy/db"]
