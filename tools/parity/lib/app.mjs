// Shared plumbing for the A/B parity harness: launch the website's dev page, build a plan with real dataset
// recipes, and put the board into a known state. Used by run.mjs, assert.mjs and probe scripts.
import { chromium } from "playwright-core";

export const BASE = process.env.PARITY_BASE ?? "http://localhost:3120";
export const PAGE_URL = `${BASE}/dev/clean-card`;
/** The mod's reference shots are 2 device px per GUI px, so a 320 GUI card is 640 px wide. */
export const MOD_CARD_PX = 640;
/** Website card width in css px at board zoom 1. */
export const WEB_CARD_CSS = 320;
/** deviceScaleFactor that makes the website's card the same pixel width as the mod's reference card. */
export const DSF = MOD_CARD_PX / WEB_CARD_CSS;

export async function boot({ width = 1920, height = 1080, dsf = DSF, headless = true, offer = false } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await page.addInitScript((offer) => {
    try {
      localStorage.setItem("gtnh-factory-flow.mod-announcement-dismissed.v1", "x");
      // The first-run tour offer covers the board: asked already, unless a state wants it.
      if (!offer) localStorage.setItem("gtnhplanner.tour.offered", "1");
    } catch {}
  }, offer);
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  await page.goto(PAGE_URL, { waitUntil: "networkidle", timeout: 180000 });
  await page.waitForFunction(() => window.__ccStore?.getState().dataset, null, { timeout: 180000 });
  await page.getByText("Untitled design").first().click();
  await page.waitForTimeout(800);
  return { browser, context, page };
}

/** Turns on plan mode with a clean project, hides the notice noise, units /s and EU/t like the mod's defaults. */
export async function freshProject(page) {
  await page.evaluate(() => {
    const S = window.__ccStore;
    const st = S.getState();
    S.setState({
      project: { ...st.project, nodes: [], storages: [], edges: [], recipes: [] },
    });
  });
}

/** Find a recipe in the dataset: resource + side, then a predicate over the full recipe body. */
export async function pickRecipe(page, spec) {
  return page.evaluate(async (spec) => {
    const S = window.__ccStore;
    const ver = S.getState().selectedDatasetVersionId;
    const get = async (u) => (await fetch(u)).json();
    const qs = new URLSearchParams({
      query: spec.query ?? "",
      mode: spec.mode ?? "recipes",
      maxTier: "UXV",
      offset: "0",
      limit: "60",
      ...(spec.recipeMap ? {} : { allMaps: "1" }),
    });
    if (spec.recipeMap) qs.set("recipeMap", spec.recipeMap);
    if (spec.res) {
      qs.set("resourceKind", spec.res[0]);
      qs.set("resourceId", spec.res[1]);
    }
    const list = await get(`/api/datasets/${ver}/recipes?${qs}`);
    const nameRe = spec.nameRe ? new RegExp(spec.nameRe) : null;
    const mapRe = spec.mapRe ? new RegExp(spec.mapRe) : null;
    const cands = list.recipes.filter((r) => (!nameRe || nameRe.test(r.name)) && (!mapRe || mapRe.test(r.recipeMap ?? r.machineType)));
    for (const c of cands) {
      const full = await get(`/api/datasets/${ver}/recipes/${encodeURIComponent(c.id)}`);
      if (spec.hasIn && !spec.hasIn.every((n) => full.inputs.some((i) => new RegExp(n, "i").test(i.displayName ?? i.id)))) continue;
      if (spec.hasOut && !spec.hasOut.every((n) => full.outputs.some((i) => new RegExp(n, "i").test(i.displayName ?? i.id)))) continue;
      return full;
    }
    throw new Error("no recipe for " + JSON.stringify(spec) + " among " + cands.length);
  }, spec);
}

export function handleId(side, kind, id, section = 0) {
  return `${section > 0 ? `r${section}:` : ""}${side}:${kind}:${encodeURIComponent(id)}`;
}

/**
 * plan = { nodes:[{key, recipe:<pickRecipe spec>, tier?, pin?, x,y, set?:{field:value}, handler?}],
 *          drawers:[{key, kind:'item'|'fluid', id, name?, x,y, rate?, mode?, drain?}],
 *          wires:[{from:key, to:key, res:[kind,id]}], }
 * Wire `from` and `to` are node or drawer keys. Returns key -> id map.
 */
