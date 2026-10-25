// FIX-A: keyboard path. Dialogs close on Escape and give focus back; the bar and tabs are reachable by Tab and arrows.
import fs from "node:fs";
import { fresh, importText, toCode, OUT } from "./lib.mjs";
const FX = "C:/Users/jack/gtnh-planner-mod/.claude/worktrees/website-mod-backport-research-c84135/src/test/resources/";
const { browser, page, logs } = await fresh({ w: Number(process.env.W ?? 1920), h: Number(process.env.H ?? 1080) });
await importText(page, toCode(fs.readFileSync(FX + "factory-flow/high-amperage-reactor.json", "utf8")));
await page.waitForTimeout(5000);
await page.getByRole("button", { name: "Not now" }).click().catch(() => {});
const where = () =>
  page.evaluate(() => {
    const e = document.activeElement;
    const d = e?.closest?.("[role=dialog]");
    return { tag: e?.tagName, label: (e?.getAttribute?.("aria-label") || e?.textContent || "").trim().slice(0, 30), inDialog: d ? d.getAttribute("aria-label") : null, dialogs: [...document.querySelectorAll("[role=dialog]")].map((x) => x.getAttribute("aria-label")) };
  });
const res = {};
// Tab order from the top
await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
await page.mouse.click(5, 5).catch(() => {});
const order = [];
for (let i = 0; i < 24; i++) { await page.keyboard.press("Tab"); const w = await where(); order.push(w.label); }
console.log("TAB ORDER:", order.join(" | "));
// Share to library dialog via the Share menu
await page.locator('[data-mb="share"]').focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
res.shareMenu = await where();
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
res.shareOpen = await where();
for (let i = 0; i < 30; i++) await page.keyboard.press("Tab");
res.shareTrap = await where();
await page.screenshot({ path: OUT + "fixa-share-open.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
res.shareClosed = await where();
// Menu Escape returns focus to key
await page.locator('[data-mb="share"]').focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
res.menuEscape = await where();
// Tabs: roving
await page.locator('.mt-tab[data-active]').focus();
await page.keyboard.press("ArrowRight");
res.tabArrow = await page.evaluate(() => ({ active: document.activeElement?.className, tabindexes: [...document.querySelectorAll(".mt-tab")].map((t) => t.getAttribute("tabindex")).join(",") }));
console.log(JSON.stringify(res, null, 1));
console.log(logs.filter((l) => /pageerror|hydrat/i.test(l)).join("\n") || "no page errors");
await browser.close();
