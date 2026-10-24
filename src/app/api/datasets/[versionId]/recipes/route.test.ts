import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryDatasetRecipes } from "@/lib/server/dataset-query";
import { resetDatasetBudget } from "@/lib/server/dataset-rate";
import { GET } from "./route";

vi.mock("@/lib/server/dataset-query", () => ({
  queryDatasetRecipes: vi.fn(async () => ({
    recipes: [],
    total: 0,
    recipeMaps: [],
    recipeMapIcons: {},
    offset: 0,
    limit: 48,
    hasMore: false,
  })),
}));

describe("recipe dataset API route", () => {
  beforeEach(() => {
    resetDatasetBudget();
    vi.mocked(queryDatasetRecipes).mockClear();
  });

  it("accepts aspect resources for recipe lookups", async () => {
    await GET(
      new Request(
        "http://localhost/api/datasets/stable/recipes?resourceKind=aspect&resourceId=thaumcraft%3Aaspect%3Aaer&mode=recipes",
      ),
      { params: Promise.resolve({ versionId: "stable" }) },
    );

    expect(queryDatasetRecipes).toHaveBeenCalledWith(
      "stable",
      expect.objectContaining({
        resource: { kind: "aspect", id: "thaumcraft:aspect:aer" },
        mode: "recipes",
      }),
    );
  });

  it("parses stencil clauses, side operators and the all-maps flag", async () => {
    await GET(
      new Request(
        "http://localhost/api/datasets/stable/recipes?" +
          "clause=takes%3Aitem%3Agregtech%3Adust_iron&" +
          "clause=takes%3Aitem%3Agregtech%3Adust_coal&" +
          "clause=makes%3Aitem%3Agregtech%3Aingot_steel&" +
          "takesOp=all&allMaps=1",
      ),
      { params: Promise.resolve({ versionId: "stable" }) },
    );

    expect(queryDatasetRecipes).toHaveBeenCalledWith(
      "stable",
      expect.objectContaining({
        clauses: [
          { role: "takes", kind: "item", id: "gregtech:dust_iron" },
          { role: "takes", kind: "item", id: "gregtech:dust_coal" },
          { role: "makes", kind: "item", id: "gregtech:ingot_steel" },
        ],
        takesOp: "all",
        makesOp: "any",
        allMaps: true,
        mapSelection: undefined,
      }),
    );
  });

  it("parses the machine chips' map selection", async () => {
    await GET(
      new Request(
        "http://localhost/api/datasets/stable/recipes?allMaps=1&mapMode=exclude&" +
          "map=Shaped%20Crafting&map=Assembler",
      ),
      { params: Promise.resolve({ versionId: "stable" }) },
    );

    expect(queryDatasetRecipes).toHaveBeenCalledWith(
      "stable",
      expect.objectContaining({
        allMaps: true,
        mapSelection: { mode: "exclude", maps: ["Shaped Crafting", "Assembler"] },
      }),
    );

    // An empty include list is a real state: nothing selected.
    await GET(
      new Request("http://localhost/api/datasets/stable/recipes?allMaps=1&mapMode=include"),
      {
        params: Promise.resolve({ versionId: "stable" }),
      },
    );

    expect(queryDatasetRecipes).toHaveBeenLastCalledWith(
      "stable",
      expect.objectContaining({ mapSelection: { mode: "include", maps: [] } }),
    );
  });

  it("drops malformed clauses rather than failing the request", async () => {
    await GET(
      new Request(
        "http://localhost/api/datasets/stable/recipes?" +
          "clause=eats%3Aitem%3Anope&clause=takes%3Adragon%3Anope&clause=broken&" +
          "clause=makes%3Afluid%3Aoxygen&makesOp=only",
      ),
      { params: Promise.resolve({ versionId: "stable" }) },
    );

    expect(queryDatasetRecipes).toHaveBeenCalledWith(
      "stable",
      expect.objectContaining({
        clauses: [{ role: "makes", kind: "fluid", id: "oxygen" }],
        makesOp: "only",
        allMaps: false,
      }),
    );
  });

  it("answers 429 with Retry-After once an address has spent its minute", async () => {
    // A two-letter query cannot be narrowed by the index, so it costs ten units
    // of the 1200 an address gets a minute: 120 pass, the 121st waits.
    const send = () =>
      GET(
        new Request("http://localhost/api/datasets/stable/recipes?query=zz", {
          headers: { "x-client-ip": "203.0.113.9" },
        }),
        { params: Promise.resolve({ versionId: "stable" }) },
      );
    for (let call = 0; call < 120; call += 1) {
      expect((await send()).status).toBe(200);
    }

    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("10");
    await expect(refused.json()).resolves.toEqual({
      error: "Too many requests. Wait a moment and try again.",
    });
    expect(queryDatasetRecipes).toHaveBeenCalledTimes(120);

    // Another address is not held up by it.
    const other = await GET(
      new Request("http://localhost/api/datasets/stable/recipes?query=zz", {
        headers: { "x-client-ip": "203.0.113.10" },
      }),
      { params: Promise.resolve({ versionId: "stable" }) },
    );
    expect(other.status).toBe(200);
  });

  it("a narrowed query costs one unit", async () => {
    for (let call = 0; call < 200; call += 1) {
      const response = await GET(
        new Request("http://localhost/api/datasets/stable/recipes?query=iron", {
          headers: { "x-client-ip": "203.0.113.9" },
        }),
        { params: Promise.resolve({ versionId: "stable" }) },
      );
      expect(response.status).toBe(200);
    }
  });
});
