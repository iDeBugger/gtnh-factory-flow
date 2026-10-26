// Gallery captures for every reference shot that is not a card-level state of run.mjs: whole screens, chrome
// (top bar, tabs, rail, menus, panels, tooltips) and board scenes. Writes tools/parity/out/gallery/<ref>.png (mod left,
// web right) and merges tools/parity/out/gallery/capture.json.
//   node tools/parity/gallery-capture.mjs [ref-regex]
//
// Scale: everything is compared at its size on screen. The mod shots are screen px at GUI scale 2, where the board
// draws at twice the zoom it reports; the web is captured in css px (screen px at 100% browser zoom) with its board at
// twice the mod's zoom, so a mod card at zoom 0.5 and a web card at zoom 1 are both 320 screen px.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, loadPlan, panTo, rectOf, setZoom } from "./lib/app.mjs";
import { readPng, writePng, sideBySide, blank, copyInto } from "./lib/png.mjs";
import { refChain, drawerPlan, forcedPlan, ebfOne } from "./lib/plans.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = process.env.PARITY_REF ?? path.resolve(here, "../../../gtnh-planner-mod/.claude/worktrees/website-mod-backport-research-c84135/docs/design/backport/ref");
const OUT = path.join(here, "out", "gallery");
const WEB = path.join(OUT, "web");
fs.mkdirSync(WEB, { recursive: true });
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;

const EMPTY = { nodes: [], drawers: [], wires: [] };
const noticePlan = {
  ...drawerPlan,
  nodes: drawerPlan.nodes.map((n) => (n.key === "nb" ? { ...n, pin: 0.01 } : n)),
  drawers: drawerPlan.drawers.map((d) => (d.key === "acid" ? { ...d, rate: 0.05, mode: "at-most" } : d.key === "aniline" ? { ...d, rate: 50, mode: "at-least" } : d)),
};
// The mod's ref-chain has a vinyl chloride card beside the chain (the wire, glance and hover shots).
const vcm = { key: "vcm", recipe: { res: ["fluid", "vinylchloride"], nameRe: "Large Chemical", hasIn: ["^Ethylene$", "^Chlorine$"] }, x: 1000, y: 0, tier: "HV" };
const chainVcm = { ...drawerPlan, nodes: [...drawerPlan.nodes, vcm] };

const wait = (page, ms = 900) => page.waitForTimeout(ms);
const idle = (page) => page.mouse.move(1000, 1060);
const hover = async (page, loc, ms = 1300) => {
  const b = await loc.first().boundingBox();
  if (!b) throw new Error("not found: " + loc);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await wait(page, ms);
  return b;
};
const key = (page, id) => page.locator(`.mb-key[data-mb="${id}"]`);
const fit = async (page) => {
  await key(page, "fit").click();
  await wait(page, 900);
};
/** The board at the screen size of a mod shot taken at mod zoom z, the card `id`'s top-left at screen (x, y). */
const frame = async (page, id, z, x, y) => {
  await setZoom(page, id, 2 * z);
  await panTo(page, id, x, y);
  await idle(page);
  await wait(page, 500);
};

