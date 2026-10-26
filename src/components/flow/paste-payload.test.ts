import { beforeEach, describe, expect, test, vi } from "vitest";

const flashNotice = vi.hoisted(() => vi.fn());
vi.mock("./clean/rail/NoticeBar", () => ({ flashNotice }));
vi.mock("@/lib/datasets/convert-payload-version", () => ({
  preparePayloadForPlan: async () => {
    throw new Error("Failed to fetch");
  },
}));

import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { useFactoryStore, type BoardClipboardPayload } from "@/store/factory-store";
import { pastePayloadIntoPlan } from "./paste-payload";

describe("pastePayloadIntoPlan", () => {
  beforeEach(() => {
    flashNotice.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("a failed match pastes nothing and says so", async () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      gameVersion: "2.8.1",
      id: "plan-281",
      name: "plan",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });
    const before = useFactoryStore.getState().project;
    const payload: BoardClipboardPayload = {
      gameVersion: "2.9",
      nodes: [{ id: "n1", recipeId: "r1", machineCount: 1, parallel: 1, overclockTier: "LV", enabled: true, position: { x: 0, y: 0 } }],
      storages: [],
      annotations: [],
      pockets: [],
      edges: [],
      recipes: [],
    };
    expect(await pastePayloadIntoPlan(payload, { x: 0, y: 0 })).toEqual([]);
    expect(flashNotice).toHaveBeenCalledWith("warn", "Couldn't paste those cards. Try again.");
    expect(useFactoryStore.getState().project).toBe(before);
  });
});
