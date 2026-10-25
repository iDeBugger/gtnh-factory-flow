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
  cache-immutable, so a changed icon needs a new name. The index gzips and the shards are therefore served for a
  day (`DATASET_FILE_CACHE_CONTROL`), never `immutable`; the manifest stays `max-age=0`.
- Next's public handler serves everything under `public/datasets/gtnh` before any route, by the DECODED path, with
  a cache policy it can only set by path (a 404 would be cached like the file). A rewrite matches the path as
  sent, so a rewrite alone is bypassed by percent-encoding (`recipes%2Ejson`). The gate is `src/proxy.ts`
  (`decideDatasetPath`, `dataset-path-gate.ts`), which runs on every request path but `/_next/`: under
  `/datasets/gtnh/` (decoded) it refuses a path that is percent-encoded at all or holds a `.` or `..` segment
  (400 `no-store`), sends the four index gzips, the shards and `recipes.json` to
  `src/app/dataset-files/[versionId]/[...assetPath]/route.ts` (a day's cache, ETag, Last-Modified and one byte
  range on a file; `no-store` on 400 and 404; `recipes.json`, about 2 GB, refused), and lets everything else
  through to the public handler: textures (`immutable` by `next.config.ts` header rule), `oracle/`, stray copies,
  at `max-age=0`. The gate is one process's view of a path: the raw `recipes.json` must still not exist on the
  droplet, and the publish must not copy it. It also makes a pipeline invariant: published names stay within
  `[A-Za-z0-9._-]` (`tools/dataset-pipeline/CLAUDE.md`; `rebuild-manifest.mjs` refuses a version that breaks it),
  or the file is unreachable. The dataset-files and textures routes resolve a file with `resolveDatasetChildPath`
  (dataset-static-file.ts): lexically, then by real path against the real version directory, so a symlink in the
  tree never reads outside it (a miss is a 404). Exam: `dataset-path-gate.test.ts`, `proxy.test.ts`,
  `dataset-files/[versionId]/[...assetPath]/route.test.ts`, `dataset-static-file.test.ts`.
- Every server cache is bounded or index-sized (the Node heap is capped at 3 GB). A slow
  site: check the heap first.
- The OG card route reads fonts through `process.cwd()` (non-standalone build).
- The image optimizer is off (`images.unoptimized` in next.config.ts): nothing uses next/image, and
  `/_next/image` would hand any same-origin PNG (uploads, dataset textures) to sharp. Pictures are served
  by the app's own routes or plain `<img>`; keep it that way.
- Every answer carries the security headers of `src/lib/security-headers.ts` (built into the routes manifest
  by `next.config.ts` at build): one Content-Security-Policy, `X-Frame-Options: SAMEORIGIN`, nosniff,
  `Referrer-Policy`, the one HSTS value; `X-Powered-By` is off. The policy allows only the site's own origin for
  scripts, styles, fonts, fetch/WebSocket and workers (`blob:` workers too), `data:`/`blob:`/`https:` images,
  and no framing by other origins. `/_next/static/*` gets a second policy with `'unsafe-eval'`: the solver
  worker evaluates the HiGHS glue, and a worker's policy is its own script's response (a later rule overrides
  the same key). A third-party script, font, socket or frame needs a change there first, or the browser
  refuses it. Exam: `security-headers.test.ts`, `next-config.test.ts`, probe `scratch/probes/csp-headers.mjs`.
- A route's `catch` answers through `error-response.ts`: `serverErrorResponse` gives the route's own fallback
  sentence and logs the error (a database or file system message names tables or the release path); the one
  sentence passed on is `COMMUNITY_DB_DOWN_MESSAGE`. Dataset routes use `datasetErrorResponse`: an unserved id
  (`DatasetNotFoundError`) is 404 `Dataset not found.`, never the id. `libraryStorageErrorMessage` (the owner's
  own account) and fixed 4xx copy stay as they are. Exam: `error-response.test.ts`,
  `datasets/[versionId]/catalog/route.test.ts`.
