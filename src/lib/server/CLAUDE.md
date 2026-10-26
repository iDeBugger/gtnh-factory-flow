# Server and API (src/lib/server, src/app/api)

## Recipe queries (dataset-query.ts)

- A query is clauses (`role:kind:id`, `src/lib/datasets/recipe-query.ts`) plus
  `takesOp` / `makesOp` (any / all / only) and the map selection. The server does set
  algebra over the lookup index (`getClauseLookupRecipesByMap`): any = union,
  all = intersection, sides intersect. Every clause gets the concrete-context rewrite
  (`applyClauseResourceContexts`).
- ONLY is verified against recipe bodies (`recipeIsOnlyMatch`) up to `ONLY_VERIFY_LIMIT`
  candidates, then degrades to ALL. Non-consumed inputs never count against takes-ONLY.
- A ranked recipe search is kept (`rankedRecipeSearches`, lookup path only): every match's index in page order
  (an `Int32Array`), the map list and counts and the search outcome, never bodies; a page is a slice with its
  summaries read then. Keyed by `rankedRecipeSearchKey`: the answer version, the dataset build, the parsed query
  text (case and outer spaces folded), the clauses, side ops, all-maps flag, map selection, map and tier; offset and
  limit are not in it, so every page of a search is one entry. Bounded at `RECIPE_SEARCH_CACHE_BYTES` (32 MB) by
  `rankedRecipeSearchBytes` (4 bytes a match, each map's name and count, the corrections; the widest, "s" over 2.9,
  is about 1.1 MB). Two identical searches ranking at once share one ranking (`keptRecipeSearch`). Module scope, not
  `globalThis`: only the recipes route fills it, and a dev reload of search code starts it empty. Measured on 2.9:
  "s" 219 ms uncached, 0.6 ms kept; "st" 186 ms, 7 ms. The route's base cost is spent before the lookup, so a kept
  answer still pays it. Exam: `dataset-query.test.ts` "the kept recipe searches", `recipes/route.test.ts`, the
  golden harness (its second pass reads the kept searches).
- All-maps answers page through `recipeMaps` in chip order, best match first inside each
  map (`orderByRecipeMap`).
