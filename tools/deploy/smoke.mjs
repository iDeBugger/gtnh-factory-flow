#!/usr/bin/env node
/**
 * The smoke test of a deployed stack (docs/deploy.md), runnable alone:
 *
 *   node tools/deploy/smoke.mjs --base https://stage.gtnhplanner.idebugger.net [--caddy] [--skip-accounts]
 *
 * HTTP: the version and live health, the security headers, the dataset gate,
 * the live service's internal routes kept off the site, board image uploads,
 * the mod-and-community switch. Browser (headless, fresh profile): Welcome, a
 * new design, a recipe card, the solver's wasm, a 2.8.1 plan asking the 2.8.1
 * dataset, no page errors. Accounts: two throwaway accounts, a design saved by
 * one session and read by another, a foreign Origin refused.
 *
 * --caddy adds what only the edge answers (HSTS over https, the prewarm 404,
 * the 8 MB body cap). Screenshots go to scratch/probes/ (look, then delete
 * them). Prints every check and exits 1 when one fails.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = (option("--base", "http://127.0.0.1:3300") ?? "").replace(/\/+$/, "");
const CADDY = flag("--caddy");
const VERSIONS = (option("--versions", "local-2.9.0-rc-2,local-2.8.1") ?? "").split(",");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../scratch/probes");
mkdirSync(out, { recursive: true });

const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
};

async function http(url, init = {}) {
  try {
    return await fetch(`${BASE}${url}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      ...init,
    });
  } catch (error) {
    return {
      status: 0,
      headers: new Headers(),
      text: async () => String(error),
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
}
const header = (response, name) => response.headers.get(name) ?? "";

// ---- Version and health -------------------------------------------------------------------
const version = await http("/api/version");
const versionBody = await version.json().catch(() => ({}));
check(
  version.status === 200 && typeof versionBody.build === "string" && versionBody.build.length > 0,
  "/api/version names a build",
  JSON.stringify(versionBody),
);
check(
  header(version, "cache-control").includes("no-store"),
  "/api/version is not cached",
  header(version, "cache-control"),
);
const health = await http("/live/health");
const healthBody = await health.json().catch(() => ({}));
check(
  health.status === 200 && healthBody.ok === true,
  "/live/health ok",
  JSON.stringify(healthBody),
);

// ---- Headers ------------------------------------------------------------------------------
const home = await http("/");
check(home.status === 200, "/ answers 200", String(home.status));
check(header(home, "x-content-type-options") === "nosniff", "nosniff on /");
if (CADDY && BASE.startsWith("https://")) {
  check(
    header(home, "strict-transport-security").includes("max-age=15552000"),
    "HSTS on /",
    header(home, "strict-transport-security"),
  );
}
check(
  (await http("/_next/image?url=/site-icon.png&w=64&q=75")).status === 404,
  "/_next/image is off",
);
const wasm = await http("/highs.wasm");
check(
  wasm.status === 200 && header(wasm, "content-type").startsWith("application/wasm"),
  "highs.wasm is application/wasm",
  header(wasm, "content-type"),
);

// ---- Datasets -----------------------------------------------------------------------------
const manifest = await http("/datasets/gtnh/datasets.manifest.json");
check(
  manifest.status === 200 && header(manifest, "cache-control").includes("max-age=0"),
  "the manifest is served uncached",
  header(manifest, "cache-control"),
);
const listed = (await manifest.json().catch(() => ({ versions: [] }))).versions ?? [];
for (const id of VERSIONS) {
  const entry = listed.find((v) => v.id === id);
  if (!check(Boolean(entry), `${id} is in the manifest`)) continue;
  check(
    (await http(`/datasets/gtnh/${id}/recipes.json`)).status !== 200,
    `${id} recipes.json is not served`,
  );
  check(
    (await http(`/datasets/gtnh/${id}/recipes%2Ejson`)).status === 400,
    `${id} recipes%2Ejson is 400`,
  );
  const index = await http(`/dataset-files/${id}/recipe-lookup-index.json.gz`);
  check(
    index.status === 200 && header(index, "etag") !== "",
    `${id} lookup index through /dataset-files with an ETag`,
    `${index.status}`,
  );
  await index.arrayBuffer().catch(() => undefined);
  const catalog = await http(`/api/datasets/${id}/catalog`);
  check(catalog.status === 200, `${id} catalog`, String(catalog.status));
  const body = await catalog.text();
  const texture = /textures\/rendered\/[A-Za-z0-9._-]+\.png/.exec(body)?.[0];
  if (texture) {
    const served = await http(`/datasets/gtnh/${id}/${texture}`);
    check(
      served.status === 200 && header(served, "cache-control").includes("immutable"),
      `${id} rendered texture is immutable`,
      `${served.status} ${header(served, "cache-control")}`,
    );
  }
  if (CADDY) {
    check(
      (await http(`/api/datasets/${id}/prewarm`)).status === 404,
      `${id} prewarm is closed at the edge`,
    );
  }
}

// ---- The live service's internal routes are not the site's --------------------------------
const internal = await http("/internal/members", {
  method: "POST",
  body: "{}",
  headers: { "content-type": "application/json" },
});
check(internal.status === 404, "POST /internal/members is the site's 404", String(internal.status));

// ---- The switch (off on stage) ------------------------------------------------------------
const communityOn = (await http("/community")).status !== 404;
console.log(`     mod and community: ${communityOn ? "on" : "off"}`);
if (!communityOn) {
  check(
    (await http("/api/community/plans")).status === 404,
    "/api/community/plans is 404 with the switch off",
  );
}

// ---- Board images -------------------------------------------------------------------------
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
{
  const form = new FormData();
  form.set("image", new Blob([PNG], { type: "image/png" }), "board.png");
  const upload = await http("/api/community/images", { method: "POST", body: form });
  const { url } = await upload.json().catch(() => ({}));
  if (
    check(
      upload.status === 200 &&
        typeof url === "string" &&
        url.startsWith(`${BASE}/api/community/images/`),
      "a board image upload answers a URL on this site",
      url ?? String(upload.status),
    )
  ) {
    const image = await http(url.slice(BASE.length));
    check(
      image.status === 200 &&
        header(image, "content-type") === "image/png" &&
        header(image, "x-content-type-options") === "nosniff" &&
        header(image, "cache-control").includes("immutable"),
      "the image is served as image/png, nosniff, immutable",
    );
  }
  const text = new FormData();
  text.set(
    "image",
    new Blob([Buffer.from("just words, not a picture")], { type: "image/png" }),
    "x.png",
  );
  check(
    (await http("/api/community/images", { method: "POST", body: text })).status === 415,
    "a text file is refused 415",
  );
  if (CADDY) {
    const big = new FormData();
    big.set("image", new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "image/png" }), "big.png");
    check(
      (await http("/api/community/images", { method: "POST", body: big })).status === 413,
      "a 9 MB body is refused 413",
    );
  }
}

// ---- Accounts -----------------------------------------------------------------------------
if (!flag("--skip-accounts")) {
  const name = `smoke${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const password = randomUUID();
  const signIn = async (route) => {
    const response = await http(`/api/community/auth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password }),
    });
    const cookie =
      response.headers.getSetCookie?.().find((line) => line.startsWith("gtnh_session=")) ?? "";
    return { status: response.status, cookie: cookie.split(";")[0] };
  };
  const first = await signIn("register");
  if (check(first.status === 200 && first.cookie !== "", "sign up", String(first.status))) {
    const designId = `design-${randomUUID()}`;
    const stamp = new Date().toISOString();
    const plan = {
      schemaVersion: 1,
      id: designId,
      name: "Smoke plan",
      recipes: [],
      nodes: [],
      storages: [],
      edges: [],
      fuelProfiles: [],
    };
    const saved = await http(`/api/library/designs/${designId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({
        name: "Smoke plan",
        icon: null,
        folderId: null,
        closed: false,
        favorite: false,
        order: null,
        communityPlanId: null,
        createdAt: stamp,
        updatedAt: stamp,
        planUpdatedAt: stamp,
        plan,
      }),
    });
    check(
      saved.status === 200,
      "a signed-in save",
      `${saved.status} ${saved.status === 200 ? "" : await saved.text()}`,
    );
    const second = await signIn("login");
    check(
      second.status === 200 && second.cookie !== first.cookie,
      "sign in from a second session",
      String(second.status),
    );
    const library = await http("/api/library", { headers: { cookie: second.cookie } });
    const designs = (await library.json().catch(() => ({}))).designs ?? [];
    check(
      designs.some((d) => d.id === designId),
      "the second session sees the saved design",
    );
    const foreign = await http("/api/library/folders/smoke-folder", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: second.cookie,
        origin: "https://evil.example",
      },
      body: "{}",
    });
    check(foreign.status === 403, "a write with a foreign Origin is 403", String(foreign.status));
  }
}

// ---- Browser ------------------------------------------------------------------------------
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const real = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      document.visibilityState === "hidden"
        ? window.setTimeout(() => cb(performance.now()), 16)
        : real(cb);
  });
  const page = await context.newPage();
  const pageErrors = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requests.push(request.url().replace(BASE, "")));
  await page.goto(BASE, { waitUntil: "load" });
  const welcome = page.locator("button:has-text('New design')").first();
  if (
    check(
      await welcome.waitFor({ timeout: 120_000 }).then(
        () => true,
        () => false,
      ),
      "a fresh profile lands on Welcome",
    )
  ) {
    await welcome.click();
    const field = page.locator('input[aria-label="Search items and fluids"]').first();
    await field.waitFor({ timeout: 120_000 });
    await field.fill("Iron Ingot");
    const slot = page.locator('[aria-label="Resource results"] .nei-slot').first();
    if (
      check(
        await slot.waitFor({ timeout: 60_000 }).then(
          () => true,
          () => false,
        ),
        "searching Iron Ingot finds it",
      )
    ) {
      await slot.click();
      const add = page.locator('[aria-label="Add recipe node"]').first();
      const landed = await add
        .waitFor({ timeout: 60_000 })
        .then(() => add.click())
        .then(() =>
          page.waitForFunction(
            () => document.querySelectorAll(".react-flow__node").length > 0,
            null,
            { timeout: 30_000 },
          ),
        )
        .then(
          () => true,
          () => false,
        );
      check(landed, "a recipe card lands on the board");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(3000);
      check(
        requests.some((url) => /highs\.wasm/.test(url)),
        "the solver fetched highs.wasm",
      );
      await page.screenshot({ path: path.join(out, "smoke-new-design.png") });
    }
    const picker = page.locator('[data-mb="new-plan-version"]');
    if (VERSIONS.includes("local-2.8.1") && (await picker.count())) {
      await picker.click();
      await page
        .locator('[role="menu"] [role="menuitem"]', { hasText: "GTNH 2.8.1" })
        .first()
        .click();
      await page.click(".mt-plus");
      await page
        .locator('[role="menu"] [role="menuitem"]', { hasText: /^New plan$/ })
        .first()
        .click();
      const mark = requests.length;
      const field281 = page.locator('input[aria-label="Search items and fluids"]').first();
      await field281.fill("");
      await field281.fill("Copper Ingot");
      await page
        .locator('[aria-label="Resource results"] .nei-slot')
        .first()
        .waitFor({ timeout: 60_000 })
        .catch(() => undefined);
      check(
        requests.slice(mark).some((url) => /\/api\/datasets\/local-2\.8\.1\//.test(url)),
        "a 2.8.1 plan searches local-2.8.1",
      );
    }
  }
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
