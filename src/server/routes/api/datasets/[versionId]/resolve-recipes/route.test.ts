import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDatasetRecipeRefs } from "@/lib/server/dataset-query";
import { resetDatasetBudget } from "@/lib/server/limits/dataset-rate";
import { countedBody } from "@/test-support/request-bodies";
import { POST } from "./route";

vi.mock("@/lib/server/dataset-query", () => ({
  resolveDatasetRecipeRefs: vi.fn(async () => []),
}));

const context = { params: Promise.resolve({ versionId: "stable" }) };
const MIB = 1024 * 1024;

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/datasets/stable/resolve-recipes", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    context,
  );
}

const ref = {
  id: "imported-1",
  name: "Steel Ingot",
  machineType: "Electric Blast Furnace",
  recipeMap: "Blast Furnace",
  inputs: [
    { kind: "item", id: "gregtech:dust_iron", amount: 1 },
    { kind: "item", id: "gregtech:circuit", amount: 0, consumed: false },
  ],
  outputs: [{ kind: "item", id: "gregtech:ingot_steel", amount: 1, chance: 0.5 }],
  durationTicks: 200,
  eut: 120,
};

describe("the recipe resolution route", () => {
  beforeEach(() => {
    resetDatasetBudget();
    vi.mocked(resolveDatasetRecipeRefs).mockClear();
  });

  it("refuses a declared content-length over the cap without reading", async () => {
    const { body, counts } = countedBody(new Uint8Array(MIB).fill(0x20), 64);
    const response = await POST(
      new Request("http://localhost/api/datasets/stable/resolve-recipes", {
        method: "POST",
        headers: { "content-length": String(64 * MIB), "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      context,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "The request is too big." });
    expect(counts.pulls).toBe(0);
    expect(resolveDatasetRecipeRefs).not.toHaveBeenCalled();
  });

  it("stops a chunked body at the cap", async () => {
    const { body, counts } = countedBody(new Uint8Array(MIB).fill(0x20), 64);
    const response = await POST(
      new Request("http://localhost/api/datasets/stable/resolve-recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      context,
    );
    expect(response.status).toBe(413);
    // Two megabytes and the chunk past them, not the whole 64.
    expect(counts.pulls).toBeLessThan(4);
    expect(resolveDatasetRecipeRefs).not.toHaveBeenCalled();
  });

  it("refuses more than 2000 refs", async () => {
    const recipes = Array.from({ length: 2001 }, (_, i) => ({ ...ref, id: `imported-${i}` }));
    const response = await post({ recipes });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Too many recipes in one request. The limit is 2000.",
    });
    expect(resolveDatasetRecipeRefs).not.toHaveBeenCalled();
  });

  it("answers 400, not 500, for a ref without outputs", async () => {
    const response = await post({ recipes: [{ id: "a" }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A recipe reference is not valid." });
    expect((await post({ recipes: [{ ...ref, id: 7 }] })).status).toBe(400);
    expect((await post({ recipes: "nope" })).status).toBe(400);
    expect(resolveDatasetRecipeRefs).not.toHaveBeenCalled();

    const unreadable = await POST(
      new Request("http://localhost/api/datasets/stable/resolve-recipes", {
        method: "POST",
        body: "{not json",
      }),
      context,
    );
    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toEqual({ error: "The request could not be read." });
  });

  it("passes well-formed refs through unchanged", async () => {
    const response = await post({ recipes: [ref] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matches: [] });
    expect(resolveDatasetRecipeRefs).toHaveBeenCalledTimes(1);
    // The very array that came in, with the fields the matcher reads and the schema does not name.
    expect(vi.mocked(resolveDatasetRecipeRefs).mock.calls[0]![1]).toEqual([ref]);

    expect((await post({})).status).toBe(200);
    expect(vi.mocked(resolveDatasetRecipeRefs).mock.calls[1]![1]).toEqual([]);
  });
});
