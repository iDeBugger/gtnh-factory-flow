#!/usr/bin/env node
/**
 * The production page in real browsers, headless Chromium and Firefox, each with a fresh profile:
 *
 *   node tools/http-parity/browser-check.mjs --base http://127.0.0.1:3770 [--plan <public plan id>]
 *
 * For `/` and for `/?plan=<id>` (a missing id when none is given) it checks that no script or resource broke the
 * document policy (`securitypolicyviolation`), that nothing threw and React reported no hydration error, and that
 * the Welcome tab renders. On `/` it opens a new design and adds a recipe card, which the solver worker solves with
 * highs.wasm. Then it saves a font choice and reloads: the saved font must be on `<html>` before the module entry
 * starts (`window.__gtnhEntryStarted`), so the boot script stamped it, not the app. Prints every finding and exits
 * 1 when there is one.
 */
import { chromium, firefox } from "playwright-core";

const APP_FONT_STORAGE_KEY = "gtnh-app-font";
const SAVED_FONT = "minecraft";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const BASE = option("base", "http://127.0.0.1:3000").replace(/\/+$/, "");
const PLAN = option("plan", "missing-plan");
const findings = [];
const notes = [];

/**
 * Installed before any page script: the policy listener, and an observer that records the first `data-app-font`
 * value with whether the module entry had started by then. A hidden pane never fires requestAnimationFrame, so it
 * is shimmed with a timer.
 */
function initScript() {
  const check = { violations: [], font: undefined };
  Object.defineProperty(window, "__browserCheck", { value: check });
  document.addEventListener("securitypolicyviolation", (event) => {
    check.violations.push(
      `${event.violatedDirective} blocked ${event.blockedURI || "inline"} ${event.sample || ""}`.trim(),
    );
  });
  const record = () => {
    const value = document.documentElement.getAttribute("data-app-font");
    if (value !== null && check.font === undefined) {
      check.font = { value, entryStarted: window.__gtnhEntryStarted === true };
    }
  };
  // The init script can run before <html> exists, so the observer watches the document and its subtree.
  new MutationObserver(record).observe(document, {
    attributes: true,
    attributeFilter: ["data-app-font"],
    subtree: true,
  });
  const real = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    document.visibilityState === "hidden"
      ? window.setTimeout(() => callback(performance.now()), 16)
      : real(callback);
}

/** React's production errors for a hydration mismatch, and any message that names hydration. */
const HYDRATION = /hydrat|Minified React error #(418|419|421|422|423|425)\b/i;