- Every dataset route except `prewarm` spends an in-memory work budget per client address (`dataset-rate.ts`):
  3000 units a minute. A base cost goes before any dataset work (1 unit; 25 for a heavy request: a text search
  with a word under three characters or more than three words, `recipe-ids`, `crops`, `resolve-recipes`), then
  one unit per 10 ms the answer took past a free 50 ms (`meteredDatasetWork`; wall time holds the wait behind
  other requests, so a quick answer queued behind a search is not billed as one), so the measured units alone
  keep one address under 30 s of the server thread a minute whatever a query costs. Past the budget the route answers 429 `Too many
  requests. Wait a moment and try again.` with `Retry-After: 10`: the search panes show it, the import path
  (`browser-loader.ts` `retryWhenBusy`: recipe bodies, the id list, recipe resolution) waits and asks again, up
  to six times. The budget is sized against the client: a plan open or import is one body per recipe (about 200
  at the 3 MB plan cap, 1 unit and a few ms each) after the id list; the item pane asks a page in chunks of 120
  per debounced keystroke, heavy while the query holds a tier word. A request with no trusted address is never
  refused (one shared key would turn a missing proxy header into a site-wide 429 and bounds no attacker); in
  production the first such request logs a one-shot warning. `GTNH_DATASET_BUDGET_PER_MINUTE` overrides the
  budget (`0` disables). Floods from many addresses are Cloudflare's. Exam: `dataset-rate.test.ts`,
  `recipes/route.test.ts`, `src/lib/datasets/browser-loader.test.ts`.
