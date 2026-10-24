# Server and API (src/lib/server, src/app/api)

## Recipe queries (dataset-query.ts)

- A query is clauses (`role:kind:id`, `src/lib/datasets/recipe-query.ts`) plus
  `takesOp` / `makesOp` (any / all / only) and the map selection. The server does set
  algebra over the lookup index (`getClauseLookupRecipesByMap`): any = union,
  all = intersection, sides intersect. Every clause gets the concrete-context rewrite
  (`applyClauseResourceContexts`).
- ONLY is verified against recipe bodies (`recipeIsOnlyMatch`) up to `ONLY_VERIFY_LIMIT`
  candidates, then degrades to ALL. Non-consumed inputs never count against takes-ONLY.
- All-maps answers page through `recipeMaps` in chip order, best match first inside each
  map (`orderByRecipeMap`).
- The catalog mixes in server output, so its cache key includes `APP_VERSION`. A new
  catalog field must be added to `getDatasetCatalog`'s explicit field list (and
  `RecipeDataset` in types.ts) or it never reaches the client.
- Dataset files other than textures may be replaced in place; textures are
  cache-immutable, so a changed icon needs a new name.
- Every server cache is bounded or index-sized (the Node heap is capped at 3 GB). A slow
  site: check the heap first.
- The OG card route reads fonts through `process.cwd()` (non-standalone build).
- The image optimizer is off (`images.unoptimized` in next.config.ts): nothing uses next/image, and
  `/_next/image` would hand any same-origin PNG (uploads, dataset textures) to sharp. Pictures are served
  by the app's own routes or plain `<img>`; keep it that way.

## Prewarm (instrumentation.ts, `prewarmDatasetVersions`)

- With `GTNH_PREWARM_ON_STARTUP=1`, `register()` awaits only `latestStableVersion`'s prewarm (Next.js holds
  requests until it resolves), then every other manifest version not in `HIDDEN_DATASET_VERSION_IDS`
  (`src/lib/datasets/hidden-versions.ts`) loads in the background, one at a time. A version that fails is
  logged and skipped; the server still starts. `GTNH_PREWARM_FULL_DATASETS=1` loads the recipe shards too.
  Measured on `next start`: the first answer comes at 8.8-11.6 s, against 15.5-17.3 s when both were
  awaited (`scratch/probes/first-response.mjs`). Exam: `dataset-query.test.ts`.
- The loaded datasets live on `globalThis` (`Symbol.for("gtnh-factory-flow.dataset-query.caches")`), never in
  module-level maps: Next.js bundles `instrumentation.ts` apart from the routes, so a module-level cache is
  filled by the prewarm, unread by every request, loaded again by the first search, and held twice. That
  doubling put two datasets over the 3 GB heap on the first 2.8.1 search. The object survives a dev reload:
  restart the dev server after changing how a dataset is loaded or indexed.
