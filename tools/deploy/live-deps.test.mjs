import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { externalPackages, packageName, runtimeClosure } from "./live-deps.mjs";

// pg 8 and kysely as npm 11 writes them: pg needs pgpass (and split2) only for a connection without a
// password, and pg-cloudflare is an optional dependency, so an import of "pg" alone never loads them.
const pgLock = {
  packages: {
    "": { dependencies: { kysely: "^0.28.0", pg: "^8.16.0", ws: "^8.21.3" } },
    "node_modules/kysely": {},
    "node_modules/pg": {
      dependencies: {
        "pg-connection-string": "^2.14.1",
        "pg-pool": "^3.14.0",
        "pg-protocol": "^1.16.1",
        "pg-types": "2.2.0",
        pgpass: "1.0.5",
      },
      optionalDependencies: { "pg-cloudflare": "^1.4.1" },
      peerDependencies: { "pg-native": ">=3.0.1" },
      peerDependenciesMeta: { "pg-native": { optional: true } },
    },
    "node_modules/pg-cloudflare": { optional: true },
    "node_modules/pg-connection-string": {},
    "node_modules/pg-int8": {},
    "node_modules/pg-pool": { peerDependencies: { pg: ">=8.0" } },
    "node_modules/pg-protocol": {},
    "node_modules/pg-types": {
      dependencies: {
        "pg-int8": "1.0.1",
        "postgres-array": "~2.0.0",
        "postgres-bytea": "~1.0.0",
        "postgres-date": "~1.0.4",
        "postgres-interval": "^1.1.0",
      },
    },
    "node_modules/pgpass": { dependencies: { split2: "^4.1.0" } },
    "node_modules/postgres-array": {},
    "node_modules/postgres-bytea": {},
    "node_modules/postgres-date": {},
    "node_modules/postgres-interval": { dependencies: { xtend: "^4.0.0" } },
    "node_modules/split2": {},
    "node_modules/ws": {
      peerDependencies: { bufferutil: "^4.0.1", "utf-8-validate": ">=5.0.2" },
      peerDependenciesMeta: { bufferutil: { optional: true }, "utf-8-validate": { optional: true } },
    },
    "node_modules/xtend": {},
    "node_modules/next": { dependencies: { "styled-jsx": "5.1.6" } },
    "node_modules/styled-jsx": {},
  },
};

describe("the live image's packages", () => {
  it("names the package of a bare import, never a builtin or a path", () => {
    expect(packageName("pg")).toBe("pg");
    expect(packageName("pg/lib/client.js")).toBe("pg");
    expect(packageName("@electric-sql/pglite")).toBe("@electric-sql/pglite");
    expect(packageName("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageName("node:fs")).toBeNull();
    expect(packageName("./x.mjs")).toBeNull();
  });

  it("reads the bundle's external packages from esbuild's metafile", () => {
    const meta = {
      outputs: {
        "dist-live/live.mjs": {
          imports: [
            { path: "node:http", kind: "import-statement", external: true },
            { path: "pg", kind: "import-statement", external: true },
            { path: "kysely", kind: "import-statement", external: true },
            { path: "pg/lib/utils.js", kind: "import-statement", external: true },
            { path: "src/live/x.ts", kind: "import-statement" },
          ],
        },
      },
    };
    expect(externalPackages(meta)).toEqual(["kysely", "pg"]);
  });

  it("takes pg's whole run-time closure, the lazily loaded pgpass and split2 too, and nothing else", () => {
    const keys = runtimeClosure(pgLock, ["kysely", "pg", "ws"]).map((key) => key.slice("node_modules/".length));
    expect(keys).toEqual([
      "kysely",
      "pg",
      "pg-cloudflare",
      "pg-connection-string",
      "pg-int8",
      "pg-pool",
      "pg-protocol",
      "pg-types",
      "pgpass",
      "postgres-array",
      "postgres-bytea",
      "postgres-date",
      "postgres-interval",
      "split2",
      "ws",
      "xtend",
    ]);
  });

  it("resolves a nested copy before the hoisted one, as Node does", () => {
    const lock = {
      packages: {
        "node_modules/a": { dependencies: { b: "2" } },
        "node_modules/a/node_modules/b": { dependencies: { c: "1" } },
        "node_modules/b": { dependencies: { d: "1" } },
        "node_modules/c": {},
        "node_modules/d": {},
      },
    };
    expect(runtimeClosure(lock, ["a"])).toEqual([
      "node_modules/a",
      "node_modules/a/node_modules/b",
      "node_modules/c",
    ]);
  });

  it("skips an optional package that is not installed and refuses a required one", () => {
    const lock = {
      packages: {
        "node_modules/a": { optionalDependencies: { gone: "1" }, dependencies: { missing: "1" } },
      },
    };
    expect(() => runtimeClosure(lock, ["a"])).toThrow("missing, needed by node_modules/a");
    lock.packages["node_modules/a"].dependencies = {};
    expect(runtimeClosure(lock, ["a"])).toEqual(["node_modules/a"]);
  });

  it("skips an optional package the lockfile lists but this platform did not install", () => {
    // npm writes every platform's optional binaries into the lockfile and installs only the matching one.
    const lock = {
      packages: {
        "node_modules/sharp": {
          dependencies: { "detect-libc": "^2" },
          optionalDependencies: { "@img/sharp-linux-x64": "0.34.5", "@img/sharp-linux-arm64": "0.34.5" },
        },
        "node_modules/detect-libc": {},
        "node_modules/@img/sharp-linux-x64": { optional: true, os: ["linux"], cpu: ["x64"] },
        "node_modules/@img/sharp-linux-arm64": { optional: true, os: ["linux"], cpu: ["arm64"] },
        "node_modules/w": {
          peerDependencies: { native: "1" },
          peerDependenciesMeta: { native: { optional: true } },
        },
        "node_modules/native": { optional: true },
      },
    };
    const onDisk = new Set(["node_modules/sharp", "node_modules/detect-libc", "node_modules/@img/sharp-linux-arm64", "node_modules/w"]);
    expect(runtimeClosure(lock, ["sharp", "w"], (key) => onDisk.has(key))).toEqual([
      "node_modules/@img/sharp-linux-arm64",
      "node_modules/detect-libc",
      "node_modules/sharp",
      "node_modules/w",
    ]);
  });

  it("refuses a required package the lockfile lists but that is not installed", () => {
    const lock = {
      packages: {
        "node_modules/a": { dependencies: { b: "1" } },
        "node_modules/b": {},
      },
    };
    expect(() => runtimeClosure(lock, ["a"], (key) => key !== "node_modules/b")).toThrow(
      "node_modules/b, needed by node_modules/a, is in package-lock.json but not installed.",
    );
  });

  it("covers today's live bundle from the repo's lockfile", () => {
    const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
    const keys = runtimeClosure(lock, ["kysely", "pg", "ws", "zod"]);
    expect(keys).toEqual([
      "node_modules/kysely",
      "node_modules/pg",
      "node_modules/pg-cloudflare",
      "node_modules/pg-connection-string",
      "node_modules/pg-int8",
      "node_modules/pg-pool",
      "node_modules/pg-protocol",
      "node_modules/pg-types",
      "node_modules/pgpass",
      "node_modules/postgres-array",
      "node_modules/postgres-bytea",
      "node_modules/postgres-date",
      "node_modules/postgres-interval",
      "node_modules/split2",
      "node_modules/ws",
      "node_modules/xtend",
      "node_modules/zod",
    ]);
  });
});
