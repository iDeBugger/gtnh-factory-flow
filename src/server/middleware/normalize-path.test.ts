import { execFile } from "node:child_process";
import path from "node:path";
import nodeUrl, { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPARSED_TARGET, legacyUrlParser, routableTarget } from "./normalize-path";

const REPO = path.resolve(__dirname, "../../..");

describe("routableTarget", () => {
  it("keeps a target the router parses and replaces one it cannot", () => {
    expect(routableTarget("/x?a=1")).toBe("/x?a=1");
    expect(routableTarget("*")).toBe("*");
    expect(routableTarget("http://host/x")).toBe("http://host/x");
    expect(routableTarget("http://[/x")).toBe(UNPARSED_TARGET);
  });

  it("prints no deprecation warning for a target that does not start with /", async () => {
    // The warning is printed once per process, so a fresh process is the only one that can show it. The child
    // records every warning with the step it came in; the control step proves a DEP0169 would be seen.
    const script = `
      import { parse } from "node:url";
      const { routableTarget } = await import(${JSON.stringify(
        pathToFileURL(path.join(REPO, "src/server/middleware/normalize-path.ts")).href,
      )});
      const warnings = [];
      let step = "routable";
      process.on("warning", (warning) => warnings.push(step + " " + (warning.code ?? warning.name)));
      const answers = ["*", "http://host/x", "http://[/x"].map(routableTarget);
      await new Promise((resolve) => setImmediate(resolve));
      step = "control";
      parse("*");
      await new Promise((resolve) => setImmediate(resolve));
      console.log(JSON.stringify({ answers, warnings }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href,
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: REPO, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json") } },
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      answers: ["*", "http://host/x", UNPARSED_TARGET],
      warnings: ["control DEP0169"],
    });
  });
});

describe("legacyUrlParser", () => {
  afterEach(() => {
    vi.doUnmock("node:url");
    vi.resetModules();
  });

  it("takes node:url's own Url", () => {
    expect(legacyUrlParser(nodeUrl)).toBe((nodeUrl as unknown as { Url: unknown }).Url);
  });

  it("refuses a Url that is missing, cannot be constructed, has no parse or parses otherwise", () => {
    class Throws {
      constructor() {
        throw new Error("no");
      }
    }
    class NoParse {}
    class AcceptsAll {
      parse(): void {}
    }
    class RefusesAll {
      parse(): void {
        throw new TypeError("refused");
      }
    }
    for (const [module, why] of [
      [{}, "is missing"],
      [undefined, "is missing"],
      [{ Url: "Url" }, "is missing"],
      [{ Url: () => ({}) }, "cannot be constructed"],
      [{ Url: Throws }, "cannot be constructed"],
      [{ Url: NoParse }, "has no parse method"],
      [{ Url: AcceptsAll }, "no longer parses as parseurl does"],
      [{ Url: RefusesAll }, "no longer parses as parseurl does"],
    ] as const) {
      expect(() => legacyUrlParser(module), why).toThrow(why);
    }
  });

  it("stops the module from loading when node:url has no Url, so the server does not start", async () => {
    vi.resetModules();
    vi.doMock("node:url", async (importOriginal) => {
      const rest = { ...(await importOriginal<Record<string, unknown>>()) };
      delete rest.Url;
      return { ...rest, default: { ...rest } };
    });
    await expect(import("./normalize-path")).rejects.toThrow(/legacy Url parser is missing/);
  });
});
