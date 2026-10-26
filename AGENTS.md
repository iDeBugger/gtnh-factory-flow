# AGENTS.md

GTNH Factory Flow: a production-chain planner for GregTech: New Horizons, live at
https://gtnhplanner.com. Next.js App Router, TypeScript strict, Tailwind, React Flow,
Zustand, Zod, Vitest. The repo is public.

This file is the always-loaded core. Each area keeps its own rules in a `CLAUDE.md`
beside its code, which Claude Code loads when you open files there. Read the area file
before changing that area; it names the tests that pin its behaviour.

| Area | Notes |
|---|---|
| Board: cards, drawers, boards, wires, routing, arrange, board perf | `src/components/flow/CLAUDE.md` |
| App UI: interface scale, compact mode, recipe search, inspector, sounds | `src/components/CLAUDE.md` |
| Pool worksheet | `src/components/pool/CLAUDE.md` |
| Solver: LP books, Build/Solve/Pool, drawers, shared machines, verdicts | `src/lib/solver/CLAUDE.md` |
| Machine math: overclocks, parallels, curated machine table, special machines | `src/lib/machines/CLAUDE.md` |
| Domain model: resources, cells vs fluids, oredict context, sections, boards | `src/lib/model/CLAUDE.md` |
| Power generation | `src/lib/power/CLAUDE.md` |
| Designs, tabs, saving, account sync, plan import/export, public view | `src/store/CLAUDE.md` |
| Server, recipe API, database (PostgREST), file store, cloud plans, local database | `src/lib/server/CLAUDE.md` |
| Live service: live plan editing over WebSockets | `src/live/CLAUDE.md`, `docs/live.md` |
| Dataset pipeline: export, normalize, rebuild, publish | `tools/dataset-pipeline/CLAUDE.md` |
| Deploy: Docker images, compose stack, deploy and dataset publish scripts | `docs/deploy.md` |

Longer references, read on demand: `docs/solver-equations.md` (solver doctrine),
`docs/power-planner-math.md` (the decoded power workbook), `docs/COMMUNITY.md`.

## Commands

```bash
npm run dev          # http://localhost:3000
npm run dev:local    # the same with a local database and the live service: no database credentials
npm run typecheck
npm run test         # full vitest suite, must be green
node tools/dataset-pipeline/scripts/build-datasets.mjs all --export   # build the datasets (Docker)
```

Scratch harnesses are `*.local.test.ts` (excluded from the suite); run one with
`npx vitest run <file> --config vitest.local.config.ts`.

## Working rules

- `main` is the only working branch; never start another. Commit and push finished work
  unless told otherwise. Never reset or revert changes you did not make. Unmerged
  experiments survive as `archive/*` tags.
- Push only to `origin` (`iDeBugger/gtnh-factory-flow`). `upstream` (Samiracle64, the
  original fork, long diverged) and `kewaii` are not push targets.
- CI runs typecheck, the full suite, a Chromium/Firefox icon-sizing check and the dependency
  audit gate (`npm run audit:gate`: production tree clean at moderate, whole tree at high)
  on every PR and push to main, and weekly. No tolerated failures. A test that pins
  player-facing copy changes in the same commit as the copy. An advisory that cannot be
  lifted goes in `tools/audit-allowlist.json` with a reason and an expiry at most 90 days
  out, never a loosened threshold.
- Nothing generated goes in the repo root. Screenshots, probe scripts, captures and logs go
  in the session scratchpad or `scratch/` (gitignored). Old Playwright probes live in
  `scratch/probes/`. Delete screenshots once you have looked at them.
- Check UI changes in the real app with Playwright; unit tests cannot see routing,
  layering or hover. Board performance changes need a before/after profile.
- Comments state the rule and why. No dates, names or "used to" stories; git has those.

## Player-facing copy

- Plain and short: the number, the rule, the consequence. No quips, no internal jargon,
  no em dashes.
- Recipes are read-only in the UI. No manual recipe editing unless asked.

## Releases and deploys

- Deploy only when explicitly told to, once per instruction, with
  `tools/deploy/deploy.sh <target>` (`docs/deploy.md`). Pushing `main` deploys nothing.
- `APP_VERSION` in `src/lib/version.ts` is bumped once per release: minor if the release
  carries features, patch if only fixes. First check the target's `/api/version` (its
  `version` field): behind `version.ts` means the last bump has not shipped, so fold new work
  into the top changelog entry; equal means bump and open a new entry. Stage deploys need no
  bump: the `build` field is their marker.
- Every release has an entry in `src/lib/changelog.ts`: concrete bullets about what
  changed for players. Players open it from the header's version chip (unread dot, stamp
  `changelog-read.v1`); nothing opens by itself. Shift-click the chip for the dev menu.
- A deploy succeeds only when the target's `/api/version` names this build; the script
  checks it. Datasets go out with `tools/deploy/publish-datasets.sh`, which checks the served
  manifest and the published gzips, not just local output.

## Production

- tungsten, the owner's server: Docker compose project `gtnh` (compose and `.env` in
  `/opt/gtnh`, data in `/srv/gtnh`), managed by the infra repo's `gtnh` role, with the host's
  Caddy in front. Stage (`https://stage.gtnhplanner.idebugger.net`) answers only on ZeroTier.
  Site and live listen on loopback 3300 and 3301. Diagnose with `docker compose logs site`
  (or `live`) and the vhost's Caddy log; `docs/deploy.md` has the rest.
- The server prewarms datasets on start when `GTNH_PREWARM_ON_STARTUP=1`
  (`src/instrumentation.ts`). A slow first API call means prewarm or deploy regressed;
  don't make the client wait longer.
- GTNH 2.9 and 2.8.1 datasets are supported; a plan belongs to one of them (src/store/CLAUDE.md, Plan version).

## Invariants across the app

- Raw exporter data is normalized by the pipeline before UI or solver code sees it.
  Prefer exported NEI/runtime data over hand-written tables and broad fallbacks.
- Board performance is a requirement: no DOM measurement per edge or per frame, nothing
  O(nodes x edges) per frame, hover never rebuilds the board.
- Every plan that arrives (import, paste, link, community copy) opens as a NEW design.
  Nothing overwrites the open design; no app path calls `setProject`.
- Display dials (rate units, power display) repaint numbers only. They never re-solve.
- A setting with no visible control must never be persisted: players get stuck in it,
  and a `finally` that restores it is not a durable undo.

## Probing the real app

- Playwright (`playwright-core` is a devDependency), always headless: a headed run takes
  over the owner's screen. Use `waitUntil: "load"`. Write probes into `scratch/probes/`.
- A hidden browser pane never fires `requestAnimationFrame`; shim it. A fresh profile
  lands on the Welcome tab. Production has no `window.__gtnhFlow`.
- The board pane is a million px square under the scroll camera: aim at the `.react-flow`
  wrapper's box. Tooltips move `title` to `data-tip-title`.
- Compare against old behaviour with `git worktree add` at that commit. A worktree needs
  its own `npm install`: never junction `node_modules` into one (Turbopack crashes, and
  `git worktree remove --force` follows the junction and empties the main repo's
  `node_modules`). Diff exported plans rather than trusting "same board" by eye.
- Measure performance on a production server with `GTNH_PREWARM_ON_STARTUP=1`, after prewarm,
  not on the dev server: `next start` (it warns that the build is standalone, and serves it) or, as
  the site image runs it, `node .next/standalone/server.js` with `.next/static` and `public/` copied beside it.
