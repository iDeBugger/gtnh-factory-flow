import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serverEnv, writeEntry } from "./build-server.mjs";
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
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    onOutput?.(output, child);
  });
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, output })),
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STAND_IN = 'import "./dep.mjs";\nexport async function startServer() {}\n';

describe("server.mjs", () => {
  it("sets NODE_ENV to production before any module the bundle imports is evaluated", async () => {
    const { code, output } = await run(entryWith(STAND_IN), { NODE_ENV: undefined });
    expect(code).toBe(0);
    expect(output).toBe("NODE_ENV=production\n");
  });

  it("leaves a NODE_ENV the caller set alone", async () => {
    const { output } = await run(entryWith(STAND_IN), { NODE_ENV: "test" });
    expect(output).toBe("NODE_ENV=test\n");
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