- `resolve-recipes` takes at most `RESOLVE_RECIPES_MAX_REFS` (2,000) refs in a body of at most
  `RESOLVE_RECIPES_MAX_BYTES` (2 MiB), each ref shape-checked by `recipe-ref-schema.ts` before the resolver sweeps
  the index (a bad ref is 400, never a 500 with the matcher's error text); the resolver gets the array as it came,
  so the fields the matcher reads and the schema does not name pass through. The browser sends
  `RESOLVE_RECIPES_CHUNK_REFS` (500) at a time, in order (`src/lib/datasets/resolve-recipes-limits.ts` holds all
  three numbers). Exam: `resolve-recipes/route.test.ts`, `src/lib/datasets/browser-loader.test.ts`.
- A text search matches at most six words and at most two of them under three characters
  (`MAX_SEARCH_TERMS`, `MAX_SHORT_SEARCH_TERMS` in `src/lib/search/text-search.ts`): a word that short cannot use
  the trigram index and walks every recipe. The partial phase (entries with ANY of the words) runs in full on
  the item pane (60k entries, 40-60 ms); on recipes it narrows by the words the index can see (a tier word still
  scores but adds no candidates) and is skipped when candidates times words exceed `PARTIAL_PHASE_WORK_BUDGET`
  (180,000: 30,000 candidates for six words, 60,000 for three, so "steel plate pls" answers and a list of six
  metals answers nothing rather than "anything with one of these words"). Worst measured query
  shapes are in `scratch/probes/sec-data-p5.mjs`. Exam: `text-search.test.ts`, `dataset-query.test.ts` "the
  recipe partial search phase".

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
  startup load or finds it done: with `GTNH_PREWARM_ON_STARTUP=1` it is only a readiness wait. The HTTP route
  never reads shards (the route is public, and a shard sweep reads about 2 GB and flushes the shard cache);
  `GTNH_PREWARM_FULL_DATASETS=1` at start is the only shard warm.
- A hidden version (`HIDDEN_DATASET_VERSION_IDS`) is refused by `loadCatalog`, so no request can load a third
  dataset into the heap; the budget below counts only the served versions.
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
  cached a minute, as the lookup's promise from before it answers, so forgetting an account mid-read
  (Sign out everywhere) drops the read too and the old row is never written back. A library answer fails whole when a sharing read fails: the client
  removes every shared copy the answer leaves out.
- Nothing a page needs to render may await a community sweep. `getResourcePopularity`
  answers at once with the last good map (sweep every 6 h, retry after 30 min on failure).
- The design PUT refuses what it can without the database (size, JSON, name, stamps)
  before the rate limit's two queries; the plan schema check follows.
- Read community plan jsonb about 10 rows per statement, or it hits the statement timeout.
- `community_events` keeps 31 days (`EVENTS_KEPT_DAYS`; the longest window read is 30): `recordEvents` deletes older
  rows once an hour per process, oldest first in at most `PRUNE_BATCHES` batches of `PRUNE_BATCH_ROWS` (so a backlog
  never holds a request past the statement timeout; the rest waits an hour), over the `created_at` index (migration
  `2026-10-25-community-events-created-at.sql`, mirrored in `schema.sql`), and a failed prune never fails a save. Exam:
  `community-events.test.ts`.
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
- A rate-limit key never holds a string the client chooses: `makeActorKey(request)` is the salted address alone, and a
  signed-in write is keyed `user:<id>` (the community plan POST: 10 an hour per account). A device id in a key is a
  fresh count per made-up id. Board images (`image-upload-guard.ts`, open to anonymous players) are 30 an hour and 60
  a day per address and 120 an hour and 400 a day for the whole site, counted after the size and magic-byte checks so
  junk spends no share. A vote lands only on a post that exists and is public (or the voter's own), with the same
  404 either way and a fixed 500 sentence, so the route is no oracle for ids; an anonymous address casts or switches
  at most 3 votes a day on one post or blueprint (`VOTES_PER_ADDRESS_PER_PLAN_PER_DAY`; accounts are exempt). The
  `plan-previews` bucket is private and its pictures are served only by `GET .../preview`, which answers an
  unpublished post's picture to its owner and the admin alone (`Cache-Control: private, no-store`) and 404 `No preview.`
  to everyone else; a deployment whose bucket was created public before this must be switched off in the dashboard.
  The share card sizes the picture from its IHDR without a decode, so the preview POST stores only a PNG whose
  first chunk is an IHDR with both sides in 1..`PLAN_PREVIEW_MAX_SIDE` (4096; `readPngHeader` in `plan-preview.ts`,
  else 415), `sizePlanPreview` answers nothing for an object that breaks the rule (the card falls back to the icon
  face), and an account uploads at most 30 previews an hour (`PREVIEWS_PER_HOUR`, counted after the checks).
  No GET writes: a view is `POST .../view` (60 a minute per address), which the library's grid sends once when a player
  opens a post's page (`countPlanView` in `src/lib/community/client.ts`, from the tile's open gesture); the drawer, the
  bookmarks shelf and a copy being made are lookups (`getCommunityPlan`) and count nothing.
  Exam: `community.test.ts`, `app/api/community/images/route.test.ts`, `app/api/community/plans/plan-access.test.ts`.
- Password derivations run on the threadpool, two at a time with a queue of 32 (`KDF_CONCURRENCY`, `KDF_QUEUE_MAX`):
  the dataset's shard reads share the pool's four threads, so a sign-in flood may never hold them all. Past the
  queue the check throws `PasswordCheckBusyError` and sign-in and sign-up answer 429 "Sign-in is busy. Try again in
  a moment." Accepted trade-off: a flood past the queue refuses sign-ins for as long as it lasts, and never stalls
  the site. Exam: the "password checks" block of `app/api/community/auth/auth.test.ts`.

## Request bodies (request-body.ts)

- Because `src/proxy.ts` runs on every path, Next copies every write body (up to `PROXY_BODY_MAX_BYTES`, 4.5 MiB,
  `experimental.proxyClientMaxBodySize`; the bytes past it are dropped) and waits for its end before any route
  runs. That limit sits just above the largest route cap and must never drop below one: a body cut at it is still
  over every cap and answers 413, not a 400 for a truncated JSON or form. The proxy refuses a declared
  `content-length` over it with 413 before waiting for a byte, in the route's own sentence (`too-big.ts`). A slow
  sender under it is held until it finishes or Node's `requestTimeout` (300 s); only the edge (Caddy's body read
  timeout) bounds that. Route handlers have no body limit, so every route that reads a body reads it through
  `request-body.ts` (`readJsonCapped`, `readTextCapped`, `readFormDataCapped`) with a cap sized to what the client
  sends: a declared `content-length` over the cap is refused without parsing, a chunked body stops at the cap, and
  the answer is 413 with the route's own sentence. The read happens where it happened before, so every gate, 503 and auth check that ran ahead of it
  still does. Caps: feedback `FEEDBACK_MAX_BYTES` (4 MiB); plan uploads and synced designs
  `COMMUNITY_UPLOAD_BODY_MAX_BYTES` (4 MiB of bytes, then the player-facing 3 Mi-character count
  `COMMUNITY_UPLOAD_MAX_BYTES`); board images and plan previews `BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES`
  (the multipart is re-parsed from the capped bytes); blueprint saves `BLUEPRINT_BODY_MAX_BYTES` (2 MiB, the
  payload's own 1.5 MB check stays behind it); comments `COMMENT_BODY_MAX_BYTES` (64 KiB); sign-in, sign-up, votes,
  folders and publish `SMALL_JSON_MAX_BYTES` (16 KiB). A new route that reads a body uses the reader and names its
  cap. Caddy's `request_body max_size` is the edge's copy of the rule, not a substitute. Exam: `request-body.test.ts`
  and the "declared length over the cap" cases in the route tests.

## Uploaded plan stats (plan-engine.ts)

- A community post's stats come from solving the uploaded plan on the request thread, which blocks every other
  request while it runs, so the solve has a budget the board never has: `ensurePlanEngine` sets the process-wide
  HiGHS limits once (`time_limit` 2 s, `mip_max_nodes` 20,000) and `solvePlanStats` rejects every model past 5 s
  (`withLpDeadline`). Past either the stats are the failed plan's and the post is still stored; the stored plan is
  re-solved once per `APP_VERSION` on its first view (`refreshStaleStats`) under the same budget. Every call site
  goes through `solvePlanStats`, never `calculateThroughput` directly. Follow-up: a worker thread, so a slow plan
  never blocks the loop at all. Exam: `plan-access.test.ts` "stores a plan-mode post whose stats solve ran out of
  time".

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
  a minute for the site and 6 a minute per address; 60 refusals in 10 minutes pause reports for 6 hours, each address
  counting at most 3 of them, so a pause takes 20 addresses and one address can never trip it), 3 an hour and 10 a
  day per address and per device, the same words once a month, and at most 10 issues an hour and 40 a day for the
  whole site. Player text is escaped (no pictures, links or HTML in the issue).