// ref, plan, setup(ctx), clip: [x, y] (css top-left of a ref-sized window) or a function of ctx returning it.
// scale: "screen" (default) or "board". full: the whole viewport.
const entries = [
  // ---- whole screens ----
  { ref: "board-empty-full", plan: EMPTY, full: true, setup: async ({ page }) => idle(page) },
  { ref: "board-full-solved-chain-default", plan: drawerPlan, full: true, setup: async ({ page, ids }) => frame(page, ids.dt, 0.5, 592, 120) },
  { ref: "board-full-drawers-all-kinds-default", plan: drawerPlan, full: true, setup: async ({ page, ids }) => frame(page, ids.dt, 0.5, 592, 120) },
  { ref: "board-full-forced-in-import-default", plan: forcedPlan, full: true, setup: async ({ page, ids }) => frame(page, ids.dt, 0.5, 592, 120) },
  { ref: "board-full-notices-warnings-default", plan: noticePlan, full: true, setup: async ({ page, ids }) => frame(page, ids.dt, 0.5, 592, 120) },
  { ref: "board-full-zoomed-out-glance-view-arranged", plan: chainVcm, full: true, setup: async ({ page, ids }) => frame(page, ids.dt, 0.38, 560, 200) },
  { ref: "board-full-large-plan-solved-glance-default", plan: EMPTY, full: true, setup: async ({ page }) => { await importPlanFile(page, "factory-flow/titanium-line-posted-alpha5.json"); await fit(page); await idle(page); } },
  { ref: "settings-panel-open-full-screen", plan: refChain, full: true, setup: async ({ page, ids }) => { await frame(page, ids.dt, 0.5, 592, 120); await key(page, "settings").click(); await wait(page); } },
  {
    ref: "board-full-tour-plan-solved-with-forced-block-default",
    plan: EMPTY,
    full: true,
    setup: async ({ page }) => {
      await page.evaluate(() => window.__tour.jump(26));
      await wait(page, 6000);
      await page.evaluate(() => window.__tour.leave());
      await wait(page, 1500);
      await idle(page);
    },
  },
  // ---- the top bar and tabs ----
  { ref: "topbar-and-plan-tabs", plan: refChain, clip: [0, 0] },
  ...[
    ["arrange", "arrange"], ["avg-peak", "peak"], ["eu-or-amps", "power"], ["fit", "fit"], ["gear", "settings"],
    ["help", "help"], ["library", "library"], ["non-recipe", "nonrecipe"], ["rate-unit", "rate"], ["share", "share"], ["undo", "undo"],
  ].map(([name, id]) => ({
    ref: `tip-topbar-${name}`,
    plan: refChain,
    setup: async ({ page }) => hover(page, key(page, id)),
    clip: async ({ page }) => {
      const b = await key(page, id).boundingBox();
      return [Math.max(0, b.x + b.width / 2 - 600), 0];
    },
  })),
  { ref: "tip-plan-tab-hover", plan: refChain, setup: async ({ page }) => hover(page, page.getByText("Untitled design")), clip: [0, 0] },
  { ref: "plan-tab-right-click-menu", plan: refChain, setup: async ({ page }) => { await page.getByText("Untitled design").first().click({ button: "right" }); await wait(page); }, clip: [0, 0] },
  { ref: "plan-tab-plus-menu", plan: refChain, setup: async ({ page }) => { await page.getByLabel("New plan", { exact: true }).first().click(); await wait(page); }, clip: async ({ page }) => { const b = await page.getByLabel("New plan", { exact: true }).first().boundingBox(); return [Math.max(0, b.x - 40), 0]; } },
  { ref: "share-menu-open", plan: refChain, setup: async ({ page }) => { await key(page, "share").click(); await wait(page); }, clip: async ({ page }) => { const b = await key(page, "share").boundingBox(); return [Math.max(0, b.x + b.width - 600), 0]; } },
  { ref: "help-menu-open", plan: refChain, setup: async ({ page }) => { await key(page, "help").click(); await wait(page); }, clip: async ({ page }) => { const b = await key(page, "help").boundingBox(); return [Math.min(1920 - 800, b.x + b.width - 700), 0]; } },
  {
    ref: "help-controls-and-shortcuts-list",
    plan: refChain,
    setup: async ({ page }) => { await key(page, "help").click(); await wait(page, 500); await page.getByText("Controls and shortcuts").click(); await wait(page); },
    clip: async ({ page }) => centreOn(page, "[role=dialog], .cs-panel, .mb-menu", 900, 840),
  },
  { ref: "non-recipe-picker-open", plan: refChain, setup: async ({ page }) => { await key(page, "nonrecipe").click(); await wait(page, 1200); }, clip: [0, 0] },
  ...["board", "sound", "minimap", "pin-list", "keys", "in-the-world"].map((name) => ({
    ref: `settings-panel-${name}-section`,
    plan: refChain,
    setup: async ({ page }) => { await key(page, "settings").click(); await wait(page); },
    clip: async ({ page }) => centreOn(page, "[role=dialog]"),
    note: name === "in-the-world" || name === "pin-list" || name === "keys" ? "no-section" : undefined,
  })),
  { ref: "library-view-my-plans-shelf", plan: refChain, setup: async ({ page }) => { await key(page, "library").click(); await wait(page, 2000); }, clip: railTop },
  { ref: "library-view-public-setups-shelf", plan: refChain, setup: async ({ page }) => { await key(page, "library").click(); await wait(page, 2000); await page.getByText(/public setups/i).first().click().catch(() => {}); await wait(page, 2000); }, clip: railTop },
  // ---- the rail ----
  { ref: "overview-rail-folded", plan: drawerPlan, setup: async ({ page, ids }) => { await frame(page, ids.dt, 0.5, 592, 120); await page.locator(".rail-root .rail-key-fold").click(); await wait(page); }, clip: railTop },
  { ref: "overview-rail-unfolded-again", plan: drawerPlan, setup: async ({ page }) => { await page.locator(".rail-root .rail-key-fold").click(); await wait(page, 500); await page.locator(".rail-strip").click(); await wait(page); }, clip: railTop },
  { ref: "overview-filter-typed", plan: drawerPlan, setup: async ({ page }) => { await page.locator(".rail-filter").fill("pro"); await wait(page); }, clip: railTop },
  { ref: "overview-input-row-hover", plan: drawerPlan, setup: async ({ page, ids }) => { await frame(page, ids.dt, 0.5, 592, 80 + 40); await hover(page, page.locator(".rail-row", { hasText: "Sulfuric Acid" })); }, clip: railTop },
  { ref: "overview-row-hover-scope-propene", plan: drawerPlan, setup: async ({ page, ids }) => { await frame(page, ids.dt, 0.5, 592, 120); await hover(page, page.locator(".rail-row", { hasText: "Propene" })); }, clip: railTop },
  { ref: "overview-row-hover-scope-machine-line", plan: drawerPlan, setup: async ({ page, ids }) => { await frame(page, ids.dt, 0.5, 592, 120); await hover(page, page.locator(".rail-machine .rail-row").first()); }, clip: railTop },
  { ref: "overview-row-tooltip-palladium", plan: drawerPlan, setup: async ({ page }) => hover(page, page.locator(".rail-row", { hasText: "Palladium" })), clip: railTop },
  { ref: "overview-set-rate-popup", plan: drawerPlan, setup: async ({ page }) => { await page.locator(".rail-row", { hasText: "Hydrogen" }).locator(".rail-box, [class*=box]").first().click(); await wait(page); }, clip: [0, 120] },
  { ref: "overview-port-pinned-row-with-card-rate-set", plan: { ...drawerPlan, nodes: drawerPlan.nodes.map((n) => (n.key === "nb" ? { ...n, portRates: { "input:fluid:nitricacid": 1 } } : n)) }, setup: async ({ page }) => idle(page), clip: railTop },
  { ref: "tip-overview-row-rule-key", plan: drawerPlan, setup: async ({ page }) => hover(page, page.locator(".rail-row", { hasText: "Aniline" }).locator(".rail-rule, [class*=rule], [class*=key]").first()), clip: [0, 300] },
  { ref: "tip-overview-machine-line-chip", plan: drawerPlan, setup: async ({ page }) => hover(page, page.locator(".rail-machine .rail-tier").first()), clip: [0, 600] },
  { ref: "notices-bar-two-warnings-show-me", plan: noticePlan, setup: async ({ page }) => idle(page), clip: async ({ page }) => { const b = await page.locator(".rail-notices, .rail-notice").first().boundingBox(); return [b ? b.x - 4 : 400, b ? b.y - 4 : 60]; } },
  { ref: "overview-forced-block-split-auto-sliders", plan: EMPTY, setup: async ({ page }) => { await importPlanFile(page, "factory-flow/alumina-line-shared-reactor.json"); await idle(page); }, clip: async ({ page }) => { const b = await page.locator(".rail-spare").first().boundingBox(); return b ? [0, b.y - 10] : [0, 300]; } },
  // ---- board context menu, notes ----
  { ref: "board-context-menu-empty-board", plan: refChain, setup: async ({ page }) => { await page.mouse.click(1300, 500, { button: "right" }); await wait(page); }, clip: [1300 - 300, 500 - 200], scale: "screen" },
  {
    ref: "note-sticky-idle",
    plan: EMPTY,
    setup: async ({ page }) => { await addNote(page); await idle(page); await wait(page); },
    clip: async ({ page }) => centreOn(page, ".sn, [data-note], .note-card", 600, 500),
  },
  {
    ref: "note-sticky-writing",
    plan: EMPTY,
    setup: async ({ page }) => { await addNote(page); await page.keyboard.type("Benzene line, pin the tower"); await wait(page); },
    clip: async ({ page }) => centreOn(page, ".sn, [data-note], .note-card", 600, 500),
  },
  {
    ref: "note-sticky-hover-keys",
    plan: EMPTY,
    setup: async ({ page }) => { await addNote(page); await idle(page); await wait(page, 400); await hover(page, page.locator(".sn, [data-note], .note-card")); },
    clip: async ({ page }) => centreOn(page, ".sn, [data-note], .note-card", 600, 500),
  },
  {
    ref: "note-sticky-right-click-menu",
    plan: EMPTY,
    setup: async ({ page }) => { await addNote(page); await idle(page); const b = await page.locator(".sn, [data-note], .note-card").first().boundingBox(); await page.mouse.click(b.x + 30, b.y + 30, { button: "right" }); await wait(page); },
    clip: async ({ page }) => centreOn(page, ".sn, [data-note], .note-card", 600, 600),
  },
  {
    ref: "note-sticky-colour-picker",
    plan: EMPTY,
    setup: async ({ page }) => { await addNote(page); await idle(page); const b = await page.locator(".sn, [data-note], .note-card").first().boundingBox(); await page.mouse.click(b.x + 30, b.y + 30, { button: "right" }); await wait(page, 500); await page.getByText(/colou?r/i).first().click(); await wait(page); },
    clip: async ({ page }) => centreOn(page, ".sn, [data-note], .note-card", 600, 600),
  },
  // ---- tour ----
  { ref: "tour-offer-first-run", plan: EMPTY, offer: true, setup: async ({ page }) => wait(page, 1500), clip: async ({ page }) => centreOn(page, ".tour-offer", 760, 200) },
  ...[1, 2, 3].map((n) => ({
    ref: `tour-step-${n}-after-next`,
    plan: EMPTY,
    setup: async ({ page }) => { await page.evaluate((n) => window.__tour.jump(n - 1), n); await wait(page, 5000); await page.evaluate(() => window.__tour.next()); await wait(page, 5000); },
    clip: [0, 0],
  })),
  { ref: "tour-step-27-full-board-solved-bending-acid", plan: EMPTY, setup: async ({ page }) => { await page.evaluate(() => window.__tour.jump(26)); await wait(page, 7000); }, clip: [360, 40] },
  { ref: "tour-callout-recipe-in-a-plan", plan: EMPTY, setup: async ({ page }) => { await page.evaluate(() => window.__tour.jump(0)); await wait(page, 6000); }, clip: async ({ page }) => centreOn(page, ".tour-note", 680, 520) },
  // ---- board scenes, at board scale (one mod GUI px to one css px, the mod's zoom): board: [card key, zoom, x, y],
  // the card's top-left at (x, y) of the reference ----
  ...boardEntries(),
];

