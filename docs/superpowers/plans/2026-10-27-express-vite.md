# Express 5 + Vite instead of Next.js: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The site runs on Express 5 with a Vite client build instead of Next.js. Players see the same thing, every
API answer is the same bytes (one named exception), and the live service is unchanged.

**Architecture:** The 39 route handlers keep their web `Request`/`Response` signature. A thin adapter
(`src/server/http/adapter.ts`) mounts them on an Express app (`createApp()`) with an explicit route table. The
Express app's first middlewares do, in Next's order, what Next did without being asked:
- the 308 for repeated slashes and backslashes, then for a trailing slash;
- security headers on every other answer;
- the dataset path gate and the cross-site write check;
- case-sensitive strict routing;
- 404, 405 and OPTIONS as Next answers them;
- Next's own 500.

Vite builds the browser bundle from `src/client/index.html`. A build step prerenders the shell with
`renderToString`, so first paint is the same as today, and the client calls `hydrateRoot`. Per request the server
injects only the `<head>` (site or per-plan metadata). esbuild bundles the server, the same way `build:live` does
today. Caddy does compression (an infra change). Next stays buildable beside Express until the cut task, so every
task is green on its own.

**Tech Stack:** Express 5.3.0, Vite 8.3.4 (already installed), @vitejs/plugin-react 6.1.2, @tailwindcss/vite 4.3.0,
@vercel/og 1.0.3, esbuild 0.28.2 (installed), React 19.2.4, TypeScript strict, Vitest.

**Spec:** `.superpowers/manager/gtnh-281/reports/express-assessment.md` (inventory §1, implicit behaviours §1.3,
risks §3, steps §4) and the brief `.superpowers/manager/gtnh-281/briefs/express-plan.md` (intents and owner answers).
The review `.superpowers/manager/gtnh-281/reviews/express-plan-r1.md` and its rulings are folded in. Executors read
the spec and the brief, plus AGENTS.md, `src/lib/server/CLAUDE.md` and `docs/deploy.md`.

## What changed since the assessment (main at 3a41db6d)

The assessment read `main` at 5be99d75 and the `db-direct` worktree. Rechecked at 3a41db6d:

- **Routes.** db-direct has landed. There are 39 `route.ts(x)` files (38 under `api/`, `dataset-files/` and
  `datasets/`, plus `llms.txt`), 2,512 lines. Next to them are:
  - the 3 metadata files (`sitemap.ts`, `robots.ts`, `manifest.ts`);
  - 2 pages (`page.tsx`, `community/page.tsx`) and the dev page `dev/clean-card`;
  - the file conventions `favicon.ico` and `opengraph-image.png` (+ `.alt.txt`), which Next turns into
    `/favicon.ico`, `/opengraph-image.png?<hash>` and `og:image*` tags. The assessment's list misses them.
- **NextResponse.** It remains in 42 files:
  - 37 route files, two of them with `new NextResponse(...)` (`plans/[planId]/preview/route.ts`,
    `images/[month]/[name]/route.ts`);
  - 4 `src/lib/server` files (`http/error-response.ts`, `http/mod-and-community-gate.ts`, `http/service-response.ts`,
    `limits/dataset-rate.ts`);
  - `src/proxy.ts`.

  `next/*` imports: 52 files, `next.config.ts` and `proxy.test.ts` included.
- **"use client".** 213 files start with it, not 246: the old boards are gone (I26).
- **Default font.** It is **Inter** (`DEFAULT_APP_FONT = "inter"`), not Monocraft 400.
- **process.env in client code.** It reads `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_LIVE_URL`,
  `NEXT_PUBLIC_MOD_AND_COMMUNITY`, `NEXT_PUBLIC_GTNH_BUILD_ID`, `NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL` and `NODE_ENV`.
  Four debug reads are guarded by `typeof process !== "undefined"`: `ARRANGE_DEBUG` (`src/lib/board-arrange.ts:747,1789`)
  and `SIMPLEX_DEBUG` (`src/lib/solver/simplex.ts:390,415`). They reach the arrange and solve workers.
- **Next's request URL origin is the listen address, not the `Host` header.** Next builds a route's `request.url`
  from `${proto}://${hostname}:${port}`, where `hostname` and `port` are what the server listens on and `proto` is
  `https` when `X-Forwarded-Proto` holds `https` (`resolve-routes.js:116-118`).
  - The image listens on `HOSTNAME=0.0.0.0`, `PORT=3000`. The share card's redirect for a missing plan
    (`NextResponse.redirect(new URL("/opengraph-image.png", request.url))`) therefore answers
    `location: https://0.0.0.0:3000/opengraph-image.png` behind Caddy: a broken link.
  - Stage runs with the community switch off, so the route answers 404 there today (checked read-only on
    2026-10-27: `GET https://stage.gtnhplanner.idebugger.net/api/community/plans/missing-plan/card` gives 404 JSON).
    Every build with the switch on has the broken redirect.
  - This plan builds that origin from `siteUrl()` instead. It is the one intended wire change ("Needs an owner
    decision" 1).
- **Next's 308s carry no security headers**, measured on stage the same day. `/api/version/` (trailing slash),
  `//api/version` and `/datasets//gtnh/x` each answer 308 with only `location: <cleaned path>`,
  `refresh: 0;url=<cleaned path>` and the cleaned path as the body. They carry no CSP, nosniff or HSTS, and no
  content type. A 404 carries the security headers, `cache-control: private, no-cache, no-store, max-age=0, must-revalidate`,
  an `etag` and `content-type: text/html; charset=utf-8`.
- **@vercel/og.** Next bundles **1.0.1**, not 1.0.3.
- **@tailwindcss/vite.** 4.3.3 was published 2026-07-16, not 2026-10-19. The installed `tailwindcss` is 4.3.0, so
  this plan pins `@tailwindcss/vite` 4.3.0.
- **Young packages.** Express 5.3.0's tree now resolves three:
  - `body-parser` 2.4.0 (2026-10-22T11:39Z);
  - `on-finished` 2.4.2 (2026-10-22T13:21Z);
  - `qs` 6.17.0 (2026-10-27T06:23Z, published today).

  `typescript-eslint` 8.72.1 came out 2026-10-26. `eslint-plugin-react-hooks` 7.1.1 pulls `@babel/parser` 7.29.11
  (2026-10-23).
- **Perf harness.** `tools/perf/stress.mjs` imports `playwright`, which is not installed (only `playwright-core` is).
  `tools/perf/build-plan.mjs` defaults to `--base localhost:3000` and the version `local-2.9.0-beta-2`.
- **Gone or not yet there.** `tools/deploy/service-token.mjs` is gone (db-direct). `tools/http-parity/` does not exist
  yet. The existing `tools/parity/` is the mod-vs-web screenshot harness and is unrelated.

## Global Constraints

- **Not touched:** player-facing behaviour and copy; API answers (status, every header but the ignore list below, body
  bytes); the live service (`src/live`, its image, its compose service).
- **The wire stays exactly as Next serves it today.** Each item below has a test or a parity case:
  - the 308 for `//` and `\` (with `Refresh` and the body, without security headers) and for a trailing slash;
  - 405 with no `Allow` header and an empty body; OPTIONS 204 with `Allow` sorted alphabetically;
  - Next's own 500 status, headers and body for a thrown route, and Next's answer to a malformed escape;
  - unset `NEXT_PUBLIC_*` names read as `undefined`, never `""` (only `NEXT_PUBLIC_MOD_AND_COMMUNITY` and
    `NEXT_PUBLIC_GTNH_BUILD_ID` are always defined, as `next.config.ts` `env` does today);
  - Node's 300 s `requestTimeout`.
- **The one intended wire change** is the share card's redirect origin: `siteUrl()` instead of the listen address
  ("Needs an owner decision" 1). The hop-by-hop `Connection: close` on an answer that left a body unread (Task 5) is
  not end-to-end: Caddy drops it. It is named in the allow list.
- **Keep intact:** I7 (NEI order / Best match), I8 (version on the tab, Settings), I13 (machine card flash), I20
  (list order rule), I24 (roles and schema in `db/`), I26 (old boards gone).
- **Compression is Caddy's** (`encode zstd gzip`, infra repo). The app never compresses, and `compression` is not a
  dependency.
- **Keep the prerendered shell:** the HTML of `/` carries the app shell markup before any script runs, as today.
- **No `helmet`.** No `body-parser` call (`express.json()`, `express.urlencoded()`, `express.raw()`) anywhere.
- **Dependency age rule** (owner decision pending, so it is switchable; default: on). No package version younger
  than 7 days, transitive ones included. Install only with
  `npm install --save-exact [-D] <pkg>@<version> --before="$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)"`, then run
  `node scratch/dep-age.mjs` (Task 0) and `npm run audit:gate`.
  - If the owner lifts the rule, Task 5 step 1 drops `--before` and `dep-age.mjs` and may run now: the lock then
    takes `qs` 6.17.0 too. Nothing else moves.

  | Package | Version | Published | Earliest install (rule on) | Task |
  |---|---|---|---|---|
  | @vercel/og | 1.0.3 | 2026-09-22 | now | 2 |
  | express | 5.3.0 | 2026-10-09 | **2026-10-29 13:22 UTC** (`body-parser` 2.4.0, `on-finished` 2.4.2; `--before` keeps `qs` at 6.16.1) | 5 |
  | @types/express (dev) | 5.0.6 | 2025-12-01 | with express | 5 |
  | path-to-regexp (via router 2.2.0) | the lock must hold >= 8.4.0 (8.4.2, 2026-04-01) | | with express | 5 |
  | @vitejs/plugin-react (dev) | 6.1.2 | 2026-10-05 | now | 7 |
  | @tailwindcss/vite (dev) | 4.3.0 | 2026-05-08 | now | 7 |
  | typescript-eslint (dev) | 8.72.0 | 2026-10-19 | now (from 2026-10-26) | 13 |
  | eslint-plugin-react-hooks (dev) | 7.1.1 | 2026-04-17 | now; `--before` keeps `@babel/parser` <= 7.29.10 until 2026-10-30 | 13 |
  | vite | 8.3.4 (installed, unchanged) | 2026-10-08 | | |

  Removed in Task 12: `next`, `eslint-config-next`, `@tailwindcss/postcss`.
- **TypeScript and `.mjs`.** `tsconfig` has `allowJs: false`. Every `.mjs` module that a `.ts` file imports gets a
  `.d.mts` beside it (precedent: `tools/local-db/control.d.mts`). Each task's Files list names its `.d.mts` files.
- **The suite:** `npm run typecheck && npm run test`.
  - One failure is known: `src/live/service.test.ts` "drops a connection that does not read what it is sent".
  - UI tests can time out under load: rerun them alone.
  - Every task ends green on that command, and from Task 9 on also on `npm run build:express`.
  - Until Task 11, `npm run build` (Next) stays green as well.
- **Work and commits.** Work in the worktree `.worktrees/express` on branch `express`, one commit per task. Fix
  commits during Task 10 go in as their own commits. Commit messages start with `I25 ` and end with the attribution
  line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push and never deploy: the manager does both.
- **Player-facing copy:** none changes. Comments state the rule and why, with no dates or stories.
- **Generated files** go in `scratch/` (gitignored) or `dist/` (gitignored from Task 7), never in the repo root.
- **Board performance:** no task may add DOM measurement per edge or per frame. Task 10 records a before/after profile.
- **Owner decisions are switchable defaults:**
  - the 7-day rule (above);
  - I27 font preloads (Task 7 `page.json`, Task 8 `Link` header; default: Next's full list);
  - I28 module workers (Task 7; default: module workers);
  - I29 the CI build job (Task 11; default: not added).

  "Needs an owner decision" says where each one lands.

## Review Focus

1. **A browser-reachable `process.env.X` that Vite does not define** throws `process is not defined` at load, in the
   production build only. Expected: no unguarded `process` reference in the browser bundle, and the four
   `typeof process`-guarded debug reads stay inert. Pinned in Task 7 (`client-env.test.ts`).
2. **A CSP violation or hydration mismatch on the production page**, for example from a boot script's hash, an inline
   script Vite adds, or markup that differs between prerender and client. Expected: no `securitypolicyviolation`
   event, no hydration error, and the saved font stamped by the boot script before the app's own code runs. Pinned in
   Task 8 (`browser-check.mjs`) and the smoke test (Task 11).
3. **Odd path spellings**, sent raw (never through `fetch`, which normalizes them): `//x`, `\x`, `/x/./y`,
   `%2f`, `%2F`, `%2e`, `..%2f`, upper case, a trailing slash with a query, on API, dataset and public paths.
   Expected:
   - Next's answer;
   - a 308 before any gate where Next sends one;
   - never a dataset file served past the gate, and never a cross-site write that reaches a route.

   Pinned in Task 5 (`app.test.ts`), Task 6 (`app-gate.test.ts`), the raw-target test of the harness (Task 1) and its
   path cases (Task 10).
4. **Player text in the head**: a plan name or description holding `</title><script>`, quotes, `&` or a newline.
   Expected: escaped exactly as Next escapes it, with no tag injection. Pinned in Task 3 (`head.test.ts`).
5. **Over-cap, slow or unread request bodies, and SIGTERM during prewarm or an upload.** Expected:
   - an over-cap body under the drain bound answers the route's 413, and every client reads that 413 (the server
     drains the rest, then closes), whether the body was sent with `Content-Length` or chunked;
   - past the drain's byte bound the server stops reading and closes, and the client may get the 413 or a reset.
     Caddy's 8 MB limit keeps production under the bound;
   - a slow sender is cut at Node's 300 s request timeout;
   - SIGTERM always exits 143 within the 20 s grace.

   Pinned in Task 5 (`adapter.test.ts`) and Task 9 (`main.test.ts`).

## What holds each risk