- Every dataset answer is the dataset's bytes run through server code, so every dataset request carries two
  cache keys (`addDatasetCacheKey` in `browser-loader.ts`): `datasetHash` and the answer version
  (`appVersion=<build>`, `src/lib/datasets/answer-version.ts`). The answer version is the build, not the release
  number: `next.config.ts` bakes `NEXT_PUBLIC_GTNH_BUILD_ID` into the server and browser bundles, from
  `GTNH_BUILD_ID` (the deploy's `<version>-<sha8>`, the value `/api/version` reports; an image built from `git
  archive` has no git, so its Dockerfile must pass `ARG GTNH_BUILD_ID` to the build) or else
  `<APP_VERSION>-<git sha8>` (`-dirty` with uncommitted changes), or `APP_VERSION` with neither. A deploy must
  set `GTNH_BUILD_ID` or build inside a git checkout: with neither, two deploys under one `APP_VERSION` share
  year-immutable answer URLs, and browsers keep the older build's answers. `next.config.ts`
  imports nothing from `src/` (it reads `version.ts` as text): `next start` loads it again at run time and the site
  image ships no `src/`. Its own modules sit beside it and import nothing (`security-headers.config.ts`,
  `body-limits.config.ts`, which `http/request-body.ts` re-exports); the image must copy them with it
  (`next-config.test.ts` pins it). `datasetCacheHeaders` marks an answer immutable for a
  year only when both keys are there and the version is this build's; anything else is `no-store`, so no build that
  changes a ranking is served from another build's URL, even under one APP_VERSION. Exam:
  `http/dataset-cache-headers.test.ts`, `browser-loader.test.ts`.
- A new catalog field must be added to `getDatasetCatalog`'s explicit field list (and
  `RecipeDataset` in types.ts) or it never reaches the client.
- Dataset files other than textures may be replaced in place; textures are
  cache-immutable, so a changed icon needs a new name. The index gzips and the shards are therefore served for a
  day (`DATASET_FILE_CACHE_CONTROL`), never `immutable`; the manifest stays `max-age=0`.
- Next's public handler serves everything under `public/datasets/gtnh` before any route, by the DECODED path, with
  a cache policy it can only set by path (a 404 would be cached like the file). A rewrite matches the path as
  sent, so a rewrite alone is bypassed by percent-encoding (`recipes%2Ejson`). The gate is `src/proxy.ts`
  (`decideDatasetPath`, `dataset-path-gate.ts`), which runs on every request path but `/_next/`: under
  `/datasets/gtnh/` (decoded) it refuses a path that is percent-encoded at all or holds a `.` or `..` segment
  (400 `no-store`), sends the four index gzips, the shards, `client/` and `recipes.json` to
  `src/app/dataset-files/[versionId]/[...assetPath]/route.ts` (a day's cache, ETag, Last-Modified and one byte
  range on a file; `no-store` on 400 and 404; `recipes.json`, about 2 GB, refused), and lets everything else
  through to the public handler: textures (`immutable` by `next.config.ts` header rule), `oracle/`, stray copies,
  at `max-age=0`. The gate is one process's view of a path: the raw `recipes.json` must still not exist on the
  server, and the publish must not copy it (`tools/deploy/publish-datasets.sh` excludes it and checks). It also makes a pipeline invariant: published names stay within
  `[A-Za-z0-9._-]` (`tools/dataset-pipeline/CLAUDE.md`; `rebuild-manifest.mjs` refuses a version that breaks it),
  or the file is unreachable. The dataset-files and textures routes resolve a file with `resolveDatasetChildPath`
  (dataset-static-file.ts): lexically, then by real path against the real version directory, so a symlink in the
  tree never reads outside it (a miss is a 404). Exam: `dataset-path-gate.test.ts`, `proxy.test.ts`,
  `dataset-files/[versionId]/[...assetPath]/route.test.ts`, `dataset-static-file.test.ts`.
- The answers every player gets the same (catalog, mobs, crops, recipe-ids, items) are also static files the server
  writes itself (`client-files.ts`, `dataset-client-files.ts`), served at `/datasets/gtnh/<id>/client/<kind>.<20 hex
  of the sha256 of the JSON>.json` but stored outside the dataset tree, which stays the pipeline's bytes and may be
  mounted read-only: in `GTNH_CLIENT_FILES_DIR/<id>/` (a writable volume in a container), by default
  `.cache/client-files/<id>/` under the working directory (gitignored). Each as `.gz` (level 9) and, except the id
  list (23 s of brotli for 13%), `.br`: quality 11 with a 4 MB window for the small ones, 9 with 16 MB for the item
  search file (1.96 MB in 1.1 s at +85 MB of RSS, against 1.74 MB in 14 s at +201 MB at 10; gzip 2.77 MB). The server
  writes them, not the pipeline, because each is the dataset run through server code; a deploy that changes the JSON
  changes the name. With `GTNH_PREWARM_ON_STARTUP=1` they are written after the default version's prewarm, in the
  background, one at a time on the thread pool (`writeServedDatasetClientFiles`); otherwise on the first listing
  request. A file already there is only touched; one no start has named for 30 days is removed. The browser reads `GET
  /api/datasets/<id>/client-files` (1 unit; `no-store` until every file is written, then cached like a dataset answer)
  and fetches each listed file through the gate and the dataset-files route (`immutable` for a year, brotli or gzip by
  Accept-Encoding, ETag `"<hash>-<br|gz>"`; resolved by real path like the dataset files, so a link out of the
  version's directory is a miss); with no listing, a kind not listed or a failed file it asks the API as before, and
  the API routes stay for old tabs; a listing that is incomplete or failed is reused for 45 s before the browser asks
  again (`CLIENT_FILE_LISTING_RETRY_MS`). A write that fails (an unwritable cache directory) is logged and the site
  keeps the API. Each start also removes the directories of versions it no longer serves
  (`removeUnservedClientFileDirectories`), and never what it did not write. The site claims a root only when it
  creates it or finds it empty (a filesystem's `lost+found` aside; `claimClientFilesRoot` writes the marker
  `.gtnh-client-files`, a regular file: the claim and the sweep take a link or a directory of that name as no marker);
  a root that holds anything else and no marker is not the site's: it is logged once and nothing is written or swept
  there, so the API answers. The sweep runs only in a marked root with a served version, removes only a non-empty
  directory holding nothing but client files and their temporaries (never an empty one, a link, or what a link points
  at), and logs and skips a directory it cannot read or remove. Exam: `client-files.test.ts`,
  `dataset-client-files.test.ts`. Outside production each load of the module keys its own listing, so a dev reload of
  answer code never lists the old code's files. Exam: `client-files.test.ts`,
  `dataset-files/[versionId]/[...assetPath]/client-files.test.ts`,
  `api/datasets/[versionId]/client-files/route.test.ts`, `browser-loader.test.ts`.
- Every server cache is bounded or index-sized (the Node heap is capped at 3 GB). A slow
  site: check the heap first.
- The OG card route reads fonts through `process.cwd()` (non-standalone build).
- The image optimizer is off (`images.unoptimized` in next.config.ts): nothing uses next/image, and
  `/_next/image` would hand any same-origin PNG (uploads, dataset textures) to sharp. Pictures are served
  by the app's own routes or plain `<img>`; keep it that way.
- Every answer carries the security headers of `security-headers.config.ts` (beside next.config.ts, which builds
  them into the routes manifest at build): one Content-Security-Policy, `X-Frame-Options: SAMEORIGIN`, nosniff,
  `Referrer-Policy`, the one HSTS value; `X-Powered-By` is off. The policy allows only the site's own origin for
  scripts, styles, fonts, fetch/WebSocket and workers (`blob:` workers too), `data:`/`blob:`/`https:` images,
  and no framing by other origins; `NEXT_PUBLIC_SITE_URL` at build adds the site's own `wss://` origin to
  `connect-src` (WebKit before CSP3 did not match a socket with `'self'`). `NEXT_PUBLIC_MOD_AND_COMMUNITY=on`
  at build adds the mod's ten loopback origins, `http://127.0.0.1:25640` to `:25649` ("Open in the mod"); off,
  the policy names no loopback origin. `/_next/static/*` gets a second policy with `'unsafe-eval'`: the solver
  worker evaluates the HiGHS glue, and a worker's policy is its own script's response (a later rule overrides
  the same key). A third-party script, font, socket or frame needs a change there first, or the browser
  refuses it. Exam: `security-headers.test.ts`, `next-config.test.ts`, probe `scratch/probes/csp-headers.mjs`.
- A route's `catch` answers through `http/error-response.ts`: `serverErrorResponse` gives the route's own fallback
  sentence and logs the error (a database or file system message names tables or the release path); the one
  sentence passed on is `COMMUNITY_DB_DOWN_MESSAGE`. Dataset routes use `datasetErrorResponse`: an unserved id
  (`DatasetNotFoundError`) is 404 `Dataset not found.`, never the id. The library's and blueprints' failures answer
  through `storageErrorMessage` the same way (the route's sentence, or the database-down line); fixed 4xx copy stays
  as it is. Exam: `error-response.test.ts`, `datasets/[versionId]/catalog/route.test.ts`.
- Every dataset route except `prewarm`, and `/api/resource-popularity` (the browser item search's popularity map,
  1 unit, outside `/api/datasets/` so an edge rule on that prefix does not cover it), spends an in-memory work
  budget per client address (`limits/dataset-rate.ts`):
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
  budget (`0` disables). Floods from many addresses are the edge's (Cloudflare's rate rule, once the public site is behind it). Exam: `dataset-rate.test.ts`,
  `recipes/route.test.ts`, `src/lib/datasets/browser-loader.test.ts`.
- `resolve-recipes` takes at most `RESOLVE_RECIPES_MAX_REFS` (2,000) refs in a body of at most
  `RESOLVE_RECIPES_MAX_BYTES` (2 MiB), each ref shape-checked by `recipe-ref-schema.ts` before the resolver sweeps
  the index (a bad ref is 400, never a 500 with the matcher's error text); the resolver gets the array as it came,
  so the fields the matcher reads and the schema does not name pass through. The browser sends
  `RESOLVE_RECIPES_CHUNK_REFS` (500) at a time, in order (`src/lib/datasets/resolve-recipes-limits.ts` holds all
  three numbers). Exam: `resolve-recipes/route.test.ts`, `src/lib/datasets/browser-loader.test.ts`.
- Item search runs in the browser too. `src/lib/search/resource-search.ts` is the one copy of the item search
  (index build, scoring, phases, sorts, page, request parsing); the `/resources` route runs it over the loaded
  catalog (`queryCatalogResources`, with its blank-list cache) and the browser runs it in a Web Worker
  (`resource-search.worker.ts` over `resource-search-engine.ts`) over the version's `items` client file
  (`getDatasetResourceSearchFile`: the catalog's `resourceIndex` exactly as the route returns its entries, the
  made/used counts and the crop and bee keys of listed resources, `schemaVersion` 1, which a worker checks; 23 MB of
  JSON, about 2 MB brotli on 2.9). The worker answers with the route's JSON, so the page cannot tell which side
  answered. `browser-loader.ts` starts it on the first typed item query for a version, never on opening a plan or
  for the untyped list a pane shows on opening (one kept server answer), for one version at a time (another
  version's query ends it; the next typed query starts that version's: two indexes would hold twice the memory).
  Measured in headless Chromium through CDP (`scratch/probes/worker-heap.mjs`): the worker's JS heap after a GC is
  62 MB with the 2.9 index built, 64 MB after a few searches. Never where the browser reports under 4 GB
  (`navigator.deviceMemory`, Chromium only). The worker answers one query a task, so an aborted query is dropped
  before it runs even while another walks. Until it is ready, for
  a popular sort before the popularity map has arrived (`/api/resource-popularity`, the same 30-minute policy as a
  popular `/resources` answer), and after any failure, the API answers. The route stays for old tabs, the
  fallback and bots, with its budget. A change to the item search must keep both sides equal: `resource-search-engine.test.ts`
  (in the suite, every sort, kind, source, mod and page on a small catalog) and
  `src/lib/search/resource-search-parity.local.test.ts` (the installed 2.9 and 2.8.1: 11 queries each with total,
  the first 120, order and respelling, then 280 sort, kind, source, mod and page combinations). The popularity
  sweep's state is on `globalThis` (`resource-popularity.ts`) so the two routes reading it share one sweep.
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
  - process RSS stays under about 80% of the site container's memory limit (4 GB, `docs/deploy.md`; measured at
    1.35 GB with both versions prewarmed in the rehearsal). Check `docker stats` on the server before a deploy that
    adds a version; these numbers are from a dev machine.
  Both hold: both versions are prewarmed in full. If one fails, 2.8.1 is prewarmed second with its catalog
  only. Measure again when a dataset grows or a third version is served.

## Database (db/, repos/, services/)

Layout: the database client, its breaker and its error copy in `db/` (import it as `@/lib/server/db`);
passwords, sessions, the admin header and salted keys in `auth/`; rate limits and the event log in `limits/`;
plan row mapping in `community-rows.ts`; route plumbing in `http/` (request bodies, error answers, the client
address, dataset cache headers, the mod and community gate, `readViewer`, `serviceResponse`). Queries live in `repos/` (one file per table family:
`accounts`, `events`, `designs` with every lease write, `design-members`, `folders`, `plans`, `comments`, `votes` (posts), `blueprints`, `popularity` (the sweep's pages),
plus `visibility.ts`, the access rules as query filters), the rules in `services/` (`accounts`, `library`,
`community-plans`, `comments`, `votes` (the vote algorithm for posts, `castVote`), `blueprints`; `access.ts` holds each access rule once, as a pure function: `canSeePlan` is the one
answer to "who may see an unpublished post"; the live service's `PlanStore` is an adapter over the same
repositories), which return `ServiceResult`
(`services/result.ts`) and never import `next/*`; a route only gates, parses, calls the service and answers
(`serviceResponse`). A route asks whether there is a database through `services/config.ts`, never `db/`. Routes read
plan previews and the popularity map through `services/plan-preview.ts` and `services/resource-popularity.ts`.
The live service loads the repositories, `services/design-role.ts`, `auth/{session,secret,sessions}` and `db`,
never password code.

Import rules, held by `src/architecture.test.ts` (AGENTS.md "Layers" has rules 1 to 9) with no allowlist entries:
- 10. Services import from `lib/server` only services, repositories, `auth/`, `limits/`, `db/index.ts`,
  `http/{viewer,client-address}.ts`, `live-notify.ts` and the query-free helpers `isServiceTarget` names
  (`community-rows`, `library`, `cloud-plans`, `blueprints`, `plan-list-cache`, `plan-engine`, `file-store`).
- 11. The data layer (`db/`, `repos/`) never imports services, `auth/`, `limits/`, `http/` or `live-notify.ts`,
  and `db/` never imports `repos/`.
- 12. Only services, `auth/`, `limits/`, the data layer and `live/store.ts` import a repository at run time
  (a type-only import of a row shape is fine outside `src/app`), so a route reaches queries through a
  service. Under `src/app` even a type-only import of a repository is refused (rule 4 and the app query
  check): routes take row types from services or contracts.
- 13. `src/` never imports `tools/`.

Checks with no exceptions at all:
- Outside the data layer no file sends a query (`.from("`, a Kysely builder) or takes `getDb` from
  `db/index.ts`, statically, by `import()` or by `require`.
- Services take from `db/index.ts` only `withTransaction`, `Tx` and the failure types and sentences;
  `services/config.ts` also takes the configured check.
- No data-layer module but `db/index.ts` and `db/client.ts` exports a handle (`getDb`, `createDbClient`, `sql`,
  `CompiledQuery`) or uses `export *`.
- What the test reads as SQL writing, from the syntax tree: a `sql` template only in the data layer. Only in
  `db/migrations.ts`: `sql.raw`, `sql.ref`, `sql.id`, `sql.lit`, `sql.table`; Kysely's `sql` other than as a tag or
  a call's object (assigned, destructured, indexed) or under another name; `dynamic` by any path;
  `CompiledQuery` as a value (and outside `db/` at all); a namespace or dynamic import of kysely. A sort column
  comes from a closed map and goes through the builder, never through these.

Every repository goes to Postgres directly (`getDb` at `DATABASE_URL`, see Local database below): accounts, the event
log, the library (designs with the live lease, members, folders), community posts, their comments, blueprints, the
votes on posts, and the reads of the public posts by the popularity sweep, the sitemap and
llms.txt. The live service's queries are all among these, and it refuses to start without `DATABASE_URL`
("No database: set DATABASE_URL."); `services/config.ts` answers "configured" exactly when `DATABASE_URL` is set.
No other database client exists: `db/no-postgrest.test.ts` fails on any file under `src/` or `tools/` that names
the PostgREST client, its stand-in or their settings, except the startup checks and the deploy files the stack's
cutover removes. Community posts (`repos/plans.ts`,
`repos/comments.ts`; exam `plan-access.test.ts`, the Postgres cases in `services/community-plans-postgres.test.ts`):
- The list's page and its `total` are two statements over one condition, run on one read-only `repeatable read`
  snapshot (`withTransaction(work, { readSnapshot: true })`): the total never disagrees with the rows, and a page
  past the end still counts every post. Tag and text terms are `ilike` patterns with `\`, `%` and `_` escaped
  (`repos/like.ts`), bound like every other term (`repos/search.ts`, exam `search.test.ts`); make and take are
  `@>` against `json([key])`.
- A failed read of a post throws, so a detail, edit, delete, download or preview upload during an outage answers
  the route's sentence or the database-down line, never "Plan not found."; only a stale stat card's refresh and
  its write, and the list's version dropdown (logged, an empty set, not cached), are best effort.
- A view and a download are one `update ... + 1 ... returning` each, with `planVisibleTo(viewer)` in its `where`:
  concurrent counts all land, and a post the viewer may not see counts nothing.
- A comment's insert or delete and its post's recount (one `update ... from (select count(*), max(created_at))`)
  are one transaction, after `plans.lockPost` (`for no key update`), so a recount sees every comment committed
  before it (the Postgres case of ten comments at once fails without the lock). A comment on a post taken down
  since the access read finds no row to lock and answers the route's 404.
- A vote (`repos/votes.ts`, `services/votes.ts`) is one transaction: `votes.lockParent` (`for no key update` on the
  post, first, as a comment takes it), the vote row's upsert or delete, then one recount
  `update ... set upvotes = (select count(*) ...), downvotes = (...) returning`. Without the lock concurrent votes
  leave stale counters on Postgres; PGlite never overlaps transactions, so the race is pinned by
  `services/votes-postgres.test.ts` and the lock order by recorded statements in `plan-access.test.ts`. A row taken down since the access read answers the route's 404.
Blueprints (`repos/blueprints.ts`, `services/blueprints.ts`; exam `blueprints/route.test.ts`,
`blueprints/by-id.test.ts`, the Postgres cases in `services/blueprints-postgres.test.ts`):
- A blueprint is its owner's alone: the list, a read by id, an edit and a delete all name the session's account in
  their `where`; anyone else, signed in or not, finds "Blueprint not found." (an anonymous read sends no query),
  whatever the community switch says. There is no public shelf: no list or search of other accounts' blueprints, no
  publishing, no votes and no downloads (`?scope=public` answers 404 "There is no public blueprint list." and sends
  no query). The table keeps `is_public`, `downloads` and `blueprint_votes` as they stand, and the summary keeps
  their fields, so the own list's answer is unchanged.
- A save is one transaction: the account row's lock (`accounts.lockAccount`, `for no key update`, as a new design
  takes it), the count, then the insert, so saves at once meet the cap (`BLUEPRINT_MAX_PER_USER`) one at a time; a
  failed count throws and answers the save's sentence, never reads as none. PGlite never overlaps transactions, so
  `blueprints/route.test.ts` pins the statement order and `services/blueprints-postgres.test.ts` races 20 saves for
  the last place on Postgres.
Rules:
- Every query has the pool's limits (`db/settings.ts`: 5 s to get a connection, 15 s statement timeout on the
  server, 20 s on the client), so a stalled database fails as down instead of holding a request open.
- After 5 down failures in a row the breaker fails every query at once for 15 s without sending
  (`db/guard.ts`, `db/breaker.ts`): a stalled database recovers only once demand drops, and every tab keeps asking.
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTGREST_URL`, `POSTGREST_SERVICE_TOKEN` and `LOCAL_DB` are not read;
  the startup checks warn when one is set, and in production when `DATABASE_URL` is not.
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
  rows once an hour per process, oldest first in batches of `PRUNE_BATCH_ROWS` until one comes back short or
  `PRUNE_BUDGET_MS` (2 s) has gone (so a backlog drains fast yet never holds a request past the statement timeout;
  the rest waits an hour), over the `created_at` index (`community_events_created_at_idx`), and a failed prune never
  fails a save. Exam:
  `community-events.test.ts`.

## Sessions and secrets (auth/)

- `sessionSecret()` is the one owner of `COMMUNITY_HASH_SALT`: the session HMAC, `saltedKey` (rate-limit and voter
  keys) and nothing else read it. In production a missing, blank or development value throws
  "Sign-in is not set up on this server." at the call, so a server without the secret has no sign-in, library or
  blueprints while the planner keeps serving; outside production the public development secret applies, so a
  checkout signs in with no setup. Never add a second read of the variable or a second default. The live service
  exits without it (`src/live/main.ts`); the two must carry the same value.
- The startup checks warn about a missing or short secret and never throw for it (`startup-checks.ts`).
- A token is `<userId>.<expiresMs>.<epoch>.<hmac>`; the epoch is the account's `session_epoch` at sign-in, and
  `getSessionUser` refuses a token whose epoch differs from the row's. "Sign out everywhere" (`POST
  /api/community/auth/logout` with `{ everywhere: true }`) sets the row's epoch to now (`bumpSessionEpoch`), forgets
  the cached account and tells the live service (`notifyLive` signed-out). A three-part token from before epochs
  reads as epoch 0 and stays good until it expires or the account signs out everywhere. The column is in
  `db/migrations/0001-baseline.sql`; the account lookup selects it, so a database without it answers 503 to every
  signed-in request. Exam:
  `session.test.ts`, `app/api/community/auth/auth.test.ts`.
- Every database-backed limit counts then records, so `checkRateLimit` runs one at a time per key and action
  (`serially`); a burst for one key is counted one by one. The site is one process, which is what makes the
  in-process queue enough. Sign-in has two limits: 20 attempts per address in 10 minutes (successes included) and
  10 failures per account in 15 minutes from any address (unknown names counted alike, so the limit names no
  accounts); the account count runs inside the same critical section as the lookup and the record. Exam:
  `rate-limit.test.ts`, `app/api/community/auth/login/route.test.ts`.
- A rate-limit key never holds a string the client chooses: `makeActorKey(request)` is the salted address alone, and a
  signed-in write is keyed `user:<id>` (the community plan POST: 10 an hour per account). A device id in a key is a
  fresh count per made-up id. Board images (`limits/image-upload-guard.ts`, open to anonymous players) are 30 an hour and 60
  a day per address and 120 an hour and 400 a day for the whole site, counted after the size and magic-byte checks so
  junk spends no share. A vote lands only on a post that exists and is public (or the voter's own), with the same
  404 either way and a fixed 500 sentence, so the route is no oracle for ids; an anonymous address casts or switches
  at most 3 votes a day on one post (`VOTES_PER_ADDRESS_PER_PLAN_PER_DAY`; accounts are exempt). The
  `plan-previews` bucket is private and its pictures are served only by `GET .../preview`, which answers an
  unpublished post's picture to its owner and the admin alone (`Cache-Control: private, no-store`) and 404 `No preview.`
  to everyone else.
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

## Request bodies (http/request-body.ts)

- Because `src/proxy.ts` runs on every path, Next copies every write body (up to `PROXY_BODY_MAX_BYTES`, 4.5 MiB,
  `experimental.proxyClientMaxBodySize`; the bytes past it are dropped) and waits for its end before any route runs.
  That limit sits just above the largest route cap and must never drop below one: a body cut at it is still over every
  cap and answers 413, not a 400 for a truncated JSON or form. Next awaits the body's end even when the proxy answers
  itself, so a declared length that never arrives, or a slow sender, is held until it finishes or Node's
  `requestTimeout` (300 s); only the edge (Caddy's body read timeout) bounds that. Route handlers have no body limit,
  so every route that reads a body reads it through `http/request-body.ts` (`readJsonCapped`, `readTextCapped`,
  `readFormDataCapped`) with a cap sized to what the client sends: a declared `content-length` over the cap is refused
  without parsing, a chunked body stops at the cap, and the answer is 413 with the route's own sentence. The read
  happens where it happened before, so every gate, 503 and auth check that ran ahead of it still does. Caps: plan uploads and synced designs `COMMUNITY_UPLOAD_BODY_MAX_BYTES` (4 MiB of bytes,
  then the player-facing 3 Mi-character count `COMMUNITY_UPLOAD_MAX_BYTES`); board images and plan previews
  `BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES` (the multipart is re-parsed from the capped bytes); blueprint
  saves `BLUEPRINT_BODY_MAX_BYTES` (2 MiB, the payload's own 1.5 MB check stays behind it); comments
  `COMMENT_BODY_MAX_BYTES` (64 KiB); sign-in, sign-up, votes, folders and publish `SMALL_JSON_MAX_BYTES` (16 KiB). A
  new route that reads a body uses the reader and names its cap. Caddy's `request_body max_size` is the edge's copy of
  the rule, not a substitute. Exam: `request-body.test.ts` and the "declared length over the cap" cases in the route
  tests.

## Uploaded plan stats (plan-engine.ts)

- A community post's stats come from solving the uploaded plan on the request thread, which blocks every other request
  while it runs, so the solve has a budget the board never has: `ensurePlanEngine` sets the process-wide HiGHS limits
  once (`time_limit` 2 s, `mip_max_nodes` 20,000) and `solvePlanStats` rejects every model past 5 s
  (`withLpDeadline`). A model whose LP hits the time limit stops there (no other HiGHS setting is tried), so one solve
  holds the thread at most 5 s plus one LP's 2 s. Past either the stats are the failed plan's and the post is still
  stored; the stored plan is re-solved once per `APP_VERSION` on its first view (`refreshStaleStats`) under the same
  budget; a refresh the clock stopped (`solvePlanStats(...).outOfTime`, from `lpTimeBudgetHits`) keeps the stored
  stats and tries again on a later view. The solver's island cache never keeps an island the clock stopped, so a busy
  moment cannot fix a failed answer for the life of the process. Every call site goes through `solvePlanStats`, never
  `calculateThroughput` directly. Follow-up: a worker thread, so a slow plan never blocks the loop at all. Exam:
  `plan-access.test.ts` "stores a plan-mode post whose stats solve ran out of time" and "keeps a stored post's stats
  when a refresh of them runs out of time" (the real `solvePlanStats`, its budget set per case),
  `plan/lp-deadline.test.ts`.

## The mod and community switch (deployment-features.ts)

- `isModAndCommunityOn()` is true only when `NEXT_PUBLIC_MOD_AND_COMMUNITY` is `on`; unset or anything else is off.
  Off, every `/api/community/plans/**` route and `/community` answer 404 (`modAndCommunityOffResponse`);
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

## Client address (http/client-address.ts)

- The client address is Caddy's `X-Client-Ip` (its `client_ip`: the peer, or behind Cloudflare its
  CF-Connecting-IP, trusted only from Cloudflare's ranges), then CF-Connecting-IP, each only as an IP literal; nothing else is read (X-Forwarded-For names a
  Cloudflare edge or the client's own chain, nothing sets X-Real-Ip). One module, `http/client-address.ts`
  (`clientAddress`), used by every per-address rule on the site; an IPv6 literal is
  keyed on its /64; a request with neither header is `"local"` (`NO_ADDRESS`), which the dataset budget never
  refuses. It is trustworthy only because Caddy and the stack's own containers are the site's only peers: compose
  publishes the site on `127.0.0.1:3300` only and the firewall drops outside traffic to it (`docs/deploy.md`). Exam: `client-address.test.ts`.

## Uploaded files (file-store.ts)

- Board images and plan previews live in a directory, `FILE_STORE_DIR` (a volume in production; outside
  production `scratch/local-db/files` when unset), one folder per bucket: `board-images`, `plan-previews`. Nothing there is a static file: each bucket is served only by its own route. Board images by
  `GET /api/community/images/<YYYY-MM>/<18 hex>.<png|jpg|gif|webp>` (any other name 404, `immutable`, nosniff,
  one unit of the address's dataset budget per read),
  previews by the post's preview route after its access check.
- A key is one to three plain segments, none starting with a dot (`FILE_KEY`), resolved inside its bucket, else
  `FileKeyError`. Each bucket has a size cap (`FILE_BUCKET_MAX_BYTES`). A write lands whole (temp file, then link or
  rename); `overwrite: false` refuses an existing key. Directories `0700`, files `0600`.
- The board image upload answers an absolute URL from `siteUrl()` (the annotation schema takes only `http(s)://` or
  `data:image/`), so a picture names the host it was uploaded to.
- Exam: `file-store.test.ts`, `app/api/community/images/[month]/[name]/route.test.ts` ("serves only board images by
  their exact name"), `plan-access.test.ts` ("keeps previews out of every public route").

## Local database (`npm run dev:local`, tests)

- Never copy `.env.local` into a worktree: local work needs no database credentials.
- The client (`getDb`, Kysely over `pg`, `db/client.ts`) reads `DATABASE_URL`; pool sizes and timeouts are
  `db/settings.ts`. Values parse the same on `pg` and PGlite (`DB_TYPE_PARSERS`: timestamptz as Postgres's JSON
  text, bigint as a number); a jsonb column takes only `json(value)`. Row types are generated (`npm run db:types`,
  `db/schema.test.ts` fails while `db/schema.ts` is stale).
- The schema is `db/migrations/NNNN-words.sql`, applied once each by the runner (`db/migrations.ts`,
  `tools/db/migrate.ts`; docs/deploy.md, Migrations). A change is a new file, never an edit to an applied one (the
  runner refuses a changed file by name); a new table gets its grants in `db/grants.sql` in the same commit; then
  `npm run db:types`. Exam: `db/migrations.test.ts`, `db/db-roles.test.ts`.
- Tests open an in-memory PGlite per file, built by `applyMigrations` from `db/`, with `useTestDb()`
  (`src/test-support/test-db.ts`), and fail queries with `withDbFault`.
- `npm run dev:local` gives Next and the live service `DATABASE_URL=postgres://postgres@127.0.0.1:54330/postgres`,
  served by `tools/local-db/serve.ts`: the compose file's pinned `postgres` image in the container `gtnh-local-db`
  when Docker answers (serve.ts applies the migrations to it), else PGlite on disk (`scratch/local-db/pgdata`) behind
  its socket, whose multiplexer is not isolated under concurrent queries (serve.ts has the probe).
  `LOCAL_DB_PGLITE=1` forces PGlite. The container's volume and `scratch/local-db/pgdata` are two separate
  databases, so switching between them shows different accounts and designs. A local database with tables but no
  migration ledger is refused, and serve.ts names what to remove to start it fresh. serve.ts's control listener on
  127.0.0.1:54329 answers `/__local-db/ready` and `/__local-db/shutdown` only. Files are not in the database:
  `npm run dev:local` keeps them in `scratch/local-db/files` (the file store below).

## Cloud plans (services/library.ts, repos/designs.ts, app/api/library, app/api/accounts)

- A design id is unique per owner only: every route under `/api/library/designs/[id]` takes `?owner=<ownerId>`
  (absent: the caller's own). Owners and members read; members save the plan and its name, never the owner's folders,
  order or stars; only the owner shares, unshares and deletes; a member leaves by removing themselves.
- Stamps are the client's and the newer row wins, so an edit stamp (`updatedAt`, `planUpdatedAt`) more than
  `STAMP_SKEW_MS` (5 min) ahead of the server is refused with 400 "This device's clock is ahead. Check its date and
  time." (designs and folders; `isFutureStamp`): one far-future stamp from a member's wrong clock would otherwise make
  every later save on every device read as behind, silently. Refused, never clamped (the device's local and pushed
  stamps must agree). `createdAt` is never judged: it is sent unchanged on every push, so a clock once ahead would
  refuse the design for good, and only the owner's own shelf sorts on it, by their own stamp.
- While `live_lease_until` is in the future the live service is the plan's only writer: the PUT refuses a plan body
  (409 `{ live: true }`) and its write is conditional on the lease. Metadata still goes through.
- Each save, creation, share and delete is one transaction (`withTransaction`): a design or folder save reads its row
  `for update`, so two saves cannot both pass the "behind" check; a new design or folder locks the account row first
  (`accounts.lockAccount`, `for no key update`, which foreign-key checks never wait for), so creations at once meet the cap one at a time; a
  share locks the design row before counting members; a delete tombstones the design and drops its members together. A
  lease renewal or flush is one statement that also reads the row (locking), so a miss says "gone" or "lost" from the
  row's newest version. `store-grants.test.ts` runs every `PlanStore` call as `gtnh_live`. PGlite runs one transaction
  at a time, so `cloud-plans.test.ts` pins the lock statements themselves; `services/library-postgres.test.ts` races
  creations on a real Postgres (with `GTNH_TEST_POSTGRES_URL`).
- `GET /api/library` keeps listing tombstones (clients rely on it never to reuse a deleted id) and adds each design's
  `members` and the `shared` plans, in one extra read when nothing is shared.
- Deleting a design deletes its member rows (designs are tombstoned, so the foreign key's cascade never fires) and
  tells the live service; sharing changes tell it too (`notifyLive` in `live-notify.ts`, only with `LIVE_INTERNAL_URL` and
  `LIVE_INTERNAL_TOKEN`). A failed notice loses nothing: the service checks membership on every join.
- Account search is limited in memory (`limits/memory-rate.ts`): a share box asks on every keystroke. A prefix is two
  characters at least (the box asks from the second), so one character does not list a thirtieth of every account.
- Exam: `app/api/library/cloud-plans.test.ts` (against the local database).