/** Board scenes. */
function boardEntries() {
  // The mod's scene: an Ethylene drawer off the tower, below and left of the vinyl chloride card.
  const W = {
    ...chainVcm,
    nodes: chainVcm.nodes.map((n) => (n.key === "vcm" ? { ...n, tier: "LV", x: 1100, y: 300 } : n)),
    drawers: [...chainVcm.drawers, { key: "eth", kind: "fluid", id: "ethylene", name: "Ethylene", x: 860, y: 340 }],
    wires: [...chainVcm.wires, { from: "dt", to: "eth", res: ["fluid", "ethylene"] }],
  };
  const handle = (page, ids, node, h) => page.locator(`.react-flow__handle[data-nodeid="${ids[node]}"][data-handleid="${h}"]`).first();
  const grab = async (page, ids) => {
    const b = await page.locator(`.react-flow__node[data-id="${ids.eth}"] .cd-body`).first().boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 10, { steps: 4 });
    return b;
  };
  const cardAt = async (page, ids, key, fx, fy) => {
    const r = await rectOf(page, `.react-flow__node[data-id="${ids[key]}"]`);
    return [r.x + r.w * fx, r.y + r.h * fy];
  };
  // The mod's hop scene: the tower, the two reactors, the vinyl chloride card right, Aniline's drawer above it, the
  // tower's ethylene wire crossing the aniline wire.
  const H = {
    nodes: [
      { ...refChain.nodes[0], x: 0, y: 0 },
      { ...refChain.nodes[1], x: 20, y: 580 },
      { ...refChain.nodes[2], x: 360, y: 580 },
      { ...vcm, tier: "LV", x: 560, y: 280 },
    ],
    drawers: [
      { key: "aniline", kind: "fluid", id: "aniline", name: "Aniline", x: 620, y: 180, rate: 1, mode: "at-least" },
      { key: "acid", kind: "fluid", id: "sulfuricacid", name: "Sulfuric Acid", x: -120, y: 700, rate: 0.2, mode: "at-most" },
    ],
    wires: [
      { from: "dt", to: "nb", res: ["fluid", "benzene"] },
      { from: "nb", to: "an", res: ["fluid", "nitrobenzene"] },
      { from: "an", to: "aniline", res: ["fluid", "aniline"] },
      { from: "acid", to: "nb", res: ["fluid", "sulfuricacid"] },
      { from: "dt", to: "vcm", res: ["fluid", "ethylene"] },
    ],
  };
  return [
    { ref: "board-wire-over-card-aniline-drawer-moved-hop-zoom-half", plan: H, board: ["dt", 0.5, 220, 60], setup: async ({ page }) => idle(page) },
    { ref: "wires-hop-bump-at-crossing-zoom-1-5", plan: H, board: ["vcm", 1.5, 290, -55], setup: async ({ page }) => idle(page) },
    { ref: "wire-in-hand-acceptance-glow-card-green", plan: W, board: ["vcm", 0.66, 352, 114], hold: true, setup: async ({ page, ids }) => { await grab(page, ids); const [x, y] = await cardAt(page, ids, "vcm", -0.25, 0.3); await page.mouse.move(x, y, { steps: 8 }); await wait(page, 700); } },
    { ref: "wire-in-hand-snapped-to-port-green", plan: W, board: ["vcm", 0.66, 354, 116], hold: true, setup: async ({ page, ids }) => { await grab(page, ids); const [x, y] = await cardAt(page, ids, "vcm", 0.12, 0.25); await page.mouse.move(x, y, { steps: 8 }); await wait(page, 700); } },
    { ref: "wire-in-hand-over-empty-red", plan: W, board: ["vcm", 0.66, 354, 116], hold: true, setup: async ({ page, ids }) => { await grab(page, ids); const [x, y] = await cardAt(page, ids, "vcm", -0.15, -0.6); await page.mouse.move(x, y, { steps: 8 }); await wait(page, 700); } },
    { ref: "wire-in-hand-over-non-accepting-card-red", plan: W, board: ["an", 0.65, 306, 348], hold: true, setup: async ({ page, ids }) => { await grab(page, ids); const [x, y] = await cardAt(page, ids, "an", 0.15, 0.2); await page.mouse.move(x, y, { steps: 8 }); await wait(page, 700); } },
    { ref: "wire-hover-tooltip-and-scope", plan: W, board: ["an", 0.81, 176, 244], setup: async ({ page }) => { await hover(page, page.locator(".react-flow__edge").nth(2), 1400); } },
    { ref: "wire-right-click-menu", plan: W, board: ["an", 0.81, 176, 244], setup: async ({ page }) => { const b = await page.locator(".react-flow__edge").nth(2).boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: "right" }); await wait(page); } },
    { ref: "board-wire-made-ethylene-to-vcm-solved", plan: { ...W, wires: [...W.wires, { from: "dt", to: "vcm", res: ["fluid", "ethylene"] }] }, board: ["vcm", 0.5, 700, 300], setup: async ({ page }) => idle(page) },
    { ref: "tip-port-hover-scope", plan: drawerPlan, board: ["nb", 0.5, 300, 40], setup: async ({ page, ids }) => hover(page, page.locator(`.react-flow__node[data-id="${ids.nb}"] .cc-row[data-port]`).first()) },
    { ref: "glance-view-hover-reveal-card", plan: refChain, board: ["dt", 0.33, 536, 40], setup: async ({ page, ids }) => hover(page, page.locator(`.react-flow__node[data-id="${ids.nb}"]`)) },
    { ref: "glance-view-hover-reveal-distillation", plan: refChain, board: ["dt", 0.33, 536, 40], setup: async ({ page, ids }) => hover(page, page.locator(`.react-flow__node[data-id="${ids.dt}"]`)) },
    { ref: "board-show-me-framed-light-fuel-drawer", plan: noticePlan, setup: async ({ page }) => { await page.locator(".rail-notice-show").first().click(); await wait(page, 1500); await idle(page); }, clip: [360, 40] },
  ];
}

