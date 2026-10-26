# The site, the live service and the database setup, built from the
# committed tree (the deploy streams `git archive HEAD` as the context;
# docs/deploy.md). The site and live targets share one build:
#
#   docker build --target site --build-arg NEXT_PUBLIC_SITE_URL=https://... --build-arg GTNH_BUILD_ID=<version>-<sha8> -
#   docker build --target live ... -
#   docker build --target migrate --build-arg GTNH_BUILD_ID=... -
#
# Both run as the image's `node` user (uid 1000) with root-owned, read-only
# application files. Datasets, uploaded files, client files and the live
# journal are mounted volumes; nothing in the image is written at run time
# but /tmp and the site's .next/cache (tmpfs in compose).

# Node 24 as CI. Pinned by digest: a tag can be moved, a digest cannot.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

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
RUN NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    NEXT_PUBLIC_LIVE_URL="$NEXT_PUBLIC_LIVE_URL" \
    NEXT_PUBLIC_MOD_AND_COMMUNITY="$NEXT_PUBLIC_MOD_AND_COMMUNITY" \
    NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL="$NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL" \
    GTNH_BUILD_ID="$GTNH_BUILD_ID" \
    NEXT_TELEMETRY_DISABLED=1 \
    npm run build \
 && npm run build:live \
 && npm run build:db \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf .next/cache

FROM ${NODE_IMAGE} AS site
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MOD_AND_COMMUNITY=
ARG GTNH_BUILD_ID
WORKDIR /app
# What `next start` reads: the build, public files (no datasets: they are a
# volume), the run-time packages, and the config with the two files it
# imports (it is loaded again at run time). The card route reads its fonts
# through process.cwd(); nothing else from src/ is needed.
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/next.config.ts /app/security-headers.config.ts /app/body-limits.config.ts ./
COPY --from=build /app/src/app/fonts ./src/app/fonts
# The deploy runs the env check in this image, against the server's .env.
COPY --from=build /app/tools/deploy/check-env.mjs /app/tools/deploy/service-token.mjs ./deploy/
# Modes only for what comes from the git tree (its files can be 664): .next
# and node_modules are written by root at 644/755 in the build stage, and a
# chmod over them would copy every file into a new layer.
RUN mkdir -p /app/public/datasets/gtnh /app/.next/cache /data/files /data/client-files \
 && chown node:node /app/.next/cache /data/files /data/client-files \
 && chmod -R a+rX,go-w /app/*.ts /app/package.json /app/src /app/public /app/deploy
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1 \
    GTNH_PREWARM_ON_STARTUP=1 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    UV_THREADPOOL_SIZE=8 \
    FILE_STORE_DIR=/data/files \
    GTNH_CLIENT_FILES_DIR=/data/client-files \
    TINI_KILL_PROCESS_GROUP=1
LABEL org.gtnh.build=$GTNH_BUILD_ID \
      org.gtnh.mod-and-community=$NEXT_PUBLIC_MOD_AND_COMMUNITY \
      org.gtnh.site-url=$NEXT_PUBLIC_SITE_URL
USER node
EXPOSE 3000
# Run under compose's `init: true` (tini): TINI_KILL_PROCESS_GROUP sends the
# stop signal to the whole group, so the next-server child the CLI starts
# gets it too. No npm wrapper, which would swallow the signal.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

FROM ${NODE_IMAGE} AS live
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MOD_AND_COMMUNITY=
ARG GTNH_BUILD_ID
WORKDIR /app
# The bundle keeps its packages external (esbuild --packages=external): the
# pruned run-time node_modules holds them.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-live ./dist-live
COPY --from=build /app/package.json ./
RUN mkdir -p /data/live-journal && chown node:node /data/live-journal && chmod a+r,go-w /app/package.json
ENV NODE_ENV=production \
    LIVE_HOST=0.0.0.0 \
    LIVE_PORT=3001 \
    LIVE_JOURNAL_DIR=/data/live-journal \
    NODE_OPTIONS=--max-old-space-size=480
LABEL org.gtnh.build=$GTNH_BUILD_ID \
      org.gtnh.mod-and-community=$NEXT_PUBLIC_MOD_AND_COMMUNITY \
      org.gtnh.site-url=$NEXT_PUBLIC_SITE_URL
USER node
EXPOSE 3001
CMD ["node", "dist-live/live.mjs"]

# The database's setup, run once per deploy (`docker compose run --rm
# migrate`): the migration runner, bundled with `pg` inside so the image
# needs no node_modules, and the SQL it applies (db/), so the server needs no
# checkout.
FROM ${NODE_IMAGE} AS migrate
ARG GTNH_BUILD_ID
COPY --from=build /app/dist-db/migrate.mjs /deploy/migrate.mjs
COPY db/ /deploy/db/
RUN chmod -R a+rX,go-w /deploy
LABEL org.gtnh.build=$GTNH_BUILD_ID
USER node
CMD ["node", "/deploy/migrate.mjs", "/deploy/db"]