| Risk (assessment §3, the brief, the review) | Held by |
|---|---|
| Security headers on every answer kind but Next's 308s; CSP without `'unsafe-inline'` for scripts | `app.test.ts` header cases (T5), `security-headers.test.ts` hash cases (T3), `page.test.ts` CSP case (T8), `browser-check.mjs` (T8, T10), smoke (T11) |
| Repeated slashes and backslashes: 308 before the gate, and no dataset file through the public mount | `app.test.ts` normalize cases over a raw socket (T5); `app-gate.test.ts` with `//datasets`, `\datasets`, `%2fdatasets`, `%2Fdatasets`, `..%2fdatasets` (T6); `static.test.ts` resolved-path refusal (T6) |
| Case-sensitive strict routing, the path gate, CSRF, in Next's order | `app.test.ts` (T5), `app-gate.test.ts` (T6), the harness's raw path cases (T1, T10) |
| Body caps: under the drain bound the 413 always arrives; past it, reading stops at the bound and the socket closes (declared length and chunked) | `adapter.test.ts` hard cap, the 30-client concurrent 413 batch and the slow-steady case (413 delivery), the byte and time bound cases (server side only), the drain-default case (T5), `main.test.ts` chunked case (T9), harness body-cap cases (T10), smoke's 9 MB edge case (T11) |
| 308 on a trailing slash, 404, 405, HEAD, OPTIONS, 500, malformed escapes | `app.test.ts` against bytes captured from Next (T5), harness (T10) |
| The prerendered shell and first paint | `prerender.test.tsx` (T7), `page.test.ts` (T8), `browser-check.mjs` hydration and boot-stamp cases (T8, T10) |
| OG image and per-plan meta | card route test (T2), `head.test.ts` against Next's captured head (T3), the metadata-tag compare and card pixels (T2, T10) |
| Dataset and texture serving, cache headers | `static.test.ts` (T6), the existing dataset-files and textures route tests, the harness's dataset sweep (T1, T10), smoke (T11) |
| Rate-limit answers (`Retry-After`) | the harness's 429 cases (T1, T10) |
| Prewarm on start | `main.test.ts` order and hold cases (T9) |
| `/api/version` | harness (T10), the deploy's own build check (T14) |
| SIGTERM | `main.test.ts` shutdown cases in process and one spawned (T9) |
| Standalone image and deploy script | `live-deps.test.mjs` site case, bake and rehearsal (T11), stage deploy (T14) |
| Compression moves to Caddy | smoke `--caddy` encoding checks (T11), the stage check after the infra change (T14) |
| Live integration | `test-client.mjs` on rehearsal and stage (T11, T14) |
| Dependency timing | `scratch/dep-age.mjs` and `npm run audit:gate` after every install (T2, T5, T7, T12, T13) |
| Wire format | the parity harness, Next against Express in both modes (T1, T10, T12), `wire-format.test.ts` |
| Dataset query layer unchanged | the golden harness (T0, T10). It is dataset evidence only: it calls `dataset-query` in process and never sees HTTP. HTTP dataset bytes are the parity harness's |
| Board performance | `stress.mjs` before/after (T1, T10) |

---

## File structure (after Task 12)

```
vite.config.ts                       client build (root src/client) and the SSR build of the prerender entry
tools/build/define.mjs (+ .d.mts)    clientDefines(env) / serverDefines(env): the inlined NEXT_PUBLIC_* values
tools/build/build-identity.mjs (+ .d.mts)  buildIdentity() (moved out of next.config.ts)
tools/build/build-server.mjs         esbuild call with serverDefines
tools/build/prerender.mjs            renders the shell into dist/client/index.html, writes dist/client/page.json
tools/http-parity/                   wire-format parity harness (capture, normalize, compare, requests + .d.mts)
src/client/index.html                the page template (<!--app-head-->, <!--app-boot-->, <!--app-shell-->)
src/client/main.tsx                  browser entry: hydrateRoot, or createRoot when the shell is empty (dev)
src/client/AppRoot.tsx               what layout.tsx + page.tsx rendered inside <body>
src/client/prerender.tsx             renderShell(): { shell, bootScripts, structuredData } (SSR build and dev)
src/client/fonts.css, fonts/         @font-face rules and the font files (moved from src/app/fonts in Task 12)
src/client/globals.css               moved from src/app/globals.css in Task 12
src/client/dev/clean-card/           moved dev harness (dev server only)
src/server/main.ts                   production entry: checks, ready gate, prewarm, listen, SIGTERM
src/server/dev.ts                    dev entry: Vite in middleware mode on :3000
src/server/app.ts                    createApp(options)
src/server/http/adapter.ts           Express <-> web Request/Response
src/server/http/route-table.ts       ROUTES and routePathForFile()
src/server/middleware/*.ts           path normalize, headers, gate, cross-site, static, not-found/405/errors, dataset backend
src/server/page/*.ts                 page template loading, the home page, /community, site routes
src/server/routes/**/route.ts(x)     the handlers, moved from src/app/** with the same folder names
src/lib/server/site/*.ts             head metadata, sitemap/robots/manifest/llms builders, TTL memo
src/lib/server/lifecycle.ts          closeServerResources(): what a stopping server releases (the database pool)
src/lib/server/http/security-headers.ts   moved from security-headers.config.ts, plus headersForPath()
src/lib/server/http/cross-site.ts    isCrossSiteWrite() (moved from src/proxy.ts)
```

Folder names under `src/server/routes` keep Next's brackets (`[planId]`, `[...assetPath]`), so the path of a handler
is readable from its file. A test derives every registered path from its file (Task 4), so the table cannot drift
from the folders, and nothing is discovered at run time.

---

### Task 0: Worktrees, baselines (no commit)

**Files:** none in git. Output goes in the express worktree's `scratch/`.

- [ ] **Step 1: Create the worktrees.** From the main checkout:
  - `git worktree add .worktrees/express -b express 3a41db6d`;
  - `git worktree add --detach .worktrees/next-baseline 3a41db6d`.

  Run `npm ci` in each (AGENTS.md: never junction `node_modules`). Copy the installed datasets in from the main
  checkout: `cp -cR public/datasets/gtnh .worktrees/<each>/public/datasets/`.
- [ ] **Step 2: Record the golden dataset baseline** in `.worktrees/next-baseline`:
  `GOLDEN_RECORD=1 npx vitest run src/lib/server/dataset-responses.local.test.ts --config vitest.local.config.ts`.
  Then copy `scratch/golden/` to the express worktree.
- [ ] **Step 3: Add the error-capture fixture to the baseline worktree only, uncommitted.** Create
  `src/app/api/__parity-throw/route.ts` (`export async function GET() { throw new Error("parity"); }`) and
  `src/app/api/__parity-param/[id]/route.ts` (`GET` returns `Response.json({ ok: true })`). They exist only so that
  Next's 500 and Next's answer to a malformed escape (`/api/__parity-param/%E0%A4%A`) can be captured. They are never
  committed anywhere.
- [ ] **Step 4: Build the two Next baselines**, one per value of the community switch:
  - `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3770 GTNH_BUILD_ID=baseline-3a41db6d NEXT_PUBLIC_MOD_AND_COMMUNITY= npm run build`;
  - copy `.next/standalone` plus `.next/static` beside it into `scratch/next-off/`;
  - the same with `NEXT_PUBLIC_MOD_AND_COMMUNITY=on` into `scratch/next-on/`.

  Both builds and every later Express build use `GTNH_BUILD_ID=baseline-3a41db6d`, so dataset answers and their cache
  keys compare equal. Give both copies and the express worktree **one** `public/`:
  `rsync -a .worktrees/express/public/ scratch/next-<mode>/public/` (mtimes kept, so `etag` and `last-modified` match).
- [ ] **Step 5: Write `scratch/dep-age.mjs`** in the express worktree. Given the `package-lock.json` before and after
  an install, it lists every entry that is new or changed, with its publish time from `npm view <name> time --json`,
  and exits 1 for any entry younger than 7 days.

### Task 1: The wire-format parity harness

> **Removed by I31:** the share card route is gone. Its cases (the scenario's card steps and the card route cases) answer 404 on Express, and the card's allow entry is dropped.

**Files:**
- Create: `tools/http-parity/requests.mjs`, `tools/http-parity/requests.d.mts`, `tools/http-parity/raw-http.mjs`,
  `tools/http-parity/capture.mjs`, `tools/http-parity/normalize.mjs`, `tools/http-parity/compare.mjs`,
  `tools/http-parity/allowed-differences.json`
- Create: `tools/http-parity/normalize.test.mjs`, `tools/http-parity/compare.test.mjs`, `tools/http-parity/raw-http.test.mjs`
- Modify: `tools/perf/stress.mjs:13` (import `chromium` from `playwright-core`)

**Interfaces:**
- Produces `raw-http.mjs`: `rawRequest({ base, method, target, headers, body?, chunks?, chunkDelayMs?, timeoutMs, strict?, ca?, lookup? }): Promise<RawAnswer>`.
  - `base` is `http://host:port` or `https://host[:port]`. Over `http:` it sends with
    `node:http.request({ host, port, path: target, setHost: false, agent: false })`. Over `https:` it uses
    `node:https.request` with the same options, plus `servername: host` only when `host` is a name (SNI cannot carry
    an IP, and Node warns with DEP0123), plus `ca?: string | Buffer` for a test's self-signed certificate. Stage uses
    the system trust store. There is no `rejectUnauthorized: false`.
  - `lookup?` is a `net.LookupFunction` passed through to the request options, so a test can resolve a name such as
    `parity.test` to `127.0.0.1` while `servername` and `Host` keep the name. It is for tests only: the capture never
    sets it.
  - The request target goes out byte for byte. `setHost: false` means no `Host` header is added unless `headers`
    has one, and `agent: false` means no socket is reused across cases.
  - With `strict: true`, a reset before the whole answer was read is a failure.
  - `RawAnswer = { status, headers: [name, value][], body: Buffer, bytesSent, socketClosedEarly }`.
  - A write `EPIPE` or `ECONNRESET` after the answer's head arrived is not a failure: the status still counts.
  - The Task 5 and Task 6 tests use it too (`src/server/test-support/serve.ts` re-exports it).
- Produces `capture.mjs`: `capture.mjs --base <url> --out <dir> --mode off|on [--only <regex>] [--host <name>] [--no-forwarded]`.
  - Every case goes through `rawRequest`.
  - Against a local server (the default), it sends `Host: parity.example` and `X-Forwarded-Proto: https` unless the
    case overrides them. The `Host` differs from the listen address, so an origin taken from either one shows in
    `location`. The byte-exact cases (raw spellings, no Host) run only this way, against a local server.
  - Against stage (Task 14), it runs as `--base https://stage.gtnhplanner.idebugger.net --host stage.gtnhplanner.idebugger.net --no-forwarded`.
    That is TLS with the real `Host` and SNI, and no forwarded headers, since Caddy sets those itself and routes by
    `Host`. Cases marked `localOnly` (no Host, raw spellings Caddy rewrites itself) are skipped.
  - It writes one `<dir>/<case>.json` per case: `{ name, request, status, headers, body }`.
  - `headers` holds every header the server sent, as a list in order, with duplicates kept.
  - `body` is `{ text }` for text up to 256 KiB, else `{ sha256, length }`, plus `{ pixels: sha256 }` for a PNG
    (decoded with `pngjs`).
- Produces `compare.mjs`: `compare.mjs <dirA> <dirB> [--allow allowed-differences.json]`.
  - It compares status, body, and the full set of header names and values.
  - Only the ignore list escapes the compare: `date`, `keep-alive`, `transfer-encoding` together with
    `content-length` (one check: the decoded body length must match), `x-nextjs-cache`, `x-nextjs-prerender`,
    `x-nextjs-stale-time`. `connection` **is** compared, so a close sent on the wrong answers shows. Its only
    expected difference is the allow-list entry for the unread-body case.
  - It prints each differing case and field, and exits 1 on any difference the allow list does not name.
- Produces `requests.mjs` (typed by `requests.d.mts`):
  - `CASES: Case[]` and `SCENARIO: Step[]`.
  - `Case = { name, method, target, headers?, body?, bodyBytes?, chunked?, modes: ("off"|"on")[], nextOnly?: true, localOnly?: true }`.
  - A `Step` is a case that may also `save` a value from its answer (`{ from: "json", path: "id", as: "planId" }`),
    and later targets and bodies use it as `{planId}`.
  - Task 4's coverage test reads `CASES`.

The normalizer:
- in bodies, `location`, `refresh` and `set-cookie`, replaces UUIDs with `<uuid:n>` (numbered by first appearance in
  the run), ISO and `Date`-format timestamps with `<time>`, and session cookie values with `<cookie:n>`;
- replaces `Retry-After` values with `<seconds>`;
- replaces each asset URL in HTML and in the `link` header (`/_next/static/...`, `/assets/...`) with
  `<asset:sha256-8>`. The hash comes from the bytes of the file the URL serves, which the capture fetches once.
  So the same font file compares equal under both names, and a different file does not;
- never touches dataset answers. Those must match byte for byte.

- [ ] **Step 1: Write the failing tests.**

```js
// raw-http.test.mjs: a node:http echo server records req.url and req.headers
it("sends the request target byte for byte", async () => {
  for (const target of ["/a/./b", "//a", "/a\\b", "/a/%2e/b", "/a/%2E%2E/b", "/%2fdatasets/x"])
    expect((await echo(target)).url).toBe(target);
});
it("sends no Host header unless the case names one, and opens a new socket per case", async () => { /* setHost: false, agent: false */ });
it("speaks TLS with the given SNI and Host", async () => { /* local https server on a self-signed cert for "parity.test"; base https://parity.test:port, a lookup option that resolves parity.test to 127.0.0.1, ca passed; servername "parity.test" seen */ });
it("sends no SNI for an IP host", async () => { /* base https://127.0.0.1:port: no servername, no DEP0123 warning */ });
it("keeps the status when the server closes the socket during a large upload", async () => { /* server answers 413 at once, destroys */ });

// normalize.test.mjs
it("numbers UUIDs by first appearance so two runs compare equal", () => { /* ... */ });
it("keeps a dataset answer byte for byte", () => { /* ... */ });
it("names an asset by its bytes, so /_next/static/media/x.woff2 and /assets/y.woff2 of the same file are equal", () => { /* ... */ });

// compare.test.mjs
it("fails on a header only one side sent", () => {
  expect(diffCases(withHeaders([["refresh", "0;url=/a"]]), withHeaders([]), [])).toEqual([{ field: "headers.refresh", a: "0;url=/a", b: undefined }]);
});
it("fails on a header value difference the allow list does not name", () => { /* ... */ });
it("passes a difference the allow list names by case pattern and field", () => { /* ... */ });
it("ignores date and keep-alive, and checks the body length across content-length and chunked", () => { /* ... */ });
```

- [ ] **Step 2: Run them:** `npx vitest run tools/http-parity`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `raw-http.mjs`, `normalize.mjs` and `compare.mjs`** (`normalizeText`, `normalizeCase`,
  `diffCases(a, b, allow)` and the CLI that walks two directories).
- [ ] **Step 4: Implement `requests.mjs`.** The case groups, each with its `modes`:
  - every route file's every exported method, with a valid and an invalid input;
  - an unexported method on each route path (Next: 405, no `Allow`, empty body), plus `HEAD` and `OPTIONS` on each
    route path;
  - pages: `/`, `/?plan={planId}` (on), `/?plan=missing`, `/community`, `/community?plan=x`;
  - site files: `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest`, `/llms.txt`, `/favicon.ico`, `/opengraph-image.png`;
  - `/dev/clean-card` (404 in production) and `/_next/image?url=/icon-192.png&w=64&q=75`;
  - public files: `/icon-192.png` (plain and with `If-None-Match`), `/highs.wasm`, `/highs.js`,
    `/apple-touch-icon.png`, `/api/highs/highs.wasm`;
  - the manifest;
  - per version, the lookup index three ways (plain, with `If-None-Match` of its ETag, with `Range: bytes=0-99`), a
    shard, a client file with `Accept-Encoding: br`, `gzip` and `identity`, a rendered texture, an atlas texture, a
    missing texture of each root, and `recipes.json`;
  - **a dataset sweep:** per version, the golden harness's fixed request set (the `getDatasetCatalog`, recipe query,
    resource query, recipe ids, recipe, resolve, mobs and crops calls in `src/lib/server/dataset-responses.local.test.ts`),
    written as the HTTP requests of the matching `/api/datasets/<v>/...` routes. This is the HTTP evidence for dataset
    bytes;
  - the gate's encoded cases, from `src/test-support/dataset-gate-cases.ts` (created in Task 6; until then the list in
    `src/lib/server/dataset-path-gate.test.ts`), plus `/DATASETS/gtnh/<v>/recipes.json`, `/datasets/gtnh/<v>/RECIPES.JSON`,
    `//datasets/gtnh/<v>/recipe-lookup-index.json.gz`, `/%2fdatasets/gtnh/<v>/recipes.json`,
    `/%2Fdatasets/gtnh/<v>/recipes.json`, `/x/..%2fdatasets/gtnh/<v>/recipes.json`,
    `\datasets\gtnh\<v>\recipe-lookup-index.json.gz` and `/datasets/gtnh/<v>/recipes.json/`;
  - trailing-slash 308s with percent-encoded paths, whose `Location` Next builds from the decoded `:path+` and
    re-encodes per segment: `/api/%76ersion/`, `/a%20b/`, `/a%2Fb/` (`localOnly`);
  - path spellings on `/api/version`: `/api/version/`, `/api/version/?a=1`, `/api/version/?a&b=x+y`,
    `/API/version`, `//api/version`, `//api/./version`, `/api\version`, `/api//version`, `/api/./version`,
    `/api/%2e/version`, `/api/%2E/version`, `/api/x/../version`, `/api/%76ersion` (all `localOnly`);
  - dot-segment spellings under the gate: `/datasets/gtnh/<v>/x/../recipe-lookup-index.json.gz` and
    `/datasets/gtnh/<v>/%2e/recipe-lookup-index.json.gz` (`localOnly`);
  - a cross-site POST (`Origin: https://evil.example`) to `/api/community/auth/logout`, `/API/community/auth/logout`,
    `//api/community/auth/logout`, `/api/community/auth/logout/`, `/x/../api/community/auth/logout` and
    `/x/%2e%2e/api/community/auth/logout` (the last four `localOnly`);
  - body caps:
    - a 17 KiB login body with `Content-Length`;
    - the same body chunked;
    - a 6 MiB board image with `Content-Length`, read with `strict: true`: the 413 and its body must arrive whole;
  - rate limits: one 429 case per limiter that a fresh `X-Client-Ip` reaches within 20 requests (register: 6 sign-ups
    from one address; any limiter in `src/lib/server/limits` or the services with a window of 20 or less);
  - a request with no `Host` header;
  - (`nextOnly`) `/api/__parity-throw` and `/api/__parity-param/%E0%A4%A` (Task 0 step 3).

  The `SCENARIO`, run in order on a fresh database:
  1. register two accounts (`a`, `b`), log both in, `me`;
  2. library: list; create and rename a folder; save a design; read it as `b` (refused); share it with `b` and read
     it as `b`; list members; remove the member;
  3. blueprints: save, list, public list, delete;
  4. (on) community: publish a plan, list, view, vote, comment, delete the comment, preview, download, card (found
     and missing), account search;
  5. board image upload and read;
  6. resource popularity;
  7. logout.
