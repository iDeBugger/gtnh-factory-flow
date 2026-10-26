// G1 groups: node tools/parity/g1-shot.mjs out.png "step|step" ; plan=<file> loads a project JSON into plan mode.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const BASE = process.env.PARITY_BASE ?? "http://localhost:3281";
const [, , out = "g1.png", steps = ""] = process.argv;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem("gtnh-factory-flow.mod-announcement-dismissed.v1", "x"); localStorage.setItem("gtnhplanner.tour.offered", "1"); } catch {} });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto(BASE + "/dev/clean-card", { waitUntil: "networkidle", timeout: 180000 });
await page.waitForFunction(() => window.__ccStore?.getState().dataset, null, { timeout: 180000 });
await page.getByText("Untitled design").first().click();
await page.waitForTimeout(800);
for (const t of steps.split("|").filter(Boolean)) {
  if (t.startsWith("plan=")) {
    const raw = JSON.parse(readFileSync(t.slice(5), "utf8"));
    const proj = raw.project ?? raw.plan ?? raw;
    await page.evaluate((p) => { const S = window.__ccStore; S.getState().setProject(p); }, proj);
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__ccStore.getState().frameBoardNodes?.());
  } else if (t.startsWith("css=")) await page.locator(t.slice(4)).first().click();
  else if (t.startsWith("rclick=")) await page.locator(t.slice(7)).first().click({ button: "right" });
  else if (t.startsWith("rat=")) { const [x, y] = t.slice(4).split(",").map(Number); await page.mouse.click(x, y, { button: "right" }); }
  else if (t.startsWith("at=")) { const [x, y] = t.slice(3).split(",").map(Number); await page.mouse.click(x, y); }
  else if (t.startsWith("drag=")) { const [x, y, x2, y2] = t.slice(5).split(",").map(Number); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move((x + x2) / 2, (y + y2) / 2, { steps: 8 }); await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up(); }
  else if (t.startsWith("sdrag=")) { const [x, y, x2, y2] = t.slice(6).split(",").map(Number); await page.keyboard.down("Shift"); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 12 }); await page.mouse.up(); await page.keyboard.up("Shift"); }
  else if (t.startsWith("wheel=")) { const [x, y, dy] = t.slice(6).split(",").map(Number); await page.mouse.move(x, y); await page.mouse.wheel(0, dy); }
  else if (t.startsWith("hold=")) { const [x, y, x2, y2] = t.slice(5).split(",").map(Number); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 14 }); }
  else if (t === "up") await page.mouse.up();
  else if (t.startsWith("rects")) console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".react-flow__node")].map((n) => { const r = n.getBoundingClientRect(); return n.dataset.id.slice(0, 10) + " " + n.className.split(" ")[1].replace("react-flow__node-", "") + " " + [r.x, r.y, r.width, r.height].map(Math.round).join(","); }))));
  else if (t.startsWith("move=")) { const [x, y] = t.slice(5).split(",").map(Number); await page.mouse.move(x, y); }
  else if (t.startsWith("wait=")) await page.waitForTimeout(+t.slice(5));
  else if (t.startsWith("key=")) await page.keyboard.press(t.slice(4));
  else if (t.startsWith("type=")) await page.keyboard.type(t.slice(5));
  else if (t.startsWith("js=")) console.log(JSON.stringify(await page.evaluate(t.slice(3))));
  else if (t.startsWith("shot=")) await page.screenshot({ path: t.slice(5) });
  else await page.getByText(t).first().click();
  await page.waitForTimeout(600);
}
await page.screenshot({ path: out });
await browser.close();
