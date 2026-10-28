import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, serverEnv, writeEntry } from "./build-server.mjs";
import { serverDefines } from "./define.mjs";

const dirs = [];

/** writeEntry's server.mjs beside a stand-in app.mjs, whose dependency prints NODE_ENV as it loads. */
function entryWith(appSource) {
  const dir = mkdtempSync(path.join(tmpdir(), "server-entry-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "dep.mjs"), "console.log(`NODE_ENV=${process.env.NODE_ENV}`);\n");
  writeFileSync(path.join(dir, "app.mjs"), appSource);
  writeEntry(dir);
  return dir;
}

/** Runs server.mjs with `env` in place of the caller's NODE_ENV; resolves with its exit and its output. */
function run(dir, env, onOutput) {
  const childEnv = { ...process.env, ...env };
  if (env.NODE_ENV === undefined) delete childEnv.NODE_ENV;
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    cwd: dir,
    env: childEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    onOutput?.(output, child);
  });
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, output })),
  );
}

/** Every server a test spawned: one a failed or timed-out test left running is killed before the next test. */
const children = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STAND_IN = 'import "./dep.mjs";\nexport async function startServer() {}\n';

describe("server.mjs", () => {
  it("sets NODE_ENV to production before any module the bundle imports is evaluated", async () => {
    const { code, output } = await run(entryWith(STAND_IN), { NODE_ENV: undefined });
    expect(code).toBe(0);
    expect(output).toBe("NODE_ENV=production\n");
  });

  it("overrides a NODE_ENV the caller set, as Next's server.js does", async () => {
    for (const value of ["test", "development"]) {
      const { output } = await run(entryWith(STAND_IN), { NODE_ENV: value });
      expect(output, value).toBe("NODE_ENV=production\n");
    }
  });

  it("starts the server from server.mjs", async () => {
    const dir = entryWith(
      [
        'import http from "node:http";',
        "export async function startServer() {",
        '  const server = http.createServer((_req, res) => res.end("up"));',
        '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
        "  console.log(`port ${server.address().port}`);",
        '  process.on("SIGTERM", () => server.close(() => process.exit(143)));',
        "}",
        "",
      ].join("\n"),
    );
    let answered;
    const exited = run(dir, {}, (output, child) => {
      const port = /port (\d+)/.exec(output)?.[1];
      if (!port || answered) return;
      answered = new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: Number(port), path: "/" }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              resolve(body);
              child.kill("SIGTERM");
            });
          })
          .on("error", reject);
      });
    });
    const { code } = await exited;
    expect(await answered).toBe("up");
    expect(code).toBe(143);
  });
});

describe("serverEnv", () => {
  function clientWith(values) {
    const dir = mkdtempSync(path.join(tmpdir(), "client-build-"));
    dirs.push(dir);
    if (values) writeFileSync(path.join(dir, "build.json"), JSON.stringify(values));
    return dir;
  }

  it("takes the community switch and the build id from the client build", () => {
    const dir = clientWith({ modAndCommunity: "on", buildId: "4.4.1-abcdef12" });
    const env = serverEnv(dir, {
      NEXT_PUBLIC_MOD_AND_COMMUNITY: "on",
      NEXT_PUBLIC_SITE_URL: "https://x.test",
    });
    expect(env).toMatchObject({
      NEXT_PUBLIC_MOD_AND_COMMUNITY: "on",
      GTNH_BUILD_ID: "4.4.1-abcdef12",
      NEXT_PUBLIC_SITE_URL: "https://x.test",
    });
    expect(serverDefines(env)).toMatchObject({
      "process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY": '"on"',
      "process.env.NEXT_PUBLIC_GTNH_BUILD_ID": '"4.4.1-abcdef12"',
    });
    expect(serverEnv(clientWith({ modAndCommunity: "", buildId: "b" }), {})).toMatchObject({
      NEXT_PUBLIC_MOD_AND_COMMUNITY: "",
      GTNH_BUILD_ID: "b",
    });
  });

  it("fails when the server would be built with another switch or build id than the client", () => {
    const dir = clientWith({ modAndCommunity: "", buildId: "b" });
    expect(() => serverEnv(dir, { NEXT_PUBLIC_MOD_AND_COMMUNITY: "on" })).toThrow(
      /NEXT_PUBLIC_MOD_AND_COMMUNITY is "on" here but "" in the client build/,
    );
    expect(() => serverEnv(clientWith({ modAndCommunity: "on", buildId: "b" }), {})).toThrow(
      /is "" here but "on"/,
    );
    expect(() => serverEnv(dir, { GTNH_BUILD_ID: "other" })).toThrow(/GTNH_BUILD_ID is "other"/);
    expect(() => serverEnv(clientWith(undefined), {})).toThrow(
      /run build:client before build:server/,
    );
  });
});

describe("the built server", () => {
  const REPO = path.resolve(import.meta.dirname, "../..");
  const HASH = `'sha256-${"B".repeat(43)}='`;

  it("serves the production policy with the page's hashes under a caller-set NODE_ENV=development", async () => {
    // A working folder as the server expects it: the built client, the site files, public/.
    const cwd = mkdtempSync(path.join(tmpdir(), "built-server-"));
    dirs.push(cwd);
    const client = path.join(cwd, "dist", "client");
    mkdirSync(client, { recursive: true });
    writeFileSync(
      path.join(client, "index.html"),
      '<!doctype html><html lang="en"><head><!--app-head--></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(
      path.join(client, "page.json"),
      JSON.stringify({ scriptHashes: [HASH], fontPreloads: [], assetVersions: {} }),
    );
    writeFileSync(
      path.join(client, "build.json"),
      JSON.stringify({ modAndCommunity: "", buildId: "t" }),
    );
    mkdirSync(path.join(cwd, "src", "app"), { recursive: true });
    for (const file of ["favicon.ico", "opengraph-image.png"]) {
      copyFileSync(path.join(REPO, "src", "app", file), path.join(cwd, "src", "app", file));
    }
    mkdirSync(path.join(cwd, "public"));
    // The bundle sits inside the repository, so its external packages resolve from its node_modules.
    mkdirSync(path.join(REPO, "dist"), { recursive: true });
    const outDir = mkdtempSync(path.join(REPO, "dist", "test-server-"));
    dirs.push(outDir);
    await buildServer({ root: REPO, outDir, clientDir: client, env: { GTNH_BUILD_ID: "t" } });

    let policy;
    const child = spawn(process.execPath, [path.join(outDir, "server.mjs")], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: "0",
        HOSTNAME: "127.0.0.1",
        GTNH_PREWARM_ON_STARTUP: "",
        NEXT_PUBLIC_MOD_AND_COMMUNITY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
        if (!port || policy !== undefined) return;
        policy = null;
        http
          .get({ host: "127.0.0.1", port: Number(port), path: "/" }, (res) => {
            res.resume();
            policy = res.headers["content-security-policy"];
            resolve();
          })
          .on("error", reject);
      });
      child.once("exit", () => reject(new Error(`exited before answering: ${output}`)));
    });
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    const scriptSrc = policy.split("; ").find((directive) => directive.startsWith("script-src"));
    expect(scriptSrc).toBe(`script-src 'self' ${HASH} 'wasm-unsafe-eval'`);
  }, 60_000);
});