- [ ] **Step 5: Implement `capture.mjs`.** It sends each case, stores the raw parts and normalizes while writing. It
  prints the case count and how many failed to connect.
- [ ] **Step 6: Record the Next baselines.** Every server in this plan runs on **port 3770** (ports 3770-3779 are the
  executors'; the local database takes 3771 and 3772), one at a time, so ports
  never differ between captures. For each mode, start a fresh PGlite database. Shell 1:
  `LOCAL_DB_PORT=3772 LOCAL_DB_PG_PORT=3771 LOCAL_DB_DIR=scratch/parity-db-next-<mode> node --import tsx tools/local-db/serve.ts`.
  Shell 2: `PORT=3770 HOSTNAME=0.0.0.0 DATABASE_URL=postgres://postgres@127.0.0.1:3771/postgres COMMUNITY_HASH_SALT=parity-salt-000000000000000000000000 NEXT_PUBLIC_MOD_AND_COMMUNITY=<""|on> GTNH_PREWARM_ON_STARTUP=1 FILE_STORE_DIR=scratch/parity-files-next-<mode> GTNH_CLIENT_FILES_DIR=scratch/parity-client-files node scratch/next-<mode>/server.js`,
  from the express worktree with absolute paths (`scratch/scripts/run-capture.sh` does all of it).
  - `HOSTNAME=0.0.0.0` is what the image runs. With `127.0.0.1` and `X-Forwarded-Proto: https`, Next sends the dataset
    gate's rewrite to `https://localhost:3770` as an external proxy, and every gated dataset file answers 500. Do not
    change it back. Express may listen on 127.0.0.1: none of its answers depend on the listen address.
  - One `GTNH_CLIENT_FILES_DIR` serves every run, Next and Express.
  Then run `node tools/http-parity/capture.mjs --base http://127.0.0.1:3770 --mode <mode> --out scratch/parity/next-<mode>`.
  Run each mode twice on fresh databases and compare the runs: `node tools/http-parity/compare.mjs scratch/parity/next-on scratch/parity/next-on-2`.
  Expected: no difference. A difference here is a normalizer gap: fix the normalizer, not the cases.
- [ ] **Step 7: Write `allowed-differences.json`.** Each entry is `{ case, field, reason }` and names a difference
  that is meant to happen:
  - the HTML body of `/`, `/?plan=` and the 404 page, outside the metadata tags and the shell markup. Task 10 compares
    those two separately. Framework tags (`<script>`, `<link rel="stylesheet|preload|modulepreload">` to an asset,
    `<meta name="next-size-adjust">`) and the RSC flight are filtered out;
  - `vary` on HTML and route answers (`rsc, next-router-*` goes away);
  - the `content-security-policy` value: `script-src` hashes instead of `'unsafe-inline'`, and the worker policy
    moves from `/_next/static/*` to `/assets/*`;
  - `etag` on the 404 page (Next's prerendered page has one);
  - the `/_next/image` case (a plain 404 now);
  - the card's `location` for a missing plan: `https://0.0.0.0:3770/...` on Next (its listen address), `http://127.0.0.1:3770/...`
    (`siteUrl()`) on Express. This is the intended change, "Needs an owner decision" 1;
  - `connection: close` on an answer that left the request body unread (the 6 MiB case): hop by hop, Caddy drops it;
  - every `nextOnly` case.

  Nothing else goes on the list without the reviewer's agreement.
- [ ] **Step 8: Record the board perf baseline** against the `next-off` server on 3770:
  `node tools/perf/build-plan.mjs --base http://127.0.0.1:3770 --version local-2.9.0-rc-2 --nodes 300 --out scratch/perf/plan.json`,
  then 3 runs of `node tools/perf/stress.mjs --plan scratch/perf/plan.json --base http://127.0.0.1:3770 --label next --out scratch/perf/next-<n>.json`.
  Expected: three JSON files. `node tools/perf/ab.mjs scratch/perf/next-*.json` prints the table.
- [ ] **Step 9: Run the suite and commit.** `npm run typecheck && npm run test`, then
  `git commit -m "I25 An HTTP parity harness captures every route's answer, sent raw, for comparison across servers"`.

### Task 2: `NextResponse` becomes `Response`, `next/og` becomes `@vercel/og`, the card redirect names the site

**Files:**
- Modify: the 37 route files that import `NextResponse` (the list in "What changed"), and
  `src/lib/server/http/{error-response,mod-and-community-gate,service-response}.ts`, `src/lib/server/limits/dataset-rate.ts`
- Modify: `src/app/api/community/plans/[planId]/card/route.tsx`:
  - `ImageResponse` comes from `@vercel/og`;
  - the missing-plan redirect is `new URL("/opengraph-image.png", siteUrl())`;
  - its test's `vi.mock("next/og")` becomes `vi.mock("@vercel/og")`, and the test gains the redirect case.
- Modify: `package.json`, `package-lock.json` (`@vercel/og` 1.0.3)
- Not touched: `src/proxy.ts` (it needs `NextResponse.next/rewrite` until Task 12)

**Interfaces:**
- Produces: no route file and no `src/lib/server` file imports `next/server` or `next/og`. Later tasks import
  handlers knowing that they return a plain `Response`, and that no handler's output depends on `request.url`'s origin.

- [ ] **Step 1: Write the failing tests.** In `src/architecture.test.ts` (it moves in Task 12):

```ts
it("no route handler or server module imports next/server or next/og", () => {
  const offenders = [...graph.values()]
    .filter((f) => !isExempt(f.path) && (isRouteHandler(f.path) || isServer(f.path)))
    .flatMap((f) => f.edges.filter((e) => /^pkg:next\/(server|og)$/.test(e.to)).map((e) => `${f.path} -> ${e.to}`));
  expect(offenders).toEqual([]);
});
```

In the card route test:

```ts
it("sends a missing plan to the site's own generic card, on the site's own origin", async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://gtnhplanner.com");
  const answer = await GET(new Request("http://0.0.0.0:3000/api/community/plans/x/card"), ctx("x"));
  expect([answer.status, answer.headers.get("location")]).toEqual([302, "https://gtnhplanner.com/opengraph-image.png"]);
});
```

- [ ] **Step 2: Run them:** `npx vitest run src/architecture.test.ts src/app/api/community/plans`. Expected: FAIL,
  with 41 files listed (`src/proxy.ts` is neither a route nor server code) and the old location.
- [ ] **Step 3: Install @vercel/og.** `npm install --save-exact @vercel/og@1.0.3 --before=...`, then
  `node scratch/dep-age.mjs` and `npm run audit:gate`. Expected: no young entry, the gate passes.
- [ ] **Step 4: Replace the calls.**
  - `NextResponse.json(` becomes `Response.json(`.
  - `NextResponse.redirect(url, status)` becomes `Response.redirect(url, status)`.
  - `new NextResponse(body, init)` becomes `new Response(body, init)` (`preview/route.ts:118`,
    `images/[month]/[name]/route.ts:54`).

  Each file drops its `next/server` import. Each pair writes the same bytes and headers, and step 6 proves it.
- [ ] **Step 5: Run the suite.** `npm run typecheck && npm run test`. Expected: green. The other route tests and
  `src/app/api/wire-format.test.ts` stay unchanged.
- [ ] **Step 6: Run a parity check on Next.**
  - Run `npm run build` with each mode's build values, as in Task 0 step 4. That build has no `__parity-*` fixtures.
  - Start it as in Task 1 step 6 and capture into `scratch/parity/t2-<mode>`.
  - Compare with `scratch/parity/next-<mode>`.

  Expected: only the allow-listed card `location` and the `nextOnly` cases differ. If 1.0.3 draws other card pixels,
  pin `@vercel/og` 1.0.1 (Next's own copy, published 2026-08-08) and repeat.
- [ ] **Step 7: Commit.** `git commit -m "I25 Routes answer with the standard Response, the share card draws with @vercel/og, and its fallback names the site's own origin"`

### Task 3: Head, site files and security headers as framework-free modules

**Files:**
- Create: `src/lib/server/site/head.ts`, `src/lib/server/site/site-files.ts`, `src/lib/server/site/ttl-memo.ts`,
  `src/lib/server/site/escape.ts`
- Create: `src/lib/server/site/head.test.ts`, `src/lib/server/site/site-files.test.ts`, `src/lib/server/site/ttl-memo.test.ts`
- Create: `src/lib/server/site/__fixtures__/next-head-off.html`, `next-head-on-plan.html`, `next-sitemap-on.xml`,
  `next-robots-on.txt`, `next-robots-off.txt`, `next-manifest.json`. They are copied out of Task 1's baselines,
  normalized: the metadata tags only, one per line, with the framework tags filtered as in Task 1 step 7.
- Create: `tools/build/build-identity.mjs`, `tools/build/build-identity.d.mts`, `tools/build/build-identity.test.mjs`
- Modify:
  - `next.config.ts` (imports `buildIdentity` from `./tools/build/build-identity.mjs`), and
    `src/lib/server/next-config.test.ts` (allow that one import);
  - `.dockerignore` (`!tools/build/`, so the Next build in the image still finds the module);
  - `security-headers.config.ts` (adds `headersForPath`, plus `scriptHashes` in the env) and
    `src/lib/security-headers.test.ts`;
  - `src/app/sitemap.ts`, `src/app/robots.ts`, `src/app/manifest.ts`, `src/app/llms.txt/route.ts`: they call the
    shared builders, so Next and Express say the same thing.

**Interfaces:**
- Produces `head.ts`:
  - `interface PageHead { title: string; description: string; canonical: string; openGraph: OpenGraph; twitter: Twitter; image?: OgImage }`;
  - `siteHead(): PageHead`: what `siteMetadata()` says, with `opengraph-image.png` as the site image;
  - `planHead(row: PlanRow): PageHead`, with `PlanRow` from `src/lib/server/community-rows.ts`. It says what
    `page.tsx` `generateMetadata` says. Next merges per top-level key, so a plan's `openGraph` replaces the site's
    whole;
  - `async function headForRequest(search: URLSearchParams): Promise<PageHead>`: the community switch, then
    `getPublicPlanRow`, falling back to `siteHead()`;
  - `renderHead(head: PageHead, origin: string): string`: the metadata tag list in Next's order. That covers charset,
    viewport, theme-color, title, description, application-name, keywords, robots, googlebot, darkreader-lock,
    canonical, the og:*, twitter:* and og:image:* tags, icons, apple-touch-icon, manifest and favicon, with absolute
    URLs against `origin` (`siteUrl()`, Next's `metadataBase`).
- Produces `escape.ts`: `escapeHtml(text: string): string` and `escapeAttribute(text: string): string`, the same
  characters React escapes (`&`, `<`, `>`, `"`, `'`), since Next writes the head through React.
- Produces `site-files.ts`:
  - `async function sitemapEntries(): Promise<SitemapEntry[]>` (moved from `sitemap.ts`) and `sitemapXml(entries): string`;
  - `robotsTxt(): string`;
  - `webManifest(): object`;
  - `async function llmsText(): Promise<string>` (moved from the llms route, which keeps only `GET`).
- Produces `ttl-memo.ts`: `ttlMemo<T>(ttlMs: number, load: () => Promise<T>, now?: () => number): () => Promise<T>`.
  It is a memory-only memo that serves the stale value while it reloads, as today's ISR does with
  `isrFlushToDisk: false`.
- Produces `security-headers.config.ts`:
  - `headersForPath(pathname: string, env: SecurityHeaderEnv): [string, string][]`, the site rule plus `workerPolicy`
    for `/_next/static/*` and `/assets/*`;
  - `SecurityHeaderEnv` gains `scriptHashes?: string[]`. In production, when hashes are given, `script-src` is
    `'self' <hashes> 'wasm-unsafe-eval'` with no `'unsafe-inline'`.
- Produces `tools/build/build-identity.mjs`: `buildIdentity(env = process.env, cwd = process.cwd()): string`, the same
  rules as today. Typed by `build-identity.d.mts`.

- [ ] **Step 1: Write the failing tests.**

```ts
// head.test.ts
it("renders the site head exactly as Next does, mode off", () => {
  expect(tagsOneLine(renderHead(siteHead(), "http://127.0.0.1:3770"))).toBe(fixture("next-head-off.html"));
});
it("renders a plan's head exactly as Next does", () => { /* withModAndCommunityOn(); next-head-on-plan.html */ });
it("escapes player text in every tag that carries it", () => {
  const html = renderHead(planHead({ ...row, name: `</title><script>x</script>"&'`, description: "a\nb" }), origin);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
  expect(html.match(/<title>/g)).toHaveLength(1);
});
it("falls back to the site head for a missing plan, a plan crawlers may not see, and the switch off", async () => {
  expect(await headForRequest(new URLSearchParams("plan=missing"))).toEqual(siteHead());
});
// site-files.test.ts
it("writes the sitemap, robots and manifest Next writes", async () => { /* fixtures, lastmod normalized */ });
// ttl-memo.test.ts
it("loads once per hour, and serves the old value while a reload runs", async () => { /* fake clock */ });
it("keeps the old value when a reload throws", async () => { /* ... */ });
// security-headers.test.ts (added)
it("drops 'unsafe-inline' from script-src in production when the page's hashes are given", () => {
  expect(documentPolicy({ production: true, scriptHashes: ["'sha256-abc='"] })).toMatch(/script-src 'self' 'sha256-abc=' 'wasm-unsafe-eval'(;|$)/);
});
it("keeps 'unsafe-inline' and 'unsafe-eval' outside production", () => { /* ... */ });
it("gives the worker policy to /assets/* and /_next/static/*, and the page policy elsewhere", () => { /* ... */ });
```

`tagsOneLine` (test-local) keeps the tags' order, since order is part of the compare. It puts one tag per line and
replaces the `?<hash>` of `opengraph-image.png` with `?<hash>`.
- [ ] **Step 2: Run them:** `npx vitest run src/lib/server/site src/lib/security-headers.test.ts tools/build`.
  Expected: FAIL.
- [ ] **Step 3: Implement the modules.** `renderHead` builds strings through `escapeHtml` and `escapeAttribute`
  only. The `opengraph-image.png` query hash follows Next's rule, read from the fixture and Next's
  `metadata/resolvers` source. The rule is written in a comment.
- [ ] **Step 4: Route Next's metadata files through the builders.** `next.config.ts` imports `buildIdentity`.
- [ ] **Step 5: Run the suite and a parity check.** Run `npm run typecheck && npm run test`, then a Next build and a
  capture as in Task 2 step 6. Expected: green, and no unlisted difference.
- [ ] **Step 6: Commit.** `git commit -m "I25 The page head, sitemap, robots, manifest, llms.txt and security headers come from framework-free modules"`

### Task 4: Route table and path derivation (no Express yet)

**Files:**
- Create: `src/server/http/route-table.ts`, `src/server/http/route-table.test.ts`

**Interfaces:**
- Produces the types:
  - `type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"`;
  - `type RouteContext = { params: Promise<Record<string, string | string[]>> }`;
  - `type WebHandler = (request: Request, context: RouteContext) => Response | Promise<Response>`;
  - `type RouteModule = Partial<Record<HttpMethod, WebHandler>>`;
  - `interface RouteEntry { path: string; source: string; module: RouteModule }`.
- Produces the table:
  - `const ROUTES: readonly RouteEntry[]`: 39 entries, static imports; `source` is the file's repo path;
  - `routePathForFile(file: string): string`: `src/app/api/a/[id]/route.ts` gives `/api/a/:id`, `[...assetPath]`
    gives `/*assetPath`, and `src/app/llms.txt/route.ts` gives `/llms.txt`;
  - `optionsAllow(module: RouteModule): string`: the `Allow` value of Next's OPTIONS answer. That is every exported
    method, plus `HEAD` when `GET` is exported and `OPTIONS`, sorted alphabetically, joined with `", "`. The format is
    pinned against the baseline. A 405 has **no** `Allow`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("registers every route file under src/app at the path its folders name", () => {
  const files = globRouteFiles("src/app");              // test-local fs walk, *.test.* and __parity-* excluded
  expect(ROUTES.map((r) => r.source).sort()).toEqual(files.sort());
  for (const route of ROUTES) expect(route.path).toBe(routePathForFile(route.source));
});
it("derives Express 5 paths from Next folder names", () => {
  expect(routePathForFile("src/app/dataset-files/[versionId]/[...assetPath]/route.ts")).toBe("/dataset-files/:versionId/*assetPath");
});
it("lists OPTIONS' Allow sorted, as Next does", () => {
  expect(optionsAllow({ POST: h, GET: h })).toBe("GET, HEAD, OPTIONS, POST");
});
it("has a parity case for every route and every method", () => {
  // CASES from tools/http-parity/requests.mjs (typed by requests.d.mts): each route path matches a case per method
});
```

- [ ] **Step 2: Run:** `npx vitest run src/server`. Expected: FAIL.
- [ ] **Step 3: Implement `route-table.ts`.** One `import * as m from "@/app/.../route"` per file, and an entry
  `{ path: routePathForFile(source), source, module: pick(m) }`, where `pick` keeps only the method exports.
  Routes are listed in Next's precedence: static segments before dynamic ones.
- [ ] **Step 4: Run the suite and commit.** `git commit -m "I25 One route table names every handler and the path its folders give it"`

### Task 5: Express app core: adapter, path normalization, headers, 404/405/500 (from 2026-10-29 13:22 UTC)

> **Removed by I31:** no handler writes `request.url`'s origin any more: the card route that did is gone.

**Files:**
- Create: `src/server/http/adapter.ts`, `src/server/app.ts`, `src/server/middleware/normalize-path.ts`,
  `src/server/middleware/security-headers.ts`, `src/server/middleware/not-found.ts`
- Create: `src/server/http/adapter.test.ts`, `src/server/app.test.ts`
- Create: `src/server/test-support/serve.ts`: `listen(app): Promise<{ port: number; close(): Promise<void> }>` on port 0,
  plus `call(port, method, target, headers?, body?, options?)` over `rawRequest` (Task 1), where `options` passes
  `strict` and `chunkDelayMs` through; it rejects with the socket error when no answer head arrived
- Create: `src/server/__fixtures__/next-answers.json`: the exact status, headers and body of Next's 404, 500 (from
  `__parity-throw`), malformed escape (from `__parity-param`), 405, OPTIONS, the `//` 308 and the trailing-slash
  308, taken from the Task 1 baselines
- Modify: `package.json`, `package-lock.json` (`express` 5.3.0, `@types/express` 5.0.6 as a dev dependency)

**Interfaces:**
- Consumes: `ROUTES`, `optionsAllow`, `WebHandler` (Task 4); `headersForPath` (Task 3); `siteUrl()`;
  `PROXY_BODY_MAX_BYTES` (`src/lib/server/http/request-body.ts`; renamed `BODY_HARD_CAP_BYTES` in Task 12).
- Produces `adapter.ts`:
  - `toWebRequest(req: express.Request, options: { hardCapBytes: number; origin: string }): Request`.
    - The URL is `origin + req.canonicalUrl`, where `origin` is `siteUrl()`. `req.canonicalUrl` is set by
      `canonicalPath` and updated by the gate's rewrite (below), never `req.originalUrl`, which Express fixes as the
      raw target on entry. The handler therefore gets the normalized and rewritten URL Next's handler got. That way a handler's absolute URL names
      the site and trusts no request header. The only handler that writes `request.url`'s origin is the card, which
      Task 2 already moved to `siteUrl()`.
    - The body is the request stream as a web stream (`duplex: "half"`), which errors with `BodyTooLargeError` past
      `hardCapBytes`.
    - The `signal` aborts when the client goes away.
  - `sendWebResponse(req, res, response: Response): Promise<void>`.
    - Each `getSetCookie()` value becomes its own header.
    - There is no body on `HEAD`, and the body is piped from the web stream with backpressure.
    - If the request body was not read to its end (`!req.complete` once the answer is written), it sets
      `Connection: close` (`res.shouldKeepAlive = false`). It then **reads and discards** the rest of the body, up to
      `DRAIN_MAX_BYTES` (`BODY_HARD_CAP_BYTES` + 4 MiB, so 8.5 MiB past the start of the body). Two timers bound it:
      - an **idle** timer, `DRAIN_IDLE_MS` (31,000), reset on every chunk that arrives;
      - a **total** cap, `DRAIN_TOTAL_MS` (35,000).

      Both must stay above Caddy's 30 s body read timeout, so that in production Caddy's own limits always fire
      first: a slow but steady over-cap upload reaches its end and its 413, and an upload that stalls is cut by Caddy,
      not by the app, so the app never turns it into a reset and a 502. The total cap must stay at or above the idle
      timer. The app's bounds matter only for a direct client. Then it closes: `end` on a complete body,
      `socket.destroy()` once a bound is hit.
    - SIGTERM's grace (15 s, Task 9) cuts a drain that is still running at shutdown. That is accepted: the process is
      exiting, and Caddy's `lb_try_duration` covers the restart.
    - Destroying the socket at once would throw away the 413 the client has not read yet: a TCP reset on unread
      incoming data. Behind Caddy that becomes a 502 and a network-error message. Today's player sees the route's
      413 sentence, and the drain keeps that.
    - The bound is what stops reading, not the cap. A body past the bound is cut. An answer past the byte bound may
      be lost: closing on a sender that has not finished draws a reset, and the client's kernel may throw away the
      413 it has not read yet. Caddy's 8 MB `request_body` limit refuses such a body at the edge first, so in
      production the drain always reaches the body's end.
  - `handle(handler: WebHandler): express.RequestHandler` passes `{ params: Promise.resolve(req.params) }`;
  - `class BodyTooLargeError extends Error`;
  - `const DRAIN_MAX_BYTES = BODY_HARD_CAP_BYTES + 4 * 1024 * 1024`, `const DRAIN_IDLE_MS = 31_000` and
    `const DRAIN_TOTAL_MS = 35_000`, exported, with a comment that both must stay above Caddy's 30 s body timeout and
    the total at or above the idle timer.
    `createApp`'s `drain?: { maxBytes: number; idleMs: number; totalMs: number }` overrides them, for tests only.
- Produces `normalize-path.ts`. Next parses `req.url` with WHATWG `new URL()` (`parseRelativeUrl`) before
  routing, and its proxy and router see that parsed pathname. Its redirects build `Location` the same way. Three
  middlewares do the same, in this order:
  - `repeatedSlashRedirect()`: a raw target whose path holds `\` or `//` answers 308. `Location` is
    `pathname + search` of `new URL(normalizeRepeatedSlashes(raw), "http://n")`, where `normalizeRepeatedSlashes` is
    Next's: `\` becomes `/`, and runs of `/` collapse, in the path only. So `//api/./version` goes to `/api/version`.
    The answer carries `Location: <clean>`, `Refresh: 0;url=<clean>` and the body `<clean>`, with **no** security
    headers and no content type, exactly as in the fixture.
  - `trailingSlashRedirect()`: a path other than `/` ending in `/` answers 308 with the same three parts and no
    security headers. The destination is Next's: the WHATWG pathname without its trailing slash, then the query
    **re-serialized** the way Next's `stringifyQuery` does: `?a` becomes `?a=`, and `+` in a value becomes `%20`.
    Implement it as `querystring.stringify` of the parsed query, the module Next uses, and pin it against the
    baseline (`/api/version/?a&b=x+y`). The path half is also Next's: each segment of the path is decoded, then
    encoded again the way Next compiles `/:path+` (`encodeURIComponent` per segment, read from
    `load-custom-routes.js` and the baseline). It is pinned by `/api/%76ersion/`, `/a%20b/` and `/a%2Fb/`.
  - `canonicalPath()`: after the redirects, `req.url` becomes the WHATWG pathname of the raw target plus the raw
    search. `.` and `..` segments, and `%2e`/`%2E` dot segments, resolve the way Next's router and proxy saw them.
    Every later middleware sees this path: security headers, the gate, the cross-site check, the static mounts and
    the router. It also sets `req.canonicalUrl` to the same value; the gate's rewrite updates both `req.url` and
    `req.canonicalUrl`. The raw target is kept in `req.rawTarget`, which **only the two redirect middlewares** read
    (they run before it is replaced). Nothing after `canonicalPath` reads `req.rawTarget` or `req.originalUrl`. A
    test greps `src/server` for both names outside `normalize-path.ts`, and finds none.
  - What Next answers for `/api/%76ersion` (a percent-encoded unreserved letter, which WHATWG leaves as is) is read
    from the baseline and pinned. If Next routes it, `canonicalPath` decodes unreserved escapes too; otherwise it
    leaves them.
- Produces `app.ts`: `createApp(options: AppOptions): express.Express`, with
  `interface AppOptions { env: SecurityHeaderEnv; publicDir: string; datasetsDir: string; clientDir?: string; page?: express.RequestHandler; ready?: Promise<void>; datasetBackendUrl?: string; before?: express.RequestHandler[]; extraRoutes?: RouteEntry[]; drain?: { maxBytes: number; idleMs: number; totalMs: number } }`.
  - `extraRoutes` is for tests only; production passes none.
  - Settings come before any `use`: `case sensitive routing` true, `strict routing` true, `x-powered-by` disabled,
    `etag` false, `query parser` `"simple"`.
  - The order follows Next's (headers and redirects before the proxy): `ready` gate, `repeatedSlashRedirect`,
    `trailingSlashRedirect`, `canonicalPath`, security headers, (Task 6: gate, cross-site, backend, static), routes, (Task 8: page),
    OPTIONS answers, 405, 404, error handler.
- Produces `not-found.ts`:
  - `optionsAnswer(routes)`: 204 with `Allow: optionsAllow(module)`, registered as `app.options(path, ...)` before the
    405;
  - `methodNotAllowed()`: 405, no `Allow`, empty body (Next's `auto-implement-methods`);
  - `notFound()`: Next's 404 status, `cache-control` and `content-type` from the fixture. The body is a static HTML
    page saying what Next's says ("404: This page could not be found."); the body difference and the `etag` are on
    the allow list;
  - `errorHandler()`. Only the router's parameter decode error (a `URIError`, or the router's error with
    `status === 400` and a `URIError` cause, raised from `decode_param`) answers as the fixture's malformed-escape
    answer. Any other error with a `.status` from a library still gets Next's 500. Any other error answers exactly Next's 500 from the fixture
    (status, headers, body). It logs the error once with `console.error` and never sends a stack. No new sentence:
    the client keeps its own fallback copy, as today.

- [ ] **Step 1: Install express.** With the rule on, on or after 2026-10-29 13:22 UTC:
  `npm install --save-exact express@5.3.0 && npm install --save-exact -D @types/express@5.0.6`, both with
  `--before=...`. Then `node scratch/dep-age.mjs`, `npm ls path-to-regexp body-parser qs on-finished` and
  `npm run audit:gate`. Expected: `path-to-regexp` 8.4.x, `body-parser` 2.4.0, `qs` 6.16.1, no young entry, the gate
  passes.
- [ ] **Step 2: Write the failing tests.** They run against `createApp` on an ephemeral port, every request sent with
  `call()` (raw):

```ts
it("answers //, \\ and a trailing slash with Next's 308: Location, Refresh, the path as body, no security headers", async () => {
  for (const [target, clean] of [["//api/version", "/api/version"], ["/api\\version", "/api/version"],
                                 ["/api/version/?a=1", "/api/version?a=1"], ["/datasets//gtnh/x", "/datasets/gtnh/x"]])
    expect(pick(await call(port, "GET", target))).toEqual(nextFixture.redirect308(clean));
});
it("resolves dot segments as Next does, in the 308 Location and before routing", async () => {
  expect(pick(await call(port, "GET", "//api/./version"))).toEqual(nextFixture.redirect308("/api/version"));
  expect((await call(port, "GET", "/api/./version")).status).toBe(200);
  expect((await call(port, "GET", "/api/%2e/version")).status).toBe(200);
  expect((await call(port, "GET", "/api/x/../version")).status).toBe(200);
});
it("re-encodes the path of a trailing-slash 308 as Next does", async () => {
  for (const t of ["/api/%76ersion/", "/a%20b/", "/a%2Fb/"])
    expect((await call(port, "GET", t)).headers).toContainEqual(["location", nextFixture.slashLocationFor(t)]);
});
it("re-serializes the query of a trailing-slash 308 as Next does", async () => {
  expect((await call(port, "GET", "/api/version/?a&b=x+y")).headers).toContainEqual(["location", nextFixture.slashLocation]);
});
it("answers Next's 500 to a library error that carries a status, and Next's malformed-escape answer only to a decode error", async () => { /* ... */ });
it("redirects before the gate and the cross-site check", async () => {
  expect((await call(port, "POST", "/api/community/auth/logout/", { origin: "https://evil.example" })).status).toBe(308);
  expect((await call(port, "GET", "/datasets/gtnh/v/recipes.json/")).status).toBe(308);
});
it("puts the security headers on a route answer, a 404, a 405, an OPTIONS and a 500", async () => { /* ... */ });
it("is case-sensitive: /API/version is a 404", async () => { /* ... */ });
it("answers 405 with no Allow and no body, and OPTIONS with 204 and the sorted Allow", async () => {
  expect(pick(await call(port, "DELETE", "/api/version"))).toEqual(nextFixture.answer405);
  expect(pick(await call(port, "OPTIONS", "/api/version"))).toEqual(nextFixture.options("/api/version"));
});
it("answers HEAD with the GET's headers and no body", async () => { /* ... */ });
it("answers a thrown route with Next's 500, byte for byte, and never a stack", async () => { /* extraRoutes throw */ });
it("answers a malformed escape in a param as Next does", async () => { /* /api/x/%E0%A4%A via extraRoutes */ });
it("sends no X-Powered-By and no ETag on a route answer", async () => { /* ... */ });
it("holds requests until ready resolves", async () => { /* deferred ready */ });

// adapter.test.ts
it("passes several Set-Cookie headers through one by one", async () => { /* ... */ });
it("passes params from :id and *rest as the handler's context", async () => { /* rest is string[] */ });
it("gives the handler a URL on siteUrl()'s origin, whatever Host says", async () => { /* Host: evil.example */ });
it("streams a body of unknown length without buffering it", async () => { /* ReadableStream route */ });
it("errors the request body past the hard cap", async () => { /* raw request.arrayBuffer() rejects with BodyTooLargeError */ });
it("gives every client of a concurrent batch the route's 413 status and body for an over-cap Content-Length upload", async () => {
  // 30 clients at once, each writing a whole 6 MiB body (over the 4 MiB + 64 KiB route cap, under the drain bound)
  const answers = await Promise.all(Array.from({ length: 30 }, () =>
    call(port, "POST", "/api/community/images", { "content-length": String(6 * 2 ** 20) }, sixMiB, { strict: true })));
  // strict: a reset before the whole answer was read is a failure, not a tolerated EPIPE
  for (const a of answers) {
    expect(a.status).toBe(413);
    expect(JSON.parse(a.body.toString())).toEqual(routeTooLargeBody);
    expect(a.headers).toContainEqual(["connection", "close"]);
  }
});
it("stops draining at the byte bound and closes", async () => {
  // drain: { maxBytes: 1 MiB } via createApp, and a 64 MiB sender, not strict. This asserts the server side only:
  // closing on a sender that has not finished draws a reset, and the client's kernel may drop the unread 413, so
  // the client may see the 413 or a reset. The under-bound cases (the 30-client batch, the slow-steady case and
  // Task 9's chunked case) hold the promise that the 413 always arrives.
  const a = await call(port, "POST", "/api/community/images", { "content-length": String(64 * 2 ** 20) }, sixtyFourMiBStream)
    .catch((error) => ({ error }));
  if ("status" in a) expect(a.status).toBe(413);
  else expect(a.error.code).toMatch(/^(ECONNRESET|EPIPE)$/);
  expect(serverBytesRead()).toBeLessThanOrEqual(1 * 2 ** 20 + BOARD_IMAGE_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES + 64 * 1024);
  expect(serverSocketClosed()).toBe(true);
});
it("delivers the 413 to a slow but steady over-cap upload that runs longer than the idle bound in total", async () => {
  // drain: { idleMs: 300, totalMs: 5_000 }; a 6 MiB body in 64 KiB chunks, one every 20 ms (about 2 s in all, more
  // than six idle bounds): every chunk resets the idle timer, so the drain reaches the end
  const a = await call(port, "POST", "/api/community/images", { "content-length": String(6 * 2 ** 20) }, sixMiB,
                       { strict: true, chunkDelayMs: 20 });
  expect(a.status).toBe(413);
  expect(JSON.parse(a.body.toString())).toEqual(routeTooLargeBody);
});
it("stops draining at the idle bound when the sender stalls, and at the total bound when it trickles", async () => {
  /* drain: { idleMs: 300, totalMs: 1_000 }. A sender that stops: closed after about 300 ms. One that sends a byte
     every 200 ms: closed after about 1 s */
});
it("keeps the drain's default idle and total bounds above Caddy's 30 s body timeout", () => {
  expect(DRAIN_IDLE_MS).toBe(31_000);
  expect(DRAIN_TOTAL_MS).toBeGreaterThanOrEqual(35_000);
  expect(DRAIN_TOTAL_MS).toBeGreaterThanOrEqual(DRAIN_IDLE_MS);
});
it("keeps the connection open when the route read the whole body", async () => { /* ... */ });
it("aborts the request signal when the client goes away", async () => { /* ... */ });
```

`serverBytesRead()` sums `socket.bytesRead` from a `connection` listener on the test server.
- [ ] **Step 3: Run them:** `npx vitest run src/server`. Expected: FAIL.
- [ ] **Step 4: Implement the adapter, `createApp` and the middlewares.** Each route gets
  `app.<method>(path, handle(fn))` for every export, then `app.options(path, optionsAnswer)`, then
  `app.all(path, methodNotAllowed)`.
- [ ] **Step 5: Run the suite.** `npm run typecheck && npm run test`. Expected: green.
- [ ] **Step 6: Commit.** `git commit -m "I25 An Express 5 app serves the route table with Next's redirects, routing rules, headers, 404, 405 and 500"`

### Task 6: The dataset gate, the cross-site check, static files and the dataset backend

**Files:**
- Create: `src/server/middleware/dataset-gate.ts`, `src/server/middleware/cross-site.ts`, `src/server/middleware/static.ts`,
  `src/server/middleware/dataset-backend.ts`
- Create: `src/lib/server/http/cross-site.ts` (`isCrossSiteWrite`, moved from `src/proxy.ts`, which imports it back)
- Create: `src/test-support/dataset-gate-cases.ts`: the encoded cases as data, used by `dataset-path-gate.test.ts`,
  the HTTP test and the harness. It adds the review's spellings: `//datasets/...`, `\datasets\...`,
  `/%2fdatasets/...`, `/%2Fdatasets/...`, `/x/..%2fdatasets/...`, `/datasets/gtnh/<v>/%2e/...`, `/datasets/gtnh/<v>/./...`.
- Create: `src/server/app-gate.test.ts`, `src/server/static.test.ts`, `src/server/dataset-backend.test.ts`
- Modify: `src/server/app.ts` (order), `src/lib/server/dataset-path-gate.test.ts` (reads the shared cases), `src/proxy.ts`

**Interfaces:**
- Consumes: `decideDatasetPath` (unchanged), `createApp` (Task 5).
- Produces `dataset-gate.ts`: `datasetGate(): RequestHandler`, deciding on `req.url`'s path after the redirects and
  `canonicalPath` ran. That is the WHATWG pathname Next's proxy saw: dot segments resolved, percent escapes kept, so
  `decideDatasetPath` still refuses every encoded form. A refusal answers 400 `{"error":"Invalid dataset path."}` with `no-store`. A rewrite sets `req.url`
  and `req.canonicalUrl` to the new path plus the original query and calls `next()`.
- Produces `cross-site.ts`: `crossSiteWriteGuard(): RequestHandler`. It reads the **canonical** path only
  (`req.path` after `canonicalPath`), the normalized pathname Next's proxy checked. When that path starts with
  `/api/`, a cross-site write answers 403 `{"error":"Cross-site request refused."}`. So `/x/../api/...` and
  `/x/%2e%2e/api/...` are checked like `/api/...`, then routed. `/API/...` matches no route and answers 404.
  The `//` and trailing-slash spellings were already redirected.
- Produces `static.ts`:
  - `clientAssets(clientDir)`: `/assets/*` with `immutable: true, maxAge: "1y"`, `index: false`, `fallthrough: true`.
  - `publicFiles(publicDir)`: serve-static with `dotfiles: "ignore"`, `index: false`, `redirect: false`, wrapped by a
    guard that decides on the **resolved file path**, never on a URL segment. It decodes the path the way `send`
    does, resolves it under `publicDir`, and refuses (falls through to the routes, then 404) when
    `path.relative(publicDir, resolved)`, compared in lower case, is `datasets` or starts with `datasets` and a
    separator. It also refuses when the resolved path escapes `publicDir`.
  - `datasetPublicFiles(datasetsDir)`, mounted at `/datasets/gtnh`: case-sensitive matching, `dotfiles: "deny"`,
    `index: false`, `redirect: false`, `fallthrough: true`. Its guard runs `decideDatasetPath` on the **full request
    canonical path** (`req.canonicalUrl`'s path, not the mount-relative path and never `req.originalUrl`), in lower case, and refuses anything that is not
    `pass`. So a case-folded `RECIPES.JSON` on a case-insensitive file system is never a file. A miss falls through
    to the textures route, as Next's public handler did.

  Cache headers are serve-static's defaults (`public, max-age=0`, weak ETag, `Last-Modified`), which the baseline
  confirms are Next's.
- Produces `dataset-backend.ts`: `datasetBackendProxy(baseUrl: string): RequestHandler`, mounted only when
  `GTNH_DATASET_BACKEND_URL` is set. It forwards the three patterns of today's `next.config.ts` `rewrites()`, with
  the `PUBLISHED_SEGMENT` and `API_SEGMENT` checks done in code on each segment, and streams the answer back with its
  status and headers (hop-by-hop headers dropped).

App order after this task: `ready`, `repeatedSlashRedirect`, `trailingSlashRedirect`, security headers,
`datasetGate`, `crossSiteWriteGuard`, `datasetBackendProxy?`, `clientAssets`, `publicFiles`, `datasetPublicFiles`,
routes, page, OPTIONS, 405, 404, errors.

- [ ] **Step 1: Write the failing tests.** Every request goes through `call()` (raw), against `createApp` with a
  fixture public dir holding `datasets/gtnh/v/{recipes.json,recipe-lookup-index.json.gz}`:

```ts
it.each(GATE_REFUSE_CASES)("refuses %s with 400 and no-store", async (target) => { /* ... */ });
it.each(GATE_REWRITE_CASES)("sends %s to the dataset-files route", async (target, routed) => { /* route stub records req path */ });
it.each(GATE_REDIRECT_CASES)("answers %s with Next's 308 before the gate", async (target, clean) => { /* //, \\ forms */ });
it("sends a dot-segment spelling of an index gzip to the dataset-files route, as Next's proxy did", async () => {
  expect(routedPathFor("/datasets/gtnh/v/x/../recipe-lookup-index.json.gz")).toBe("/dataset-files/v/recipe-lookup-index.json.gz");
  expect(routedPathFor("/datasets/gtnh/v/%2e/recipe-lookup-index.json.gz")).toBe(/* the baseline's answer: rewrite or 400 */);
});
it("never serves a dataset file through the public mount, under any spelling", async () => {
  for (const t of ["/datasets/gtnh/v/recipes.json", "/datasets/gtnh/v/RECIPES.JSON", "/DATASETS/gtnh/v/recipes.json",
                   "/datasets/gtnh/v/recipes%2Ejson", "/%2fdatasets/gtnh/v/recipes.json", "/%2Fdatasets/gtnh/v/recipe-lookup-index.json.gz",
                   "/x/..%2fdatasets/gtnh/v/recipes.json", "/datasets/gtnh/v/%2e/recipes.json", "/datasets/gtnh/v/./recipes.json"])
    expect((await call(port, "GET", t)).body.toString()).not.toBe(fileBytes);
});
it("refuses a cross-site write to the API, and passes the same write from the site's origin or with no Origin", async () => { /* ... */ });
it("answers a cross-site write to /API/ with 404 and to //api/ with 308, so no route sees it", async () => { /* ... */ });
it("refuses a cross-site write under a dot-segment spelling of /api/, as Next's proxy did", async () => {
  for (const t of ["/x/../api/community/auth/logout", "/x/%2e%2e/api/community/auth/logout", "/x/%2E%2E/api/community/auth/logout"])
    expect(pick(await call(port, "POST", t, { origin: "https://evil.example" }))).toEqual(crossSiteRefused); // 403 + body, pinned to the baseline
});
it("reads req.rawTarget and req.originalUrl nowhere after canonicalPath", () => {
  // grep src/server/**/*.ts (tests excluded) for rawTarget|originalUrl: only src/server/middleware/normalize-path.ts
});
it("hands the handler and the dataset mount the canonical URL, not the raw one", async () => {
  /* /datasets/gtnh/v/textures/atlas/x/../a.png is served by datasetPublicFiles; a stub route sees request.url's path as canonical */
});

// static.test.ts
it("serves /assets/* immutable for a year, public/ at max-age=0 with a weak ETag, and the manifest at max-age=0", async () => { /* ... */ });
it("answers 304 to If-None-Match on a public file", async () => { /* ... */ });
it("decides the public mount's refusal on the resolved file, not on the URL", async () => { /* %2fdatasets, ..%2f */ });
it("falls through to the textures route when an atlas texture is missing", async () => { /* 404 no-store JSON from the route */ });

// dataset-backend.test.ts: the accept/refuse table of next-config.test.ts's rewrite cases, as forwarding decisions
```

- [ ] **Step 2: Run:** `npx vitest run src/server`. Expected: FAIL.
- [ ] **Step 3: Implement the middlewares and the order above.** `src/proxy.ts` imports `isCrossSiteWrite` from
  `src/lib/server/http/cross-site.ts`, so Next keeps working.
- [ ] **Step 4: Run the suite and commit.** `proxy.test.ts` and `next-config.test.ts` stay green.
  `git commit -m "I25 The Express app gates dataset paths, refuses cross-site writes and serves static files with Next's cache rules"`

### Task 7: The Vite client build: template, entry, fonts, defines, workers

**Files:**
- Create: `vite.config.ts`, `src/client/index.html`, `src/client/main.tsx`, `src/client/AppRoot.tsx`,
  `src/client/prerender.tsx`, `src/client/fonts.css`, `src/client/vite-env.d.ts`
- Create: the Google faces vendored as the exact woff2 files Next's baseline build serves
  (`scratch/next-off/.next/static/media/*`, matched to their `@font-face` rules in the baseline CSS), each with its
  OFL licence file. They go in `src/app/fonts/` beside the vendored Monocraft and OpenDyslexic, and move with them in
  Task 12.
- Create: `tools/build/define.mjs`, `tools/build/define.d.mts`, `tools/build/prerender.mjs`, `tools/build/define.test.mjs`
- Create: `src/client/client-env.test.ts`, `src/client/prerender.test.tsx`
- Modify: `src/store/solve-books.ts:103`, `src/lib/arrange-solve.ts:57`, `src/lib/datasets/resource-search-client.ts:77`,
  `src/components/flow/grid-route-solve.ts:77`: `{ type: "module" }` (I28 default)
- Modify: `package.json` (script `build:client`, devDependencies `@vitejs/plugin-react` 6.1.2,
  `@tailwindcss/vite` 4.3.0), `.gitignore` (`/dist`), `.dockerignore` (`dist`)
- Not touched: `src/app/layout.tsx` and `page.tsx` (Next keeps them until Task 12), `src/app/globals.css` (moves in
  Task 12)

**Interfaces:**
- Consumes: `APP_FONT_STORAGE_KEY`, `DEFAULT_APP_FONT`, `uiScaleBootScript`, the viewport breakpoints (as
  `layout.tsx` uses them), and `siteUrl()`.
- Produces `src/client/prerender.tsx`: `renderShell(): { shell: string; bootScripts: string[]; structuredData: string }`.
  `shell` is `renderToString(<AppRoot />)`. `bootScripts` holds the two boot script texts of `layout.tsx` (font,
  then UI scale). `structuredData` is the JSON-LD text.
- Produces `src/client/AppRoot.tsx`: `AppRoot()` renders, in `layout.tsx`'s order, `<FactoryPlannerApp/>`, the
  `<noscript>` block of `page.tsx`, the `.ui-zoom` `WhatsNewGate`, `AppFontRestore` and `GlobalTitleTooltip`.
- Produces `src/client/index.html`:
  - `<html lang="en" class="h-full">` and `<body class="min-h-full">` as today; the `--font-*` variables move to
    `:root` in `fonts.css`, so the font class names go;
  - `<head>` holds `<!--app-head-->`;
  - `<body>` holds `<!--app-boot-->`, then `<div id="root" style="display:contents"><!--app-shell--></div>`, then the
    module script. `display: contents` keeps the box tree the same as Next's, where the app sat directly under
    `<body>`.
- Produces `src/client/main.tsx`. It imports `../app/globals.css` (from Task 12: `./globals.css`) and `./fonts.css`.
  It calls `hydrateRoot(root, <AppRoot/>)` when `#root` has children, else `createRoot(root).render(<AppRoot/>)` (the
  dev server sends no shell).
- Produces `tools/build/define.mjs` (typed by `define.d.mts`):
  - `clientDefines(env): Record<string, string>`:
    - `process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY` is always defined (`""` when unset, as `next.config.ts` `env` does);
    - `process.env.NEXT_PUBLIC_GTNH_BUILD_ID` is always defined (`buildIdentity()`);
    - `process.env.NEXT_PUBLIC_SITE_URL`, `_LIVE_URL` and `_GTNH_DATASET_MANIFEST_URL` are the JSON string when set,
      else the literal `undefined`. Next leaves an unset name undefined, so the `??` fallbacks keep working
      (`remote.ts:9`);
    - `process.env.NODE_ENV` is `"production"` for a build.
  - `serverDefines(env)` gives the same entries minus `NODE_ENV`, except that an unset name is **left out**. The
    server then reads it from the process at run time, as Next's server did.
- Produces `vite.config.ts`:
  - `root: "src/client"`, `build.outDir: "../../dist/client"`, `build.manifest: true`, `publicDir: false`;
  - `build.target: ["chrome111", "edge111", "firefox114", "safari16.4"]`: Next's list, with Firefox at 114 for module
    workers (I28);
  - `worker.format: "es"` (I28; `"iife"` with the four `type` options removed if the owner declines);
  - `resolve.alias` `@` to `src`, `define: clientDefines(process.env)`, plugins `react()` and `tailwindcss()`;
  - a `build.rollupOptions.onwarn` that drops only the "Module level directives" warning (Task 13 removes the lines);
  - `ssr.noExternal` set, so the SSR build of `prerender.tsx` bundles the app.
- Produces `tools/build/prerender.mjs`. It loads `dist/prerender/prerender.js`, fills `<!--app-boot-->` (the boot
  scripts and the JSON-LD block) and `<!--app-shell-->`, and writes `dist/client/index.html` with `<!--app-head-->`
  left for the server. It also writes `dist/client/page.json`:
  `{ scriptHashes: string[], fontPreloads: { href: string, type: string }[] }`.
  - The hashes are `'sha256-<base64>'` of every inline executable script in the final HTML. JSON-LD is excluded: a
    data block is not a script.
  - `fontPreloads` is, by default (I27 undecided), the font files Next's baseline `Link` header names, in the same
    order, mapped to their hashed `/assets` names through the Vite manifest. With I27 approved it holds the Inter
    files only. That one constant, `PRELOAD_ALL_FONTS` in `prerender.mjs`, is the switch.
- Script: `"build:client": "node tools/copy-highs-wasm.mjs && vite build && vite build --ssr prerender.tsx --outDir ../../dist/prerender && node tools/build/prerender.mjs"`.

`fonts.css` copies the baseline CSS's `@font-face` rules for every face: the generated `* Fallback` faces with their
metric overrides, and OpenDyslexic's `size-adjust: 82%`. Each `url()` points at `../app/fonts/<file>` (moved in
Task 12). The variables go on `:root`: `--font-minecraft`, `--font-inter`, `--font-jetbrains-mono`, `--font-lexend`,
`--font-atkinson`, `--font-andika`, `--font-comic-neue`, `--font-open-dyslexic`. Each holds the family list Next
generated (for example `'Inter', 'Inter Fallback'`). Next's `__Inter_<hash>` family names may become plain names;
that changes no rendering.

- [ ] **Step 1: Write the failing tests.**

```ts
// client-env.test.ts walks the source import graph from src/client/main.tsx and the four *.worker.ts (no build)
it("browser code reads only the defined process.env names, unguarded", () => {
  expect([...new Set(unguardedProcessEnvReads(entries))].sort()).toEqual(Object.keys(clientDefines({})).map(stripPrefix).sort());
});
it("every other process read in browser code sits behind typeof process", () => {
  expect(guardedProcessReads(entries)).toEqual([
    "src/lib/board-arrange.ts:ARRANGE_DEBUG", "src/lib/board-arrange.ts:ARRANGE_DEBUG",
    "src/lib/solver/simplex.ts:SIMPLEX_DEBUG", "src/lib/solver/simplex.ts:SIMPLEX_DEBUG",
  ]);
});
it("reads Reflect.get(process.env) only in deployment-features.ts, behind typeof window", () => { /* ... */ });
// define.test.mjs
it("leaves an unset NEXT_PUBLIC name undefined in the browser and out of the server defines", () => {
  expect(clientDefines({})["process.env.NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL"]).toBe("undefined");
  expect("process.env.NEXT_PUBLIC_SITE_URL" in serverDefines({})).toBe(false);
  expect(clientDefines({})["process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY"]).toBe('""');
});
// src/lib/datasets/remote.test.ts (added case)
it("falls back to the served manifest path when the build names none", () => { /* stubEnv undefined: DEFAULT_DATASET_MANIFEST_URL is "/datasets/gtnh/datasets.manifest.json" */ });
// prerender.test.tsx
it("renders the shell with the boot scripts layout.tsx had", () => { /* bootScripts[0] contains the storage key; shell has the noscript text */ });
```

- [ ] **Step 2: Run:** `npx vitest run src/client tools/build src/lib/datasets/remote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Install.** `npm install --save-exact -D @vitejs/plugin-react@6.1.2 @tailwindcss/vite@4.3.0 --before=...`,
  then `node scratch/dep-age.mjs` and `npm run audit:gate`.
- [ ] **Step 4: Implement the files above.** Add `{ type: "module" }` at the four `new Worker(...)` sites.
- [ ] **Step 5: Build and check the output.**
  `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3770 GTNH_BUILD_ID=baseline-3a41db6d npm run build:client`. Expected:
  - `dist/client/index.html` holds the shell markup and two boot scripts;
  - `dist/client/page.json` holds 2 hashes and as many font preloads as the baseline `Link` header;
  - `dist/client/assets/` holds four `*.worker-*.js` files;
  - `grep -oE '.{30}process\.env.{0,30}' dist/client/assets/*.js` prints only what `client-env.test.ts` lists: the
    four `typeof process`-guarded `ARRANGE_DEBUG`/`SIMPLEX_DEBUG` reads, and `deployment-features.ts`'s
    `Reflect.get(process.env, NAME)` behind `typeof window`.
- [ ] **Step 6: Compare the CSS at parse level.** A test-local script in `scratch/` parses
  `dist/client/assets/index-*.css` and the baseline's CSS chunk with `postcss` (installed through Tailwind), drops
  `@font-face` and the font-variable declarations, and compares the sets of (selector, at-rule context, declaration)
  triples. Expected: equal. A difference means `@source` or the plugin version is off.
- [ ] **Step 7: Run the suite (Next's `npm run build` stays green) and commit.**
  `git commit -m "I25 Vite builds the browser bundle and a prerendered shell, with the fonts self-hosted"`

### Task 8: The page on Express: head injection, `/`, `/community`, site files, CSP hashes

**Files:**
- Create: `src/server/page/template.ts`, `src/server/page/home.ts`, `src/server/page/community.ts`,
  `src/server/page/site-routes.ts`
- Create: `src/server/page/page.test.ts`, `tools/http-parity/browser-check.mjs`
- Modify: `src/server/app.ts` (the page and site routes after `ROUTES`)

**Interfaces:**
- Consumes: from Task 3, `renderHead`, `headForRequest`, `siteHead`, `sitemapEntries`, `sitemapXml`, `robotsTxt`,
  `webManifest`, `llmsText` and `ttlMemo`; from Task 7, `dist/client/index.html` and `page.json`.
- Produces `template.ts`:
  - `interface PageTemplate { html: string; scriptHashes: string[]; fontPreloads: { href: string; type: string }[] }`;
  - `loadPageTemplate(clientDir: string): PageTemplate`, read once at start;
  - `renderPage(template: PageTemplate, head: string): string`, which puts `head` at `<!--app-head-->`.
- Produces `home.ts`: `homePage(template): RequestHandler`. It serves `GET /` and `HEAD /` with
  `headForRequest(searchParams)` rendered against `siteUrl()`, the baseline's `Cache-Control` for `/`,
  `Content-Type: text/html; charset=utf-8`, and the baseline's `Link` header format built from `fontPreloads`.
- Produces `community.ts`: `communityRedirect(): RequestHandler`. With the switch off it falls through to the 404;
  otherwise it answers the baseline's status and `location` (`/?plan=<encoded>` or `/`).
- Produces `site-routes.ts`: `siteRoutes(): Router`:
  - `/sitemap.xml` and `/llms.txt`, each through `ttlMemo(3_600_000, ...)`, with the baseline's `Cache-Control`;
  - `/robots.txt` and `/manifest.webmanifest`;
  - `/favicon.ico` and `/opengraph-image.png`: files from `src/app/` (moved in Task 12) with the baseline's
    `Cache-Control`.
- `createApp` puts the template's `scriptHashes` into `env.scriptHashes`, so the production document policy has no
  `'unsafe-inline'` for scripts.

- [ ] **Step 1: Write the failing tests** (`page.test.ts`, against `createApp` with a fixture template):

```ts
it("serves / with the site head, the shell and Next's cache-control", async () => { /* ... */ });
it("serves /?plan=<id> with the plan's head, escaped", async () => { /* hostile name stays text */ });
it("keeps the plan head off while the community switch is off", async () => { /* ... */ });
it("redirects /community and /community?plan=x as Next did, and 404s it with the switch off", async () => { /* ... */ });
it("serves sitemap and llms.txt from memory for an hour", async () => { /* a second call within the ttl does not query */ });
it("answers script-src with the page's hashes and no 'unsafe-inline' in production", async () => { /* CSP header of / */ });
it("sends the Link preload header Next sent, by asset bytes", async () => { /* page.json order and types */ });
```

- [ ] **Step 2: Run, implement, rerun:** `npx vitest run src/server`. FAIL first, then PASS.
- [ ] **Step 3: Write `tools/http-parity/browser-check.mjs`.** It runs headless Chromium and Firefox through
  `playwright-core`, with a fresh profile, and takes `--base <url>`.
  - An `addInitScript` installs, before any page script:
    - a `securitypolicyviolation` listener;
    - a `MutationObserver` on `document.documentElement` that records the first `data-app-font` value, together with
      whether the module entry had started. The entry's first line in `main.tsx` sets `window.__gtnhEntryStarted = true`,
      so the flag shows it.
  - It loads `/` and asserts no `pageerror`, no console message matching `/hydrat/i`, and no policy violation. It
    asserts that the Welcome tab renders, a new design opens, and a recipe card solves (the solver worker ran
    `highs.wasm`).
  - It sets `localStorage["<APP_FONT_STORAGE_KEY>"] = "minecraft"` and reloads. It asserts that the observer saw
    `data-app-font = "minecraft"` with `__gtnhEntryStarted` still unset: the boot script stamped it, not
    `AppFontRestore`.
  - It exits 1 on any failure.
- [ ] **Step 4: Run the suite and commit.**
  `git commit -m "I25 Express serves the prerendered page with its head per request, the site files and a hash-based script policy"`

### Task 9: Server entries: production main, dev server, build, SIGTERM, timeouts

> **Removed by I31:** the server bundle carries no `@vercel/og`: no `require`/`__dirname` banner for it and no `hb.wasm`, `resvg.wasm` or font files beside the bundle.

**Files:**
- Create: `src/server/main.ts`, `src/server/dev.ts`, `src/server/shutdown.ts`, `src/server/main.test.ts`,
  `src/server/test-support/start.ts`, `src/lib/server/lifecycle.ts`, `tools/build/build-server.mjs`,
  `tools/build/build-server.test.mjs`
- Modify: `package.json` scripts `build:server`, `build:express`, `start:express`, `dev:express`
- Modify: `tools/dev-local.mjs` (`--express` starts `src/server/dev.ts` instead of `next dev`; the default switches in Task 11)
- Not touched: `src/instrumentation.test.ts` (Next's; it goes in Task 12)

**Interfaces:**
- Consumes: `checkServerSetupOrExit`, `prewarmDatasetVersions`, `writeServedDatasetClientFiles` (unchanged),
  `createApp`, `loadPageTemplate`.
- Produces `src/lib/server/lifecycle.ts`: `closeServerResources(): Promise<void>`, which closes the database pool
  (`closeDb()`). This is new: Next's `server.js` does not close the pool on SIGTERM. It is harmless, since the
  process exits, and live already does the same. It lives in `src/lib/server`, so `src/server/**` never imports the
  database layer (rule 4, Task 12).
- Produces `main.ts`: `async function startServer(options?: StartOptions): Promise<{ server: http.Server; ready: Promise<void>; port: number }>`, with
  `interface StartOptions { port?: number; host?: string; cwd?: string; prewarm?: () => Promise<void>; writeClientFiles?: () => Promise<void>; setupCheck?: () => void; requestTimeoutMs?: number; graceMs?: number; exit?: (code: number) => void; signals?: boolean }`.
  - The defaults are the real functions:
    - `port`: `PORT` or 3000;
    - `host`: `HOSTNAME` or `0.0.0.0`, as Next's `server.js`;
    - `requestTimeoutMs`: 300,000, Node's and Next's default, set explicitly;
    - `graceMs`: 15,000, under compose's 20 s;
    - `exit`: `process.exit`;
    - `signals`: true.
  - `setupCheck()` runs first. Then the server listens at once and holds requests behind `ready`, as Next held them
    behind `register()`.
  - With `GTNH_PREWARM_ON_STARTUP=1`, `ready` resolves after `prewarm()` settles (a failure is logged and `ready`
    still resolves), and then `writeClientFiles()` runs in the background.
  - `headersTimeout` and `keepAliveTimeout` keep Node's defaults, as Next does.
  - `NODE_ENV` is `production` before any import is evaluated, as Next's `server.js` sets it before it requires
    anything. ESM evaluates every static import before the module body, and externals such as `react/jsx-runtime`
    pick their dev or prod build when they load, so a first line in the bundle runs too late. The fix is a two-file
    entry:
    - `dist/server/server.mjs`, written by `build-server.mjs` (`writeEntry(outDir)`), holds only
      `process.env.NODE_ENV ??= "production"; const { startServer } = await import("./app.mjs"); await startServer();`;
    - `dist/server/app.mjs` is the esbuild bundle of `main.ts`.

    `main.ts` only exports `startServer`; it never listens on import, so `main.test.ts` imports it without starting a
    server. The entry is the one place that starts it. `src/server/test-support/start.ts` does the same for the
    spawned SIGTERM test (`import { startServer } from "../main"; void startServer();`), since that test runs the
    source through `tsx`, not the bundle. It has no top-level `await`: tsx compiles a `.ts` file to CJS and refuses
    one there. The image's `ENV NODE_ENV=production` already covers production.
    The security env's `production` comes from `NODE_ENV`, so a local `start:express` gets the production policy.
- Produces `shutdown.ts`: `installShutdown(server: http.Server, options: { graceMs: number; exit: (code: number) => void; close: () => Promise<void> }): () => Promise<void>`.
  It returns the shutdown function, which a SIGTERM or SIGINT calls: stop accepting, close idle connections, let open
  requests finish, then `close()` (`closeServerResources`) and `exit(143)`. Past `graceMs` it closes all connections
  and exits 143. A second signal exits at once.
- Produces `dev.ts`:
  - Vite `createServer({ server: { middlewareMode: true }, appType: "custom" })`, and
    `createApp({ before: [vite.middlewares], page: devPage(vite) })`;
  - `devPage` runs `vite.transformIndexHtml` on the template, with the boot scripts from
    `vite.ssrLoadModule("/prerender.tsx")` and no shell;
  - the env is dev (`production: false`: the policy keeps `'unsafe-inline'` and `'unsafe-eval'`).
- Scripts:
  - `"build:server": "node tools/build/build-server.mjs"`: esbuild with `src/server/main.ts`, `--bundle --platform=node --format=esm --target=node22 --packages=external`,
    `--outfile=dist/server/app.mjs --metafile=dist/server/meta.json`, and `define: serverDefines(process.env)`, then
    `writeEntry("dist/server")` for `server.mjs`. `tools/build/build-server.test.mjs` holds the three entry tests
    below;
  - `"build:express": "npm run build:client && npm run build:server"`;
  - `"start:express": "node dist/server/server.mjs"`;
  - `"dev:express": "node tools/copy-highs-wasm.mjs && tsx watch --clear-screen=false --include src/server --include src/lib/server src/server/dev.ts"`.

- [ ] **Step 1: Write the failing tests** (`main.test.ts`). They run in process through `startServer` with injected
  functions, plus one spawned test for the real signal path:

```ts
it("runs the setup check, then the prewarm, then the client files, in that order", async () => {
  const calls: string[] = [];
  const { ready } = await startServer({ port: 0, setupCheck: () => calls.push("check"), prewarm: async () => { calls.push("prewarm"); },
                                        writeClientFiles: async () => { calls.push("files"); }, signals: false });
  await ready; await tick();
  expect(calls).toEqual(["check", "prewarm", "files"]);
});
it("holds the first request until the prewarm settles, and serves after a failed prewarm", async () => { /* deferred prewarm */ });
it("finishes an open request on shutdown, refuses new connections, closes the database and exits 143", async () => {
  /* signals: false, installShutdown's returned function called directly; exit spy */
});
it("exits 143 within the grace when a client holds a connection open", async () => { /* graceMs: 200 */ });
it("exits 143 on shutdown while the prewarm is still running", async () => { /* never-resolving prewarm */ });
it("uses Node's 300 s request timeout unless told otherwise, and cuts a sender that stops halfway", async () => {
  expect((await startServer({ port: 0, signals: false })).server.requestTimeout).toBe(300_000);
  /* requestTimeoutMs: 300, a half-sent body: the socket is closed */
});
it("answers 413 to a chunked body over the route's cap, delivers it, and stops at the drain bound", async () => { /* login route, 64 KiB chunked, strict */ });
it("sets NODE_ENV to production before any module the bundle imports is evaluated", async () => {
  // in tools/build/build-server.test.mjs: writeEntry(tmp) beside a stand-in app.mjs that statically imports dep.mjs,
  // which prints process.env.NODE_ENV at load, and exports a startServer that does nothing. Spawned with NODE_ENV
  // removed from the env, dep.mjs prints "production"
});
it("leaves a NODE_ENV the caller set alone", async () => { /* NODE_ENV=test: dep.mjs prints "test" */ });
it("starts the server from server.mjs", async () => {
  // in tools/build/build-server.test.mjs: writeEntry(tmp) beside a stand-in app.mjs whose startServer listens on
  // port 0 and prints the port. Spawned: the printed port accepts a connection and answers; then SIGTERM
});
it("does not listen when main.ts is imported", async () => { /* import ./main: no new listening handle, no port bound */ });
it("exits 143 on a real SIGTERM", async () => { /* spawn tsx src/server/test-support/start.ts with PORT=0 and fixture dirs; kill SIGTERM; code 143 */ });
```

- [ ] **Step 2: Run, implement, rerun.** Then build and smoke-start:
  `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3770 GTNH_BUILD_ID=baseline-3a41db6d npm run build:express && PORT=3770 GTNH_PREWARM_ON_STARTUP=1 npm run start:express`.
  Expected: `/api/version` answers 200 once the prewarm log line has printed, and its CSP is the production policy.
- [ ] **Step 3: Check the dev server.** Run `npm run dev:express` and open `http://localhost:3000` headless
  (Playwright, `waitUntil: "load"`). Check that editing a component hot-swaps it and editing a route restarts the
  server.