- An HTTP prewarm after start (`/api/datasets/<id>/prewarm`, e.g. a unit's `ExecStartPost`) now joins the
  startup load or finds it done: with `GTNH_PREWARM_ON_STARTUP=1` it is only a readiness wait.
- Memory, measured on `next start` with the 3 GB heap cap (`scratch/probes/t74-memory.mjs`, median of 5 starts,
  heapUsed after a full GC, process RSS in brackets): 2.9 prewarmed 533 MB; 2.9 and 2.8.1 prewarmed 985 MB
  (2.0 GB); after a fixed browse set on each (searches, the Blast Furnace and wide clause browses, blank item
  lists) 1,210 MB (2.1 GB) with the 128 MB shard cap. Before a GC heapUsed reaches about 1.5 GB. Each version takes about 7 s to prewarm.
- Where the heap goes, per version on 2.9 (2.8.1 is about 85% of it): the recipe text index about 255 MB, the
  lookup index about 80 MB, the catalog and its merged resources about 80 MB, item search about 50 MB. What keeps
  it there, each pinned by `dataset-query.test.ts` or `src/lib/search/text-search.test.ts`:
  - the lookup index's search text is released once the text index is built (`ensureLookupSearchIndex`);
  - the search indexes keep one copy of each word (`createTokenInterner`): 5.8 million words, 38 thousand distinct;
  - parsed shards are bounded by estimated heap, 2.5 bytes per byte of unzipped JSON, 128 MB across every version
    (`SHARD_CACHE_BYTES`, `GTNH_MAX_LOADED_RECIPE_SHARD_MB`): typical shards are 1-6 MB, a Blast Furnace shard
    30-57 MB. 128 MB is the smallest that keeps the shards one Blast Furnace browse read for the next (1 ms, 88 ms
    at 64 MB). A request reads at most 4 shards at a time (`SHARD_LOAD_CONCURRENCY`: faster than 6, 8 or all at
    once on a 120-shard browse, with half the read buffers of all at once);
  - each version keeps at most 24 blank item lists (`BLANK_RESOURCE_SEARCH_KEYS`, about 2 MB each unfiltered);
  - hydrated summaries: 8,000 (`GTNH_MAX_HYDRATED_RECIPE_SUMMARIES`), about 50 MB when full.
  `GTNH_PREWARM_FULL_DATASETS=1` reads every shard once but keeps only the last 128 MB of them: it warms the disk,
  not the heap.
- A memory change to these caches must leave every answer byte for byte. Check it with a golden harness: the
  sha256 of every dataset response over a fixed request set, on every installed version, recorded before the
  change and compared after (the set is run twice so cached and evicted answers are held to the same hash):
  `src/lib/server/dataset-responses.local.test.ts`, run with `GOLDEN_RECORD=1` before the change and without it
  after. It needs the installed datasets (`public/datasets/gtnh`), so it is local only, never in the suite; its
  baseline goes to `scratch/golden`, keyed by each version's manifest checksum. It does not cover the legacy
  path for a dataset without a lookup index (`loadRecipeIndex`): no served dataset takes it, because the manifest
  rebuild skips a dataset without `recipe-lookup-index.json.gz`.
- `GTNH_MAX_LOADED_RECIPE_SHARDS` (the old count bound) is no longer read; the server warns at start when it is
  set (`startup-checks.ts`). Use `GTNH_MAX_LOADED_RECIPE_SHARD_MB`.
- The rule has two checks, both with every served version loaded:
  - the live heap stays under 2 GB (two thirds of the heap cap);
  - process RSS stays under about 80% of the server's RAM, counting what else runs there (the live service,
    Caddy). Check the owner's server before a deploy that adds a version; these numbers are from a dev machine.
  Both hold: both versions are prewarmed in full. If one fails, 2.8.1 is prewarmed second with its catalog
  only. Measure again when a dataset grows or a third version is served.

## Supabase (community.ts, resource-popularity.ts)

