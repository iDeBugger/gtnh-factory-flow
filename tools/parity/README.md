# A/B parity harness (website vs the mod)

Puts the website's board into the same state as each mod reference shot (`docs/design/backport/ref/*.png`, in the mod
repo worktree), captures it at the mod's scale, and compares.

## Run

```bash
# 1. dev server (Express with Vite)
GTNH_DATASET_BACKEND_URL=https://gtnhplanner.com PORT=3120 npm run dev

# 2. captures: tools/parity/out/<state>.side.png (mod left, web right), .ana.png (mod red, web cyan), index.html
node tools/parity/run.mjs                 # every state in states.mjs (about 8 min); or a regex: run.mjs 'drawer|rail'
# 3. assertions: HARD (website grid, colours), RATIO (mod proportions), BEHAVIOUR (what the mod's card does)
node tools/parity/assert.mjs              # exit 1 on a HARD failure; --strict also fails on BEHAVIOUR rows
```

Env: `PARITY_BASE` (default `http://localhost:3120`; point it at any worktree's dev server, e.g. a WP branch),
`PARITY_REF` (the folder of reference PNGs; default is the research worktree's `docs/design/backport/ref`).
Playwright comes from the repo's `playwright-core` and the cached Chromium; nothing to install.

## The scale mapping

The mod shots are 1920x1080 at GUI scale 2, so one GUI px is 2 device px and the mod card (320 GUI) is 640 px wide.
The website card is 380 css px, so the harness uses `deviceScaleFactor = 640/380 = 1.684`: **both cards are 640 device
px wide**, and the montage compares like with like. Because the website's rows, icons and chips keep their css size
(spec-ui section 1), everything but the card width is deliberately off by up to 380/320 = 1.19; those show up as
RATIO rows. The mod card's frame is found in each reference by its 640 px top edge (`#34363C`), the board zoom comes
from the card's width in the shot (zoom 0.5 shots are re-compared at zoom 1 with the mod shot scaled up), and the
website crop is cut so the two cards' top-left corners coincide.

## Files

- `lib/app.mjs` boot, `loadPlan` (real dataset recipes -> project -> store -> solver), `panTo`, `setZoom`.
- `lib/plans.mjs` the reference chain (distillation tower -> nitrobenzene LCR -> aniline LCR -> aniline drawer, the
  mod's `ref-chain`; solved numbers match the mod: 23.62 EU/t, x0.04, x0.005, x0.0012), the EBF, drawer and forced plans.
- `states.mjs` one entry per reference image. `run.mjs` captures. `assert.mjs` measures. `REPORT.md` the verdicts.