- [ ] **Step 4: Run the suite and commit.**
  `git commit -m "I25 Express has a production entry that prewarms and drains on SIGTERM, a Vite dev server and a build"`

### Task 10: Parity run, perf and memory (fix commits only)

> **Removed by I31:** the card pixel compare is dropped, and `/?plan=<id>` has no image tag of its own: the site's `opengraph-image.png` stands.

**Files:** none planned. Each fix found here is its own commit, in the module that owns the behaviour, with a test
that pins it.

- [ ] **Step 1: Capture Express in both modes.** For each mode, build with the Task 0 build values
  (`npm run build:express`, so `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3770`), start on port 3770 with the same
  database setup and `GTNH_CLIENT_FILES_DIR` as Task 1 step 6, and run
  `capture.mjs ... --out scratch/parity/express-<mode>`.
- [ ] **Step 2: Compare.**
  `node tools/http-parity/compare.mjs scratch/parity/next-<mode> scratch/parity/express-<mode> --allow tools/http-parity/allowed-differences.json`.
  Expected: exit 0. Any other difference is fixed, or put to the reviewer with a reason before it goes on the list.
- [ ] **Step 3: Compare the metadata tags and the shell.**
  - Metadata tags: from both captures of `/`, `/?plan=<id>` and `/?plan=missing`, take the `<head>`, filter out the
    framework tags (the Task 1 step 7 rule), and compare the rest tag by tag, in order.
  - Shell: compare the markup inside `<body>` up to the first framework script, with Next's suspense comments
    (`<!--$-->`, `<!--/$-->`) and the `#root` wrapper removed.

  Expected: identical.