The instance is small and has gone down under load. Rules:
- Every request goes through `fetchWithDbTimeout` (20 s). A timeout answers 504 rather than
  rejecting (postgrest-js retries a rejected GET three more times), and any 5xx that is not
  JSON (Cloudflare's 522 page comes as text/plain) becomes the same plain JSON error, so no
  route shows a player that page; so do PostgREST's own connection errors (PGRST000-003).
  Exam: `community-db-fetch.test.ts`.
- The instance is Nano (Free plan): disk throughput falls to 5 MB/s once its Disk IO budget
  is spent, and the budget refills only while demand stays under that. After 5 failures in a
  row the client's breaker answers at once for 15 s without sending (`fetchFromDb`).
- A failed account lookup throws, never reads as signed out (`loadSessionUser`); accounts are
  cached a minute. A library answer fails whole when a sharing read fails: the client
  removes every shared copy the answer leaves out.
- Nothing a page needs to render may await a community sweep. `getResourcePopularity`
  answers at once with the last good map (sweep every 6 h, retry after 30 min on failure).
- The design PUT refuses what it can without the database (size, JSON, name, stamps)
  before the rate limit's two queries; the plan schema check follows.
- Read community plan jsonb about 10 rows per statement, or it hits the statement timeout.
- The dashboard (restarts, disk IO, memory) needs the repo owner; there is no management
  token here.

## Sessions and secrets (session.ts)

- `sessionSecret()` is the one owner of `COMMUNITY_HASH_SALT`: the session HMAC, `saltedKey` (rate-limit, feedback
  and voter keys) and nothing else read it. In production a missing, blank or development value throws
  "Sign-in is not set up on this server." at the call, so a server without the secret has no sign-in, library or
  blueprints while the planner keeps serving; outside production the public development secret applies, so a
  checkout signs in with no setup. Never add a second read of the variable or a second default. The live service
  exits without it (`src/live/main.ts`); the two must carry the same value.
- The startup checks warn about a missing or short secret and never throw for it (`startup-checks.ts`).
- A token is `<userId>.<expiresMs>.<epoch>.<hmac>`; the epoch is the account's `session_epoch` at sign-in, and
  `getSessionUser` refuses a token whose epoch differs from the row's. "Sign out everywhere" (`POST
  /api/community/auth/logout` with `{ everywhere: true }`) sets the row's epoch to now (`bumpSessionEpoch`), forgets
  the cached account and tells the live service (`notifyLive` signed-out). A three-part token from before epochs
  reads as epoch 0 and stays good until it expires or the account signs out everywhere. The migration
  `supabase/migrations/2026-10-24-session-epoch.sql` must be applied before a build that reads the column is
  deployed: the account lookup selects it, and without it every signed-in request answers 503. Exam:
  `session.test.ts`, `app/api/community/auth/auth.test.ts`.
- Every database-backed limit counts then records, so `checkRateLimit` runs one at a time per key and action
  (`serially`); a burst for one key is counted one by one. The site is one process, which is what makes the
  in-process queue enough. Sign-in has two limits: 20 attempts per address in 10 minutes (successes included) and
  10 failures per account in 15 minutes from any address (unknown names counted alike, so the limit names no
  accounts); the account count runs inside the same critical section as the lookup and the record. Exam:
  `rate-limit.test.ts`, `app/api/community/auth/login/route.test.ts`.

## The mod and community switch (deployment-features.ts)

- `isModAndCommunityOn()` is true only when `NEXT_PUBLIC_MOD_AND_COMMUNITY` is `on`; unset or anything else is off.
  Off, every `/api/community/plans/**` route, the public blueprint shelf (`?scope=public`, `/publish`, `/vote`,
  `/download`, and another account's blueprint by id) and `/community` answer 404 (`modAndCommunityOffResponse`);
  sitemap, llms.txt, robots and the `?plan=` metadata say nothing of community plans. Accounts, board images, the
  library, account sync and an account's own blueprints stay. Read it at each call, never in a module constant.
- The value must be the same at `next build` and in the site's and the live service's run-time environment; a change
  needs a rebuild. `next.config.ts` always defines it (`env`, "" when unset), so the literal read is the build's value
  in the browser and server bundles alike. The browser has only that. On the Next.js server `isModAndCommunityOn()`
  also reads the process (`Reflect.get`, never inlined) and is on only when both say `on`: a build without it and a
  unit that sets `on` (or the reverse) answers 404 on every mod and community route. The browser of a build made `on`
  still shows the keys against those 404s, and the live service reads only its process, so it lets the game in
  whenever its own unit says `on`.
- Tests run with the default (off). A test of a gated feature calls `withModAndCommunityOn()`
  (`src/test-support/mod-and-community.ts`); a test of the off side calls `withModAndCommunityUnset()`.

## Feedback from the game (feedback.ts, app/api/feedback)

- Off (above), a report whose `origin` is absent or `game` answers 404 before the 503 and before the gate counts
  it; that early read stops at `FEEDBACK_MAX_BYTES` even with no `content-length`. `web` is unchanged.
- The in-game planner's Feedback box posts to `/api/feedback`; each report becomes an issue on
  `jackwrichards/gtnh-planner-mod` through `GITHUB_FEEDBACK_TOKEN` (in `/opt/shared/env.local`; without it the route
  answers 503). The web planner's reports (`origin: "web"`) open on the website's repo,
  `jackwrichards/gtnh-factory-flow` (`feedbackRepo`; `GITHUB_FEEDBACK_WEB_REPO` and `GITHUB_FEEDBACK_REPO` override), so
  the token needs Issues read and write on both repos.
- It was flooded on 2026-10-12 (450 spam issues from about 5,000 residential addresses, the mod's user agent, made-up
  versions), so `feedback-guard.ts` stands in front: the mod's shapes (device id, versions), an in-memory gate (30
  a minute; 60 refusals in 10 minutes pause reports for 6 hours), 3 an hour and 10 a day per address and per device,
  the same words once a month, and at most 10 issues an hour and 40 a day for the whole site. Player text is escaped
  (no pictures, links or HTML in the issue).
- The client address is Caddy's `X-Client-Ip` (Cloudflare's CF-Connecting-IP, trusted only from Cloudflare's
  ranges), then CF-Connecting-IP; X-Forwarded-For names a Cloudflare edge (`clientAddress` in community.ts).
- Emergency stop without a deploy: a Caddy rule answering 503 to `POST /api/feedback` (`/etc/caddy/Caddyfile`, then
  `systemctl reload caddy`).
- Plans and the picture go to the private `feedback-files` bucket, served by `/api/feedback/files/<id>/<file>`, only
  once every check has passed. The mod strips names, paths and addresses from logs and crash reports before sending.

## Local database (local-db/, `npm run dev:local`)

- `LOCAL_DB=1` points the server's Supabase client at a real Postgres on this machine (PGlite, loaded from
  `supabase/schema.sql` and `supabase/migrations/*.sql` on every open) through a PostgREST stand-in
  (`local-db/postgrest.ts`). Unset, nothing changes. Never copy `.env.local` into a worktree: local work needs no
  Supabase credentials.
- Next.js never loads PGlite: it reaches the database over HTTP at `LOCAL_DB_URL` (`tools/local-db/serve.ts`, data in
  `scratch/local-db/pgdata`). Tests open it in memory and register it in-process (`useInProcessLocalDb`).
- The stand-in covers the query shapes this code sends (filters, or-trees, counts, single, upserts, storage buckets).
  A new shape (an embed, an rpc) needs it added there and a case in `postgrest.test.ts`.

## Cloud plans (cloud-plans.ts, app/api/library, app/api/accounts)

- A design id is unique per owner only: every route under `/api/library/designs/[id]` takes `?owner=<ownerId>`
  (absent: the caller's own). Owners and members read; members save the plan and its name, never the owner's folders,
  order or stars; only the owner shares, unshares and deletes; a member leaves by removing themselves.
- While `live_lease_until` is in the future the live service is the plan's only writer: the PUT refuses a plan body
  (409 `{ live: true }`) and its write is conditional on the lease. Metadata still goes through.
- `GET /api/library` keeps listing tombstones (clients rely on it never to reuse a deleted id) and adds each design's
  `members` and the `shared` plans, in one extra read when nothing is shared.
- Deleting a design deletes its member rows (designs are tombstoned, so the foreign key's cascade never fires) and
  tells the live service; sharing changes tell it too (`notifyLive`, only with `LIVE_INTERNAL_URL` and
  `LIVE_INTERNAL_TOKEN`). A failed notice loses nothing: the service checks membership on every join.
- Account search is limited in memory (`memory-rate.ts`): a share box asks on every keystroke.
- Exam: `app/api/library/cloud-plans.test.ts` (against the local database).