- The client address is Caddy's `X-Client-Ip` (Cloudflare's CF-Connecting-IP, trusted only from Cloudflare's
  ranges), then CF-Connecting-IP, each only as an IP literal; nothing else is read (X-Forwarded-For names a
  Cloudflare edge or the client's own chain, nothing sets X-Real-Ip). One module, `client-address.ts`
  (`clientAddress`, re-exported by community.ts), used by every per-address rule on the site; an IPv6 literal is
  keyed on its /64; a request with neither header is `"local"` (`NO_ADDRESS`), which the dataset budget never
  refuses. It is trustworthy only because Caddy is the site's only peer: the unit binds loopback and the firewall
  closes :3000. Exam: `client-address.test.ts`.
- Emergency stop without a deploy: a Caddy rule answering 503 to `POST /api/feedback` (`/etc/caddy/Caddyfile`, then
  `systemctl reload caddy`).
- Plans and the picture go to the private `feedback-files` bucket, served by `/api/feedback/files/<id>/<file>`, only
  once every check has passed; a report whose issue GitHub refuses has its files removed again. An attached plan is
  stored and linked without its task board (`tasks`, `taskItems`, `taskComments`, `primaryView`: account ids, names,
  screenshot files, coordinates) and without `metadata.communityPlanId` (`reportablePlan`); the box says "Tasks and
  comments stay out." The mod strips names, paths and addresses from logs and crash reports before sending.

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
- Stamps are the client's and the newer row wins, so an edit stamp (`updatedAt`, `planUpdatedAt`) more than
  `STAMP_SKEW_MS` (5 min) ahead of the server is refused with 400 "This device's clock is ahead. Check its date and
  time." (designs and folders; `isFutureStamp`): one far-future stamp from a member's wrong clock would otherwise make
  every later save on every device read as behind, silently. Refused, never clamped (the device's local and pushed
  stamps must agree). `createdAt` is never judged: it is sent unchanged on every push, so a clock once ahead would
  refuse the design for good, and nothing orders on it.
- While `live_lease_until` is in the future the live service is the plan's only writer: the PUT refuses a plan body
  (409 `{ live: true }`) and its write is conditional on the lease. Metadata still goes through.
- `GET /api/library` keeps listing tombstones (clients rely on it never to reuse a deleted id) and adds each design's
  `members` and the `shared` plans, in one extra read when nothing is shared.
- Deleting a design deletes its member rows (designs are tombstoned, so the foreign key's cascade never fires) and
  tells the live service; sharing changes tell it too (`notifyLive`, only with `LIVE_INTERNAL_URL` and
  `LIVE_INTERNAL_TOKEN`). A failed notice loses nothing: the service checks membership on every join.
- Account search is limited in memory (`memory-rate.ts`): a share box asks on every keystroke. A prefix is two
  characters at least (the box asks from the second), so one character does not list a thirtieth of every account.
- Exam: `app/api/library/cloud-plans.test.ts` (against the local database).
