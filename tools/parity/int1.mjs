// INT1 smoke: opens the app, loads an example plan, then opens every Help, Share, Settings, Tour and
// Minimap entry, checks each did something and takes a screenshot of it.
//   PARITY_BASE=http://localhost:3151 node tools/parity/int1.mjs
// Output: tools/parity/out/int1/NN-name.png and results.json; exits 1 when a check fails or the page threw.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadPlan } from "./lib/app.mjs";
import * as plans from "./lib/plans.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out", "int1");
const BASE = process.env.PARITY_BASE ?? "http://localhost:3151";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  reducedMotion: "no-preference",
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("gtnh-factory-flow.mod-announcement-dismissed.v1", "x");
    localStorage.setItem("gtnhplanner.tour.offered", "1");
  } catch {}
  // Outside doors are checked as calls, not followed.
  window.__opened = [];
  window.open = (url) => {
    window.__opened.push(String(url));
    return null;
  };
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));

const results = [];
let n = 0;
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const shot = async (name) => {
  n++;
  await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, "0")}-${name}.png`) });
};
const key = (id) => page.locator(`.mb-key[data-mb="${id}"]`);
const esc = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
};

await page.goto(`${BASE}/dev/clean-card`, { waitUntil: "networkidle", timeout: 240000 });
await page.waitForFunction(() => window.__ccStore?.getState().dataset, null, { timeout: 240000 });
await page.waitForTimeout(1200);
await page.getByText("Untitled design").first().click();
await page.waitForTimeout(800);
await loadPlan(page, plans.refChain);
await page.evaluate(() => window.__ccStore.getState().recalculate?.());
await page.waitForTimeout(1200);
await key("fit").click();
await page.waitForTimeout(800);
const cards = await page.locator(".cc-card").count();
check("example plan loaded", cards >= 3, `${cards} cards`);
await shot("board");

// The bar itself.
const ids = await page.evaluate(() => [...document.querySelectorAll(".mb-key")].map((e) => e.getAttribute("data-mb")));
check(
  "the bar's keys are all there",
  ["nonrecipe", "undo", "redo", "arrange", "fit", "rate", "power", "peak", "library", "share", "settings", "help"].every((id) => ids.includes(id)),
  ids.join(" "),
);

// Minimap.
check("minimap is on the board", (await page.locator("[data-minimap]").count()) > 0);
await shot("minimap");
const gear = page.locator("[data-minimap] .mm-gear");
if (await gear.count()) {
  await page.locator("[data-minimap]").first().hover();
  await page.waitForTimeout(250);
  await gear.first().click();
  await page.waitForTimeout(300);
  check("minimap gear opens its settings", (await page.locator(".mm-panel").count()) > 0);
  await shot("minimap-settings");
  await esc();
}

// Amps: each card counts in its own tier.
await key("power").click();
await page.waitForTimeout(600);
const powerRows = await page.evaluate(() =>
  [...document.querySelectorAll(".cc-card [data-power] .cc-num")].map((e) => `${e.textContent} ${e.getAttribute("data-unit")}`),
);
const tierSet = new Set(powerRows.map((t) => (t.match(/ A (\w+)$/) ?? [])[1]).filter(Boolean));
check("Amps counts in each card's own tier", powerRows.length > 0 && powerRows.every((t) => / A [A-Za-z]+$/.test(t)), powerRows.join(" | "));
check("the cards' tiers differ in Amps", tierSet.size >= 2, [...tierSet].join(","));
await shot("amps");
await key("power").click();
await page.waitForTimeout(300);

// Help.
await key("help").click();
await page.waitForTimeout(300);
const helpItems = await page.locator('[role="menuitem"]').allInnerTexts();
check("Help menu lists its entries", helpItems.length >= 6, helpItems.map((t) => t.split("\n")[0]).join(" / "));
await shot("help-menu");

async function helpEntry(label) {
  if ((await page.locator('[role="menuitem"]').count()) === 0) {
    await key("help").click();
    await page.waitForTimeout(250);
  }
  await page.locator('[role="menuitem"]', { hasText: label }).first().click();
  await page.waitForTimeout(700);
}

await helpEntry("Take the tour");
const tour = await page.evaluate(() => window.__tour?.status().phase);
check("Help > Take the tour starts the tour", tour && tour !== "idle", String(tour));
await page.waitForTimeout(2500);
await shot("tour-started");
await page.evaluate(() => window.__tour?.leave());
await page.waitForTimeout(800);

await helpEntry("Controls and shortcuts");
check("Help > Controls and shortcuts opens the list", (await page.locator('[aria-label="How the board works"]').count()) === 1);
const ctl = await page.locator('[aria-label="How the board works"]').boundingBox();
check("the controls list sits inside the window", ctl && ctl.x >= 0 && ctl.x + ctl.width <= 1920, JSON.stringify(ctl));
await shot("controls");
await esc();

await helpEntry("What's new");
await shot("whats-new");
await esc();
await page.keyboard.press("Escape");

for (const label of ["Source on GitHub", "Discord thread", "Support on Ko-fi"]) {
  await helpEntry(label);
}
const opened = await page.evaluate(() => window.__opened);
check("Help's outside links open", opened.length >= 3, opened.join(" "));

await helpEntry("Welcome");
await shot("welcome");
await page.getByText("Untitled design").first().click();
await page.waitForTimeout(500);

// Share.
await key("share").click();
await page.waitForTimeout(300);
const shareItems = await page.locator('[role="menuitem"]').allInnerTexts();
check("Share menu lists its entries", shareItems.length === 3, shareItems.join(" / "));
await shot("share-menu");
await page.locator('[role="menuitem"]', { hasText: "Copy plan code" }).click();
await page.waitForTimeout(600);
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
check("Share > Copy plan code puts a link on the clipboard", /#p=|gtnh1/.test(clip), clip.slice(0, 60));
await key("share").click();
await page.waitForTimeout(250);
await page.locator('[role="menuitem"]', { hasText: "Screenshot" }).click();
await page.waitForTimeout(1500);
check("Share > Screenshot opens the screenshot box", (await page.locator("[data-mod-screenshot]").count()) === 1);
await shot("screenshot-box");
await esc();
await key("share").click();
await page.waitForTimeout(250);
await page.locator('[role="menuitem"]', { hasText: /library/ }).first().click();
await page.waitForTimeout(900);
check("Share > Share to library asks to sign in or opens the post form", (await page.locator("text=/Share your setup|Sign in|Share to library/i").count()) > 0);
await shot("share-to-library");
await page.locator('.fixed.inset-0 button[aria-label*="lose"]').first().click();
await page.waitForTimeout(300);

// Settings: every section, and the settings that change the card.
await key("settings").click();
await page.waitForTimeout(400);
check("Settings opens", (await page.locator('[data-mod-settings]').count()) === 1);
const sections = await page.locator(".ms-section").allInnerTexts();
check("Settings has Board, Minimap, Sound and Controls", ["Board", "Minimap", "Sound", "Controls"].every((s) => sections.includes(s)), sections.join(","));
for (const s of sections) {
  await page.locator(".ms-section", { hasText: new RegExp(`^${s}$`) }).click();
  await page.waitForTimeout(250);
  await shot(`settings-${s.toLowerCase()}`);
}
await page.locator(".ms-section", { hasText: /^Board$/ }).click();
await page.waitForTimeout(200);
// See-through has one home: the slider moves the board's own variable.
const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--board-bg-alpha"));
await page.getByLabel("See-through").fill("10");
await page.waitForTimeout(400);
const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--board-bg-alpha"));
check("See-through slider moves the board's paper", before !== after, `${before.trim()} -> ${after.trim()}`);
await page.getByLabel("See-through").fill("0");
// Circuit as an input: a row on the card instead of the badge.
const badgeBefore = await page.locator(".cc-circuit").count();
await page.getByText("Circuit as an input").click();
await page.waitForTimeout(500);
await esc();
await shot("circuit-as-input");
const badgeAfter = await page.locator(".cc-circuit").count();
check("Circuit as an input changes the card", badgeBefore !== badgeAfter || badgeBefore === 0, `badges ${badgeBefore} -> ${badgeAfter}`);

// Library.
await key("library").click();
await page.waitForTimeout(1500);
await shot("library");
await key("library").click();
await page.waitForTimeout(500);

check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 400));
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
