import { describe, expect, test } from "vitest";
import {
  DEFAULT_GAME_VERSION,
  gameVersionLabel,
  gameVersionOfDataset,
  planGameVersion,
} from "./game-version";

describe("a plan's game version", () => {
  test("an absent field reads 2.9", () => expect(planGameVersion({})).toBe("2.9"));

  test("a blank field reads 2.9; any other value is kept as written", () => {
    expect(planGameVersion({ gameVersion: "" })).toBe(DEFAULT_GAME_VERSION);
    expect(planGameVersion({ gameVersion: "   " })).toBe(DEFAULT_GAME_VERSION);
    expect(planGameVersion({ gameVersion: "2.8.1" })).toBe("2.8.1");
    expect(planGameVersion({ gameVersion: "2.10" })).toBe("2.10");
  });

  test("dataset families", () => {
    expect(gameVersionOfDataset({ gtnhVersion: "2.9.0-RC-2" })).toBe("2.9");
    expect(gameVersionOfDataset({ gtnhVersion: "2.9.0-beta-2" })).toBe("2.9");
    expect(gameVersionOfDataset({ gtnhVersion: "2.9" })).toBe("2.9");
    expect(gameVersionOfDataset({ gtnhVersion: "2.9-rc" })).toBe("2.9");
    expect(gameVersionOfDataset({ gtnhVersion: "2.90" })).toBe("2.90");
    expect(gameVersionOfDataset({ gtnhVersion: "2.8.1" })).toBe("2.8.1");
    expect(gameVersionOfDataset({ gtnhVersion: "2.8.4" })).toBe("2.8.4");
  });

  test("the label", () => expect(gameVersionLabel("2.8.1")).toBe("GTNH 2.8.1"));
});
