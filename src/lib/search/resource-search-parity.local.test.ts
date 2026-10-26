/**
 * The browser's item search against the server's, on the installed datasets:
 * the engine the search worker runs, over the `items` file exactly as the
 * browser parses it, must answer each request as `/resources` does (total,
 * the first 120 in order, mods, and how the query was read and respelled).
 *
 * Needs public/datasets/gtnh (gitignored), so it is local only:
 *
 *   npx vitest run src/lib/search/resource-search-parity.local.test.ts --config vitest.local.config.ts
 */
import { describe, expect, it } from "vitest";
import { getDatasetResourceSearchFile, queryDatasetResources } from "@/lib/server/dataset-query";
import { createResourceSearchEngine, type ResourceSearchFile } from "./resource-search-engine";
import type { ResourceQuerySort } from "./resource-search";

const VERSIONS = ["local-2.9.0-rc-2", "local-2.8.1"];
// The assessment's set: short walks, trigram narrowing, multi-word, respelling.
const QUERIES = [
  "s",
  "st",
  "ste",
  "steel",
  "steel plate",
  "lv",
  "lv motor",
  "vaccum pump",
  "oaklog",
  "ebf",
  "irom plaet ingto",
];
const SORTS: ResourceQuerySort[] = [
  "relevance",
  "name",
  "mod",
  "recipes",
  "made",
  "uses",
  "popular",
  "nei",
  "nei-filter",
];
const POPULARITY = new Map<string, number>([
  ["item:gregtech:gt.metaitem.01@11305", 50],
  ["fluid:water", 40],
  ["item:minecraft:glass", 30],
]);

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe.each(VERSIONS)("the browser's item search on %s", (versionId) => {
  it("answers the 11 queries as the server does", { timeout: 600_000 }, async () => {
    const file = plain(await getDatasetResourceSearchFile(versionId)) as ResourceSearchFile;
    const engine = createResourceSearchEngine(file);
    for (const query of QUERIES) {
      const request = { query, offset: 0, limit: 120 };
      const server = plain(await queryDatasetResources(versionId, request));
      const browser = plain(engine(request));
      expect(browser.total, query).toBe(server.total);
      expect(
        browser.resources.map((entry: { kind: string; id: string }) => `${entry.kind}:${entry.id}`),
        query,
      ).toEqual(
        server.resources.map((entry: { kind: string; id: string }) => `${entry.kind}:${entry.id}`),
      );
      expect(browser.searchPhase, query).toBe(server.searchPhase);
      expect(browser.corrections, query).toEqual(server.corrections);
      expect(browser, query).toEqual(server);
    }
  });

  it("answers every sort, kind, source, mod and page the same", { timeout: 600_000 }, async () => {
    const file = plain(await getDatasetResourceSearchFile(versionId)) as ResourceSearchFile;
    const engine = createResourceSearchEngine(file);
    for (const query of ["", "st", "steel", "vaccum pump"]) {
      for (const sort of SORTS) {
        for (const extra of [
          {},
          { kind: "fluid" as const },
          { source: "plants" as const },
          { source: "bees" as const },
          { mod: "gregtech" },
        ]) {
          for (const offset of [0, 240]) {
            const request = {
              query,
              offset,
              limit: 120,
              sort,
              ...extra,
              popularity: sort === "popular" ? POPULARITY : undefined,
            };
            const server = plain(await queryDatasetResources(versionId, request));
            expect(
              plain(engine(request)),
              JSON.stringify({ ...request, popularity: undefined }),
            ).toEqual(server);
          }
        }
      }
    }
  });
});