/** Opens one of the mod's test plans (Factory Flow JSON) through the + menu's Paste plan, as a plan code. */
async function importPlanFile(page, rel) {
  const FX = "C:/Users/jack/gtnh-planner-mod/.claude/worktrees/website-mod-backport-research-c84135/src/test/resources/";
  const code = "gtnh1." + zlib.deflateRawSync(Buffer.from(fs.readFileSync(FX + rel, "utf8"))).toString("base64url");
  await page.getByLabel("New plan", { exact: true }).first().click();
  await page.getByText("Paste plan").click();
  await page.locator("textarea").first().fill(code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await wait(page, 8000);
  await page.getByRole("button", { name: "Not now" }).click().catch(() => {});
}

/** The ref's crops start under the mod's top bar, at the rail's top: the web window starts at its rail's top. */
async function railTop({ page }) {
  const rail = page.locator(".rail-root, .rail-strip").first();
  const b = (await rail.count()) ? await rail.boundingBox() : null;
  return [0, b ? b.y : 40];
}

/** A window of the ref's size (or w x h) centred on the first match of `sel`. */
async function centreOn(page, sel, w, h) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error("not found " + sel);
  return [b.x + b.width / 2 - (w ?? b.width) / 2, b.y + b.height / 2 - (h ?? b.height) / 2];
}

