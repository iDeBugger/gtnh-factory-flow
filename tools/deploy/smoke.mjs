#!/usr/bin/env node
/**
 * The smoke test of a deployed stack (docs/deploy.md), runnable alone:
 *
 *   node tools/deploy/smoke.mjs --base https://stage.gtnhplanner.idebugger.net [--caddy] [--skip-accounts]
 *     [--no-expect-hashed-csp]
 *
 * Without Caddy in front (a workstation rehearsal), --live <url> names the
 * live service's own port for /live/health.
 *
 * HTTP: the version and live health, the security headers (on an unknown
 * path's 404 too), a page policy whose scripts are allowed by hash and never
 * by 'unsafe-inline' (--no-expect-hashed-csp skips this for an older build),
 * the 308s for a trailing slash and a doubled slash, case-sensitive paths, a
 * cross-site write refused, the dataset gate, the live service's internal
 * routes kept off the site, board image uploads, the mod-and-community switch.
 * Browser (headless, fresh profile): Welcome, a new design, a recipe card, the
 * solver's wasm, a 2.8.1 plan asking the 2.8.1 dataset, no page errors, no
 * policy violation and no hydration message. Accounts: two throwaway accounts,
 * a design saved by one session and read by another, a foreign Origin refused.
 *
 * --caddy adds what only the edge answers (HSTS over https, the prewarm 404,
 * the 8 MB body cap, compression of the page and a script, and a dataset
 * file's bytes the same with and without compression). Screenshots go to
 * scratch/probes/ (look, then delete them). Prints every check and exits 1
 * when one fails.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import nodeHttp from "node:http";
import nodeHttps from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { policyListener, policyViolations, watchConsole } from "../http-parity/page-listeners.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = (option("--base", "http://127.0.0.1:3300") ?? "").replace(/\/+$/, "");
const CADDY = flag("--caddy");
const EXPECT_HASHED_CSP = !flag("--no-expect-hashed-csp");
const LIVE = (option("--live", BASE) ?? BASE).replace(/\/+$/, "");
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

/**
 * One GET whose answer is read as sent: fetch would decompress it and hide the Content-Encoding. Resolves with
 * status 0 when there is no answer.
 */