export async function loadPlan(page, plan) {
  await freshProject(page);
  const ids = {};
  for (const n of plan.nodes) {
    const recipe = await pickRecipe(page, n.recipe);
    const id = await page.evaluate(
      async ({ recipe, n }) => {
        const S = window.__ccStore;
        const before = new Set(S.getState().project.nodes.map((x) => x.id));
        S.getState().addNodeForRecipeObject(recipe, undefined, n.handler ? { machineHandlerId: n.handler } : undefined);
        const after = S.getState().project.nodes.find((x) => !before.has(x.id));
        return after.id;
      },
      { recipe, n },
    );
    ids[n.key] = id;
  }
  const dids = await page.evaluate(
    ({ plan, ids }) => {
      const S = window.__ccStore;
      const st = S.getState();
      const project = structuredClone(st.project);
      for (const n of plan.nodes) {
        const node = project.nodes.find((x) => x.id === ids[n.key]);
        node.position = { x: n.x, y: n.y };
        if (n.tier) {
          node.overclockTier = n.tier;
          node.hatchVoltageTier = n.tier;
        }
        if (n.pin !== undefined) node.solvePin = n.pin;
        if (n.portRates) node.portRates = n.portRates;
        if (n.set) Object.assign(node, n.set);
      }
      const dids = {};
      let k = 0;
      for (const d of plan.drawers ?? []) {
        const id = `drawer-${d.key}`;
        dids[d.key] = id;
        project.storages.push({
          id,
          kind: d.kind,
          resourceId: d.id,
          displayName: d.name ?? d.id,
          position: { x: d.x, y: d.y },
          ...(d.rate !== undefined ? { targetPerSecond: d.rate, targetMode: d.mode ?? "at-least" } : {}),
          ...(d.drain ? { drainMode: d.drain } : {}),
          ...(d.extra ?? {}),
        });
      }
      for (const w of plan.wires ?? []) {
        const [kind, rid] = w.res;
        const sId = ids[w.from] ?? dids[w.from];
        const tId = ids[w.to] ?? dids[w.to];
        const sIsDrawer = !!dids[w.from];
        const tIsDrawer = !!dids[w.to];
        project.edges.push({
          id: `edge-${k++}`,
          source: sId,
          target: tId,
          ...(sIsDrawer ? {} : { sourceHandle: `output:${kind}:${encodeURIComponent(rid)}` }),
          ...(tIsDrawer ? {} : { targetHandle: `input:${kind}:${encodeURIComponent(rid)}` }),
          resourceKind: kind,
          resourceId: rid,
        });
      }
      S.getState().setProject?.(project);
      // setProject may not exist on every build of the store: fall back to state + recalculate
      if (S.getState().project !== project && S.getState().project.nodes.length !== project.nodes.length) {
        S.setState({ project });
      }
      return dids;
    },
    { plan, ids },
  );
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__ccStore.getState().recalculate?.());
  await page.waitForTimeout(800);
  return { ...ids, ...dids };
}

/** Hide the Solve notices and chrome that get in the way of crops. */
export async function settle(page, ms = 800) {
  await page.waitForTimeout(ms);
}

/** CSS rect of an element in viewport px. */
export async function rectOf(page, selector, nth = 0) {
  return page.evaluate(
    ({ selector, nth }) => {
      const el = document.querySelectorAll(selector)[nth];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    { selector, nth },
  );
}

/** The React Flow viewport transform {x,y,zoom} in css px. */
export async function camera(page) {
  return page.evaluate(() => {
    const v = document.querySelector(".react-flow__viewport");
    const m = new DOMMatrix(getComputedStyle(v).transform);
    return { x: m.e, y: m.f, zoom: m.a };
  });
}

/** Pans (drag on empty pane, in chunks) so the top-left of node `id`'s card lands at css (sx,sy). Zoom stays as is. */
export async function panTo(page, id, sx, sy) {
  const sel = `.react-flow__node[data-id="${id}"]`;
  for (let i = 0; i < 12; i++) {
    const r = await rectOf(page, sel);
    if (!r) throw new Error("node not on board " + id);
    const dx = sx - r.x;
    const dy = sy - r.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return r;
    const cx = Math.max(-300, Math.min(300, dx));
    const cy = Math.max(-300, Math.min(300, dy));
    // an empty pane point whose drag stays on screen
    const start = await page.evaluate(
      ({ cx, cy }) => {
        for (let y = 200; y < 1000; y += 40) {
          for (let x = 400; x < 1600; x += 40) {
            const ex = x + cx, ey = y + cy;
            if (ex < 330 || ex > 1650 || ey < 150 || ey > 1000) continue;
            const el = document.elementFromPoint(x, y);
            if (el && el.closest(".react-flow__pane") && !el.closest(".react-flow__node") && !el.closest(".react-flow__edge") && !el.closest("button")) return { x, y };
          }
        }
        return null;
      },
      { cx, cy },
    );
    if (!start) throw new Error("no empty pane spot");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: "left" });
    await page.mouse.move(start.x + cx / 2, start.y + cy / 2, { steps: 3 });
    await page.mouse.move(start.x + cx, start.y + cy, { steps: 3 });
    await page.mouse.up({ button: "left" });
    await page.waitForTimeout(150);
  }
  return rectOf(page, sel);
}

/** Board zoom as the card css width / 320. */
export async function zoomOf(page, id) {
  const r = await rectOf(page, `.react-flow__node[data-id="${id}"]`);
  return r ? r.w / WEB_CARD_CSS : null;
}

/** Wheel-zooms about (cx,cy) until the card is at zoom z (within 0.4%). */
export async function setZoom(page, id, z, cx = 1000, cy = 500) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 14; i++) {
    const cur = await zoomOf(page, id);
    if (Math.abs(cur - z) / z < 0.004) return cur;
    const delta = -Math.log(z / cur) * 330;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(220);
  }
  return zoomOf(page, id);
}