async function addNote(page) {
  await page.mouse.click(1000, 500, { button: "right" });
  await wait(page, 500);
  await page.getByText("Add a sticky note").first().click();
  await wait(page, 700);
}

const resFile = path.join(OUT, "capture.json");
const results = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, "utf8")) : {};
let session = null;
for (const e of entries) {
  if (filter && !filter.test(e.ref)) continue;
  try {
    // A fresh browser per state: the rail's fold, the tour's plans and open menus live in the page and its storage.
    await session?.browser.close();
    session = await boot({ offer: e.offer });
    const { page } = session;
    await page.keyboard.press("Escape").catch(() => {});
    if (await page.evaluate(() => window.__tour?.status?.().phase !== "idle").catch(() => false)) {
      await page.evaluate(() => window.__tour.leave()).catch(() => {});
      await wait(page, 800);
    }
    let ref = readPng(path.join(REF, e.ref + ".png"));
    const ids = await loadPlan(page, e.plan);
    await idle(page);
    await wait(page, 300);
    const ctx = { page, ids };
    const shot = path.join(WEB, e.ref + ".png");
    if (e.setup && !e.board) await e.setup(ctx);
    if (e.board) {
      const [k, z, rx, ry] = e.board;
      // Screen scale, as everything else: the board at twice the mod's zoom, clear of the overview.
      await setZoom(page, ids[k], 2 * z);
      await panTo(page, ids[k], 400 + rx, 40 + ry);
      await idle(page);
      await wait(page, 400);
      if (e.setup) await e.setup(ctx);
      await page.screenshot({ path: shot, scale: "css", clip: { x: 400, y: 40, width: Math.min(ref.width, 1520), height: Math.min(ref.height, 1040) } });
      if (e.hold) await page.mouse.up();
    } else if (e.full) {
      await page.screenshot({ path: shot, scale: "css" });
    } else {
      const at = typeof e.clip === "function" ? await e.clip(ctx) : e.clip ?? [0, 0];
      const x = Math.max(0, Math.min(1920 - ref.width, at[0]));
      const y = Math.max(0, Math.min(1080 - ref.height, at[1]));
      await page.screenshot({ path: shot, scale: "css", clip: { x, y, width: Math.min(ref.width, 1920), height: Math.min(ref.height, 1080) } });
    }
    const web = readPng(shot);
    writePng(path.join(OUT, e.ref + ".png"), sideBySide(ref, web));
    results[e.ref] = { ok: true, scale: e.board ? "board" : e.full ? "screen (whole window)" : "screen", note: e.note };
    console.log("ok", e.ref);
    if (e.offer) {
      await session.browser.close();
      session = null;
    }
  } catch (err) {
    results[e.ref] = { ok: false, error: String(err).slice(0, 300) };
    console.log("FAIL", e.ref, String(err).slice(0, 200));
    await session?.browser.close().catch(() => {});
    session = null;
  }
  fs.writeFileSync(resFile, JSON.stringify(results, null, 1));
}
await session?.browser.close();