async function checkEngine(name, engine) {
  const browser = await engine.launch({ headless: true });
  const label = (text) => `${name}: ${text}`;
  try {
    notes.push(label(`version ${browser.version()}`));
    /** A fresh profile: its own storage, so each visit starts as a first visit. */
    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(initScript);
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      const requests = [];
      page.on("pageerror", (error) => findings.push(label(`page error: ${error.message}`)));
      page.on("console", (message) => {
        const text = message.text();
        if (HYDRATION.test(text)) findings.push(label(`hydration: ${text}`));
        if (message.type() === "error" && /Content.Security.Policy|CSP/i.test(text)) {
          findings.push(label(`policy console error: ${text}`));
        }
      });
      // The context sees the workers' requests too (the solver fetches highs.wasm from its worker).
      context.on("response", (response) => {
        requests.push({ url: response.url().replace(BASE, ""), status: response.status() });
      });
      const visit = async (target) => {
        const response = await page.goto(`${BASE}${target}`, { waitUntil: "load" });
        if (response?.status() !== 200) {
          findings.push(label(`${target} answered ${response?.status()}`));
        }
        await page.waitForTimeout(1500);
        const check = await page.evaluate(() => window.__browserCheck);
        for (const violation of check.violations) {
          findings.push(label(`${target} policy: ${violation}`));
        }
        return check;
      };
      return { context, page, requests, visit };
    };

    // 1. The plan link, on a profile of its own: it opens the plan as a design where the library is on.
    const planVisit = await open();
    await planVisit.visit(`/?plan=${encodeURIComponent(PLAN)}`);
    await planVisit.page.waitForTimeout(3000);
    const planTabs = await planVisit.page.evaluate(
      () => document.querySelectorAll(".mt-tab[data-design-id]").length,
    );
    notes.push(
      label(`/?plan= title: ${await planVisit.page.title()}; ${planTabs} design tab(s) open`),
    );
    const planCheck = await planVisit.page.evaluate(() => window.__browserCheck);
    for (const violation of planCheck.violations) findings.push(label(`plan policy: ${violation}`));
    await planVisit.context.close();

    // 2. The home page on a fresh profile.
    const { context, page, requests, visit } = await open();
    await visit("/");
    // Where the mod and community switch is on, a first visit opens the mod announcement over Welcome.
    const announcement = page.locator('[aria-labelledby="mod-announcement-title"]');
    if (await announcement.count()) {
      await page.keyboard.press("Escape");
      await announcement.waitFor({ state: "detached" });
      notes.push(label("closed the mod announcement"));
    }
    const welcome = page.locator("button:has-text('New design')");
    if (!(await welcome.count())) {
      findings.push(label("Welcome: no New design button on a fresh profile"));
    } else {
      // 2. A new design, a recipe card, and the solver's wasm.
      await welcome.first().click();
      const field = page.locator('input[aria-label="Search items and fluids"]').first();
      await field.waitFor();
      await field.fill("Iron Ingot");
      const slot = page.locator('[aria-label="Resource results"] .nei-slot').first();
      await slot.waitFor();
      await slot.click();
      const add = page.locator('[aria-label="Add recipe node"]').first();
      await add.waitFor();
      await add.click();
      await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length > 0);
      await page.keyboard.press("Escape");
      const deadline = Date.now() + 60_000;
      while (
        Date.now() < deadline &&
        !requests.some((request) => /highs\.wasm/.test(request.url))
      ) {
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(2000);
      const wasm = requests.find((request) => /highs\.wasm/.test(request.url));
      if (!wasm)
        findings.push(
          label(
            `solve: the worker never fetched highs.wasm (highs requests: ${JSON.stringify(requests.filter((r) => /highs/.test(r.url)))})`,
          ),
        );
      else if (wasm.status !== 200)
        findings.push(label(`solve: highs.wasm answered ${wasm.status}`));
      else notes.push(label(`solver fetched ${wasm.url}`));
      const cards = await page.evaluate(
        () => document.querySelectorAll(".react-flow__node").length,
      );
      notes.push(label(`${cards} card(s) on the board`));
      const check = await page.evaluate(() => window.__browserCheck);
      for (const violation of check.violations) findings.push(label(`board policy: ${violation}`));
    }

    // 3. The saved font is stamped by the boot script, before the entry runs.
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [APP_FONT_STORAGE_KEY, SAVED_FONT],
    );
    const reloaded = await visit("/");
    if (!reloaded.font) {
      findings.push(label("font: data-app-font was never set after the reload"));
    } else if (reloaded.font.value !== SAVED_FONT || reloaded.font.entryStarted) {
      findings.push(
        label(
          `font: first data-app-font was ${JSON.stringify(reloaded.font.value)} with the entry ${reloaded.font.entryStarted ? "already started" : "not started"}`,
        ),
      );
    } else {
      notes.push(label(`font: ${SAVED_FONT} stamped before the entry started`));
    }
    const started = await page.evaluate(() => window.__gtnhEntryStarted === true);
    if (!started) findings.push(label("the module entry never started"));
    await context.close();
  } catch (error) {
    findings.push(label(`check failed: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  await checkEngine(name, engine);
}

for (const note of notes) console.log(`note ${note}`);
if (findings.length > 0) {
  for (const finding of findings) console.log(`FAIL ${finding}`);
  process.exit(1);
}
console.log("ok");
