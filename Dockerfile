# The site, the live service and the database setup, built from the
# committed tree (the deploy sends `git archive HEAD` as the context and
# builds the three targets in one bake: docs/deploy.md). By hand:
#
#   docker build --target site --build-arg NEXT_PUBLIC_SITE_URL=https://... --build-arg GTNH_BUILD_ID=<version>-<sha8> .
#   docker build --target live ... .
#   docker build --target migrate --build-arg GTNH_BUILD_ID=... .   (no site URL: it skips the site build)
#
# Both run as the image's `node` user (uid 1000) with root-owned, read-only
# application files. Datasets, uploaded files, client files and the live
# journal are mounted volumes; nothing in the image is written at run time
# but /tmp. The site keeps an empty /app/.next/cache, which compose still
# mounts a tmpfs over.
#
# Layers are ordered so a deploy rewrites only what changed: the package
# installs depend on package.json and package-lock.json alone, npm's download
# cache persists in a BuildKit cache mount between builds, and the run images
# copy their unchanging parts first.

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
# The image has no git, so the build takes its identity from here
# (tools/build/build-identity.mjs).
RUN test -n "$GTNH_BUILD_ID" || { echo "GTNH_BUILD_ID is required (<version>-<sha8>)" >&2; exit 1; }
COPY . .
# `npm run build` is the client (Vite), the prerendered page and the server
# bundle (esbuild), in one RUN with one env: the server build also takes every
# build value from the client's dist/client/build.json and fails on a
# different one, so the page and the server are built alike.
# Modes only for what comes from the git tree, whose files can be 664, and
# for the build output: the run images copy them as they are, and a chmod
# there would rewrite a layer.
RUN NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    NEXT_PUBLIC_LIVE_URL="$NEXT_PUBLIC_LIVE_URL" \
    NEXT_PUBLIC_MOD_AND_COMMUNITY="$NEXT_PUBLIC_MOD_AND_COMMUNITY" \
    NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL="$NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL" \
    GTNH_BUILD_ID="$GTNH_BUILD_ID" \
    npm run build \
 && npm run build:live -- --metafile=dist-live/meta.json \
 && chmod -R a+rX,go-w public tools/deploy dist src/app/favicon.ico src/app/opengraph-image.png

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

# The site's run-time packages, the same way: the ones the server bundle
# leaves external (dist/server/meta.json) and their whole run-time closure.
FROM deps AS site-deps
COPY tools/deploy/live-deps.mjs /tools/live-deps.mjs
COPY --from=build /app/dist/server/meta.json /tools/meta.json
RUN node /tools/live-deps.mjs package-lock.json /tools/meta.json /app /site

FROM ${NODE_IMAGE} AS site
# The app root: the server reads dist/client, public/, the site files in
# src/app and node_modules/highs/build from its working folder.
WORKDIR /app
# .next/cache stays only because compose still mounts a tmpfs there; nothing
# writes it.
RUN mkdir -p /app/public/datasets/gtnh /app/.next/cache /data/files /data/client-files \
 && chown node:node /app/.next/cache /data/files /data/client-files
# The server bundle (dist/server: server.mjs, which sets NODE_ENV and loads
# app.mjs), the built client (dist/client: the page template, page.json with
# the script hashes, build.json and /assets), public/, the two site files the
# server reads (favicon.ico, opengraph-image.png) and the packages the bundle
# loads. Public files carry no datasets: they are a volume. Unchanging parts
# first: a deploy whose packages and public files are the same reuses those
# layers.
COPY --from=site-deps /site/node_modules ./node_modules
COPY --from=build /app/public ./public
# The deploy runs the env check in this image, against the server's .env and
# the image's dist/client/build.json.
COPY --from=build /app/tools/deploy/check-env.mjs ./deploy/
COPY --from=build /app/src/app/favicon.ico /app/src/app/opengraph-image.png ./src/app/
COPY --from=build /app/dist/client/assets ./dist/client/assets
COPY --from=build /app/dist/client/index.html /app/dist/client/page.json /app/dist/client/build.json ./dist/client/
COPY --from=build /app/dist/server/server.mjs /app/dist/server/app.mjs ./dist/server/
# A smoke test: every package the server bundle imports loads here.
RUN --mount=type=bind,from=build,source=/app/dist/server/meta.json,target=/tmp/meta.json \
    node --input-type=module -e 'import { readFileSync } from "node:fs"; const meta = JSON.parse(readFileSync("/tmp/meta.json", "utf8")); const packages = new Set(Object.values(meta.outputs).flatMap((output) => output.imports).filter((entry) => entry.external && !entry.path.startsWith("node:")).map((entry) => entry.path)); for (const name of packages) { await import(name); } console.log("site packages:", [...packages].join(" "));'
# HOSTNAME: Docker sets it to the container id; the server listens on this.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
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
# Run under compose's `init: true` (tini), which hands SIGTERM to server.mjs:
# it stops taking connections, finishes the open requests (each answer then
# says Connection: close), and exits 143 within its 15 s grace.
# TINI_KILL_PROCESS_GROUP also reaches anything it starts. No npm wrapper,
# which would swallow the signal.
CMD ["node", "dist/server/server.mjs"]

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
# the two files it is made of: it never waits for the site build or needs
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