- [ ] **Step 4: Golden harness (dataset evidence only).**
  `npx vitest run src/lib/server/dataset-responses.local.test.ts --config vitest.local.config.ts` in the express
  worktree. Expected: every hash matches the Task 0 baseline. This shows that the dataset query layer is untouched.
  The HTTP evidence for dataset bytes is step 2's dataset sweep.
- [ ] **Step 5: Run the browser check on both servers.** `node tools/http-parity/browser-check.mjs --base http://127.0.0.1:3770`
  against each in turn. Expected: both pass. A failure on Next is a check bug.
- [ ] **Step 6: Board perf.** Run 3 `stress.mjs` runs against Express (`--label express`), then
  `node tools/perf/ab.mjs scratch/perf/next-*.json` and `node tools/perf/ab.mjs scratch/perf/express-*.json`.
  Expected: Express fps and p95 within run-to-run noise of Next (no scenario's mean worse by more than 5%).
- [ ] **Step 7: Memory and start.** For each server, measure RSS idle (no prewarm) and after both datasets are
  prewarmed, and the time to the first `/api/version` answer (median of 3 starts). Record the numbers in the task
  report. They are measurements, not gates.
- [ ] **Step 8: Run the smoke test without Caddy.** Start the live service as `dev-local` does, on :3001
  (`LIVE_PORT=3001 npx tsx src/live/main.ts` with dev-local's env), then
  `node tools/deploy/smoke.mjs --base http://127.0.0.1:3770 --live http://127.0.0.1:3001 --skip-accounts`.
  Expected: all ok, except the checks that are Next-only (fixed in Task 11).

### Task 11: The cut: scripts, image, smoke, deploy docs

**Files:**
- Modify: `package.json`. `dev` takes `dev:express`'s command, `build` takes `build:express`'s, and `start` takes
  `start:express`'s. The `*:express` aliases go. `predev` and `prebuild` stay.
- Modify: `tools/dev-local.mjs` (Express by default; the `--express` flag goes)
- Modify: `Dockerfile`:
  - the `build` stage runs `npm run build` (now Express) plus `build:live`, and its cache mount `gtnh-next-cache` goes;
  - its `chmod -R a+rX,go-w` list gains `dist`;
  - a new `site-deps` stage runs `live-deps.mjs` over `dist/server/meta.json` into `/site`;
  - the `site` stage copies `/site/node_modules`, `public`, `src/app/fonts`, `deploy/check-env.mjs`, `dist/client` and
    `dist/server`, and its CMD is `["node", "dist/server/server.mjs"]`;
  - `mkdir -p /app/.next/cache` with its `chown` stays for this release only, since compose still mounts a tmpfs
    there (Task 14);
  - `NEXT_TELEMETRY_DISABLED` goes, and the header comments describe the new layout.
- Modify: `.dockerignore` (`!tools/build/` is already there from Task 3; `dist`)
- Modify: `tools/deploy/smoke.mjs`:
  - the `/_next/image` check becomes "an unknown path answers 404 with the security headers";
  - add: `script-src` without `'unsafe-inline'`, behind `--expect-hashed-csp`, which is on by default from this commit
    (Task 14 step 1 runs the old smoke anyway);
  - add: `/api/version/` and `//api/version` 308 with `Refresh`, and `/API/version` 404;
  - add: a cross-site POST to `/API/community/auth/logout` is not 2xx;
  - add, with `--caddy`: `/` and one `/assets/*.js` carry `Content-Encoding` when asked with `Accept-Encoding: gzip`,
    and a lookup index answer's bytes hash the same with and without `Accept-Encoding`;
  - the browser pass also runs `browser-check.mjs`'s policy and hydration listeners.
- Modify: `docs/deploy.md`:
  - "What runs": SIGTERM, and no `.next` written on the read-only filesystem;
  - "Build cache": no `next build` cache mount; the site image is the esbuild bundle plus its package closure;
  - "Server side": Caddy `encode zstd gzip` on the site route. The body timeout note says the app answers an
    over-cap body's 413 at once, then reads and discards the rest up to its drain bound (`BODY_HARD_CAP_BYTES` + 4 MiB,
    31 s idle, 35 s total, both kept above Caddy's 30 s so Caddy fires first and a stalled upload still gets the 413
    rather than a 502) and closes. The server stops reading at that bound, not at the route's cap, and an answer
    past the byte bound may be lost; Caddy's 8 MB limit and 30 s body timeout stay the outer bounds;
  - "Smoke test".
- Modify: `tools/deploy/live-deps.test.mjs` (a case for the site metafile)
- Optional (I29, only if approved): `.github/workflows/ci.yml` gains a job running `npm ci && npm run build` with
  `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 GTNH_BUILD_ID=ci-${{ github.sha }}`.
- Not touched: `tools/deploy/deploy.sh`, `deploy-lib.mjs`, `docker-bake.hcl`, `docker-compose.yml`. None of them
  names Next. The deploy builds the same three targets and waits for `/api/version` to name the build, as before.

**Interfaces:**
- Consumes: everything above.
- Produces: an image whose `site` target serves Express, with the same ports, env, labels and healthcheck.

- [ ] **Step 1: Write the failing test.** In `tools/deploy/live-deps.test.mjs`: "collects the site bundle's closure,
  with `highs` and `@vercel/og` in it" (the highs route and the card read files from `node_modules` at run time).
- [ ] **Step 2: Make the changes above.** Run `npm run typecheck && npm run test && npm run build`.
- [ ] **Step 3: Build the image the way the deploy does.** In a directory holding `git archive HEAD`:
  `TAG=rehearsal-express SITE_URL=http://127.0.0.1:3480 docker buildx bake -f tools/deploy/docker-bake.hcl --load`.
  Expected: the bake succeeds, and `docker run --rm gtnh-site:rehearsal-express node -e "import('express')"` exits 0.
- [ ] **Step 4: Run the workstation rehearsal.** Follow `docs/deploy.md` "Rehearsal" steps 2 to 7 with the new image.
  Expected:
  - migrate runs twice as documented;
  - the smoke is all ok;
  - a database restart under load recovers;
  - `tools/live/test-client.mjs --base http://127.0.0.1:3480` passes.
- [ ] **Step 5: Commit.** `git commit -m "I25 The site image, dev and start scripts run on Express; the smoke test checks the new rules"`

### Task 12: Remove Next, move the handlers, rewrite the layer rules

**Files:**
- Delete:
  - `next.config.ts`, `next-env.d.ts`, `body-limits.config.ts`, `postcss.config.mjs`;
  - `src/proxy.ts` and `src/proxy.test.ts` (its cases now live in `app-gate.test.ts`);
  - `src/instrumentation.ts` and `src/instrumentation.test.ts` (now `main.test.ts`);
  - `src/lib/next-config.test.ts` and `src/lib/server/next-config.test.ts` (both ported in Tasks 5 and 6);
  - `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/community/page.tsx`, `src/app/sitemap.ts`, `src/app/robots.ts`,
    `src/app/manifest.ts`, `src/app/site-metadata.ts`.
- Move (`git mv`, imports only):
  - `src/app/api/**`, `src/app/dataset-files/**`, `src/app/datasets/**` and `src/app/llms.txt/**` go to
    `src/server/routes/**` with the same folder names;
  - `src/app/globals.css` goes to `src/client/globals.css`, with its `@source` paths adjusted. Its readers move with
    it: `src/lib/app-font.test.ts:26,51` and `src/components/flow/scroll-camera.test.ts:43`, plus `main.tsx`'s import;
  - `src/app/fonts/` goes to `src/client/fonts/` (`fonts.css` `url()`s, the card route's font path, the Dockerfile
    `COPY`);
  - `src/app/favicon.ico` and `src/app/opengraph-image.*` go to `src/server/page/assets/` (`site-routes.ts`);
  - `src/app/dev/clean-card/` goes to `src/client/dev/clean-card/`: a second Vite input in dev only, served by
    `dev.ts` at `/dev/clean-card`.
- Port: `src/app/mod-and-community-pages.test.ts` goes to `src/server/page/mod-and-community.test.ts` (the same cases
  against the new modules), and `src/app/api/wire-format.test.ts` to `src/server/routes/api/wire-format.test.ts`.
- Modify: each moved route drops its `export const runtime/dynamic/revalidate` lines and `generateStaticParams`.
- Modify: `src/server/http/route-table.ts` (import paths; `routePathForFile` reads `src/server/routes`), and
  `tsconfig.json` (drop the `next` plugin and the `.next` includes).
- Modify: `src/lib/server/http/request-body.ts`. `PROXY_BODY_MAX_BYTES` becomes `BODY_HARD_CAP_BYTES`, defined there,
  and the comments say what the adapter does, not what Next did.
- Modify: `src/lib/server/http/security-headers.ts` (moved from `security-headers.config.ts`; the "beside
  next.config" comments go), and `src/lib/security-headers.test.ts`, which moves beside it.
- Modify: `src/architecture.test.ts` and `src/architecture-allowlist.json`.
- Modify: AGENTS.md:
  - "Layers";
  - "Commands";
  - the area table's server row;
  - "Probing the real app": `next start` becomes `npm run start`, and `.next/standalone` becomes
    `dist/server/server.mjs`.
- Modify: the area notes:
  - `src/lib/server/CLAUDE.md`: the title, plus the dataset gate, prewarm, security headers, request bodies and
    mod-and-community sections, which say Next today;
  - `src/components/CLAUDE.md`, `src/store/CLAUDE.md` and `src/live/CLAUDE.md`: the `NEXT_PUBLIC_*` notes. The names
    are unchanged; they are inlined by Vite and esbuild now.
- Modify: `package.json`. Run `npm uninstall next eslint-config-next @tailwindcss/postcss`, then
  `node scratch/dep-age.mjs` (it removes only) and `npm run audit:gate`.

**Layer rules after this task** (`src/architecture.test.ts`; AGENTS.md "Layers" says the same in words):

| Rule | Was | Becomes |
|---|---|---|
| classifier `isRouteHandler` | `src/app/**/route.ts(x)` or `src/app/sitemap.ts` | `src/server/**` other than `src/server/dev.ts` and tests: the web server (routes, middleware, adapter, page, entries) |
| 1 | the domain loads no React, Zustand, React Flow, Node, Next, `ws` or database package | the same list with `express` and `vite` added, `next` kept (`isImpurePackage`) |
| 3 | `src/lib/server/**` never imports `src/{components,store,app,live}` or React | never imports `src/{components,store,client,server,live}` or React |
| 4 | route handlers never import the database layer, the UI or the stores, and send no query | the web server never imports the database layer, the UI, the stores or `src/client`, and sends no query (`queryingAppFiles` reads `src/server/`). It releases the pool through `src/lib/server/lifecycle.ts` (Task 9), so no exception is needed |
| 5 | `src/live` never imports `src/{app,components,store}` | never imports `src/{server,client,components,store}` |
| 6 | browser code = the UI, the stores, every `"use client"` file and worker, and what they load | browser code = what `src/client/main.tsx`, `src/client/prerender.tsx` and every `*.worker.ts` reach, plus the UI and the stores, type-only edges skipped as today. `"use client"` no longer counts (Task 13 removes the lines) |
| new 14 | | only `src/server/**` (and `tools/`) imports `express`; only `src/server/dev.ts`, `vite.config.ts` and `tools/` import `vite`; no file under `src/` or `tools/` imports `next` or `next/*`. No allowlist entries |
| services check | services never import `next/*` | services never import `express` or `next/*` |
| exemptions | tests, `__fixtures__/`, `test-support/`, `src/app/dev/**` | tests, `__fixtures__/`, `test-support/`, `src/client/dev/**` |
| `SKIPPED_DIRECTORIES` | `.next` | `dist` (and `.next` while old checkouts have one) |

The one rule-4 allowlist entry (the card route importing `src/components/flow/tier-colors.ts`) changes its `from`
path to the moved file, so `MAX_ALLOWED["4"]` stays at 1. The architecture fixture tests that name
`src/app/api/arch-fixture/route.ts` use `src/server/routes/api/arch-fixture/route.ts` instead. A move must never
make a rule match nothing:

```ts
it("each layer rule's classifier matches real files", () => {
  expect(files.filter(isRouteHandler).length).toBeGreaterThan(39);
  expect(files.filter(isClientEntryFile).length).toBe(6); // main.tsx, prerender.tsx, the four *.worker.ts
});
```

- [ ] **Step 1: Write the new architecture tests first** (rule 14, the classifier test, rule 6 from the entries) and
  run them. Expected: FAIL (`next` is still imported, `src/server/routes` is empty).
- [ ] **Step 2: Do the moves and deletions,** `git mv` first and import edits after, so git sees renames.
- [ ] **Step 3: Rewrite the classifiers and rules** as in the table. Run `ARCH_DUMP=1 npx vitest run src/architecture.test.ts`
  only if an entry was fixed. Expected after that: the allowlist counts equal `MAX_ALLOWED`.
- [ ] **Step 4: Check that nothing names Next.**
  `git grep -n -i "next\.config\|next/\|\bnext build\|next start\|next dev\|NextResponse\|_next/" -- ':!docs/superpowers' ':!package-lock.json'`.
  Expected: only `.next` in `SKIPPED_DIRECTORIES`, and the `_next/static` worker-policy path in `security-headers.ts`.
  Drop that path too, since nothing serves it now, and adjust its test.
- [ ] **Step 5: Run the suite and both builds.** `npm run typecheck && npm run test && npm run build`, then repeat
  Task 10 steps 1 and 2 for mode `on`. Expected: still no unlisted parity difference.
- [ ] **Step 6: Commit.** `git commit -m "I25 Next is gone: handlers live under src/server/routes and the layer rules name the new layout"`

### Task 13: `"use client"` lines and lint

**Files:**
- Modify: the 213 files that start with `"use client";` (the line and the blank line after it go)
- Modify: `eslint.config.mjs` (`typescript-eslint` recommended, `eslint-plugin-react-hooks` recommended and
  `eslint-config-prettier`; ignores `dist/**` and `scratch/**`), and `package.json` (`typescript-eslint` 8.72.0 and
  `eslint-plugin-react-hooks` 7.1.1, both dev)
- Modify: `vite.config.ts` (the `onwarn` filter goes)

- [ ] **Step 1: Write the failing test.** Add to `src/architecture.test.ts`: "no source file carries a 'use client'
  directive". The directive means nothing without Next.
- [ ] **Step 2: Run the codemod.** A one-off `scratch/strip-use-client.mjs` removes only a first statement equal to
  `"use client";` (or `'use client';`) and the empty line after it.
- [ ] **Step 3: Install and run lint.** `npm install --save-exact -D typescript-eslint@8.72.0 eslint-plugin-react-hooks@7.1.1 --before=...`,
  then `node scratch/dep-age.mjs`, `npm run audit:gate` and `npm run lint`. Expected: no error the old config did not
  also report. The new warnings are listed in the report and left unfixed here.
- [ ] **Step 4: Run the suite and the build, then commit.**
  `git commit -m "I25 Source files drop the framework's 'use client' directive and lint runs without the Next config"`

### Task 14: Stage rehearsal and deploy order (the manager)

Nothing here is the implementer's. The manager runs it, once per instruction, after the branch is reviewed, merged
into `main` (fast-forward) and pushed.

1. **Infra change first** (the owner applies it in `iDeBugger/infra`).
   - In `roles/caddy/templates/Caddyfile.j2`, the stage block's site route (the `127.0.0.1:3300` handle, not `/live`)
     gets `encode zstd gzip`.
   - Caddy leaves an answer that already has `Content-Encoding` alone, so this can land while Next still runs (Next
     compresses today, and the client-file br/gzip answers keep their own encoding).
   - Check after the reload: `curl -sI -H 'Accept-Encoding: gzip' https://stage.gtnhplanner.idebugger.net/ | grep -i content-encoding`
     prints `gzip`.
   - Then run the **old** smoke: `git show 3a41db6d:tools/deploy/smoke.mjs > scratch/smoke-old.mjs && node scratch/smoke-old.mjs --base https://stage.gtnhplanner.idebugger.net --caddy`.
     The new smoke expects the hashed policy, which Next does not send.
   - The compose file does not change in this release, so the deploy's byte-copy check needs no infra commit.
2. **Pre-deploy capture.** Run
   `capture.mjs --base https://stage.gtnhplanner.idebugger.net --host stage.gtnhplanner.idebugger.net --no-forwarded --mode off --only '^(page|static|datasets|version|gate|path)'`
   into `scratch/parity/stage-next`. That is TLS with the real `Host`, and the `localOnly` cases are skipped. Read-only cases only: stage has real accounts, so no scenario run.
3. **Deploy:** `tools/deploy/deploy.sh stage`. Stage needs no version bump (the `build` field is the marker), and the
   script's `/api/version` check must name the new build.
4. **After the deploy:**
   - `node tools/deploy/smoke.mjs --base https://stage.gtnhplanner.idebugger.net --caddy`;
   - `node tools/live/test-client.mjs --base https://stage.gtnhplanner.idebugger.net`;
   - the same `capture.mjs` read-only run (same `--host` and `--no-forwarded`) into `scratch/parity/stage-express`, then `compare.mjs` against step 2's
     capture with the allow list. Expected: no unlisted difference, with `content-encoding` now from Caddy;
   - `browser-check.mjs --base https://stage...`;
   - `docker stats gtnh-site` once prewarm is done, against the numbers in Task 10 step 7.
5. **Soak** for at least 48 h: `docker compose logs site` shows no error lines that were not there before, and the
   vhost's Caddy log shows no rise in 5xx.
6. **Rollback** if anything fails: `tools/deploy/deploy.sh stage --rollback <previous tag>`. The Caddy `encode` line
   can stay, since it is harmless with Next.
7. **Follow-up (separate, after the soak).** An app commit removes the `.next/cache` tmpfs from
   `tools/deploy/docker-compose.yml` and the `mkdir /app/.next/cache` from the Dockerfile. The infra role's byte copy
   follows in the same order as any compose change (`docs/deploy.md`).
8. **Public release.** When the public target exists, it follows the same order. Per AGENTS.md, check the target's
   `/api/version` first, bump `APP_VERSION` (patch: no features), and add a changelog entry. If decision 1 is
   approved, the entry can say that a shared link to a missing plan now shows the site's card.

## Needs an owner decision

1. **The share card's fallback origin (I3), the one intended wire change.** Want the missing-plan card redirect built
   from the configured site URL (`siteUrl()`), so that a shared link to a missing or hidden plan unfurls with the
   site's card instead of pointing at `https://0.0.0.0:3000/opengraph-image.png`.
   - Today Next takes the origin from its listen address, so every community-on build sends that unreachable URL.
     Stage has the switch off and answers 404 on the route, so this was read from Next's source, not seen on the wire.
   - Lands in: Task 2 (route and test), the Task 1 allow list, and Task 5 (the adapter's origin).
   - If declined, the adapter takes the URL origin from `http(s)://<HOSTNAME>:<PORT>` with the proto from
     `X-Forwarded-Proto`, as Next does, and the card test pins the old answer.
2. **Dependency age rule.** The default is on: the express core (Task 5) starts on 2026-10-29 at 13:22 UTC. If lifted,
   Task 5 step 1 runs at once without `--before`, and the lock takes `qs` 6.17.0.
3. **I27, font preloads.** Want only the default face (Inter) preloaded instead of all 17 files (about 2.5 MB on every
   first visit), so that a first visit loads less.
   - The default is parity: the same files in the same `Link` header.
   - Lands in: `PRELOAD_ALL_FONTS` in `tools/build/prerender.mjs` (Task 7), and the `link` entry in the Task 1 allow
     list.
   - With the change, a player who picked another font may see one swap from the fallback face on a cold load.
4. **I28, module workers.** Want module workers (`{ type: "module" }`, browser floor Firefox 114, Chrome 80,
   Safari 15), so that dev and build share one worker format, which Vite needs for workers in dev.
   - The default is module workers. Today's Next build targets Firefox 111.
   - Lands in: Task 7, at the four `new Worker` sites, `worker.format` and `build.target`.
   - If declined: `worker.format: "iife"` in the build, with the `type` options added in dev only, which means two
     formats to test.
5. **I29, CI build job.** Want an `npm run build` job in CI, so that a broken build shows up on the push and not at
   deploy.
   - The default is not added.
   - Lands in: Task 11, the optional `ci.yml` job.