function rawGet(target, headers = {}) {
  const url = new URL(`${BASE}${target}`);
  const client = url.protocol === "https:" ? nodeHttps : nodeHttp;
  return new Promise((resolve) => {
    const request = client.get(url, { headers, timeout: 60_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
  });
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** A raw answer's body as the client reads it: gunzipped when it was sent gzip-encoded. */
const decoded = (answer) =>
  answer.headers["content-encoding"] === "gzip" ? gunzipSync(answer.body) : answer.body;

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
const health = await fetch(`${LIVE}/live/health`, { signal: AbortSignal.timeout(30_000) }).catch(
  () => ({ status: 0, json: async () => ({}) }),
);
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
const unknown = await http(`/smoke-missing-${randomUUID()}`);
check(
  unknown.status === 404 &&
    header(unknown, "x-content-type-options") === "nosniff" &&
    header(unknown, "content-security-policy").includes("default-src"),
  "an unknown path answers 404 with the security headers",
  `${unknown.status} ${header(unknown, "x-content-type-options")}`,
);
if (EXPECT_HASHED_CSP) {
  const scriptSrc =
    /(?:^|;)\s*script-src ([^;]*)/.exec(header(home, "content-security-policy"))?.[1] ?? "";
  check(
    /'sha256-[A-Za-z0-9+/]{43}='/.test(scriptSrc) && !scriptSrc.includes("'unsafe-inline'"),
    "the page's scripts are allowed by hash, not 'unsafe-inline'",
    scriptSrc,
  );
}
for (const target of ["/api/version/", "//api/version"]) {
  const moved = await http(target);
  check(
    moved.status === 308 &&
      header(moved, "location") === "/api/version" &&
      header(moved, "refresh") === "0;url=/api/version",
    `${target} is a 308 to /api/version with Refresh`,
    `${moved.status} ${header(moved, "location")} ${header(moved, "refresh")}`,
  );
}
check((await http("/API/version")).status === 404, "/API/version is 404: paths are case-sensitive");
const crossSite = await http("/API/community/auth/logout", {
  method: "POST",
  headers: { origin: "https://evil.example", "content-type": "application/json" },
  body: "{}",
});
check(
  crossSite.status < 200 || crossSite.status > 299,
  "a cross-site POST to /API/community/auth/logout is not 2xx",
  String(crossSite.status),
);
if (CADDY) {
  const page = await rawGet("/", { "accept-encoding": "gzip" });
  check(
    page.status === 200 && page.headers["content-encoding"] === "gzip",
    "/ is compressed at the edge",
    `${page.status} ${page.headers["content-encoding"] ?? "no content-encoding"}`,
  );
  const script = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(decoded(page).toString())?.[0];
  if (check(Boolean(script), "the page names a script under /assets/")) {
    const asset = await rawGet(script, { "accept-encoding": "gzip" });
    check(
      asset.status === 200 && asset.headers["content-encoding"] === "gzip",
      `${script} is compressed at the edge`,
      `${asset.status} ${asset.headers["content-encoding"] ?? "no content-encoding"}`,
    );
  }
}
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
  if (CADDY) {
    // The bytes a player gets, decoded as sent, are the same whether the edge compressed them or not.
    const target = `/dataset-files/${id}/recipe-lookup-index.json.gz`;
    const plain = await rawGet(target, { "accept-encoding": "identity" });
    const packed = await rawGet(target, { "accept-encoding": "gzip" });
    check(
      plain.status === 200 &&
        packed.status === 200 &&
        sha256(decoded(plain)) === sha256(decoded(packed)),
      `${id} lookup index bytes are the same with and without Accept-Encoding`,
      `${plain.status}/${packed.status} ${packed.headers["content-encoding"] ?? "no content-encoding"}`,
    );
  }
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
  if (
    check(
      (first.status === 200 || first.status === 201) && first.cookie !== "",
      "sign up",
      String(first.status),
    )
  ) {
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
  await context.addInitScript(policyListener);
  const page = await context.newPage();
  const pageErrors = [];
  const pageFindings = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  watchConsole(page, (finding) => pageFindings.push(finding));
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
    // A new plan's version is the Settings choice (Plans > New plans), offered while the site serves both.
    const plans = page.locator(".ms-section", { hasText: /^Plans$/ });
    const offered =
      VERSIONS.includes("local-2.8.1") &&
      (await page
        .locator('[aria-label="Settings"]')
        .first()
        .click()
        .then(() => plans.waitFor({ timeout: 10_000 }))
        .then(
          () => true,
          () => false,
        ));
    if (
      VERSIONS.includes("local-2.8.1") &&
      check(offered, "Settings offers New plans: GTNH 2.8.1")
    ) {
      await plans.click();
      await page.locator('[role="radio"]', { hasText: "GTNH 2.8.1" }).first().click();
      await page.keyboard.press("Escape");
      await page.click(".mt-plus");
      await page
        .locator('[role="menu"] [role="menuitem"]', { hasText: /^New plan$/ })
        .first()
        .click();
      // The new plan's first dataset request is the proof: its catalog or a search.
      const asked = page
        .waitForRequest((request) => /\/api\/datasets\/local-2\.8\.1\//.test(request.url()), {
          timeout: 90_000,
        })
        .then(
          () => true,
          () => false,
        );
      const field281 = page.locator('input[aria-label="Search items and fluids"]').first();
      await field281.fill("");
      await field281.fill("Copper Ingot");
      check(
        (await asked) || requests.some((url) => /\/api\/datasets\/local-2\.8\.1\//.test(url)),
        "a 2.8.1 plan asks the local-2.8.1 dataset",
      );
      await page.screenshot({ path: path.join(out, "smoke-2-8-1.png") });
    }
  }
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
  pageFindings.push(...(await policyViolations(page)).map((violation) => `policy: ${violation}`));
  check(
    pageFindings.length === 0,
    "no policy violation and no hydration message",
    pageFindings.slice(0, 3).join(" | "),
  );
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
