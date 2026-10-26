import { describe, expect, expectTypeOf, it } from "vitest";
import type { PlanRow } from "../community-rows";
import { publicPlansByScore, type PlanLinkRow } from "./community-plans";

/**
 * The by-score read takes a named column list, never a free string: rows
 * typed `PlanRow` from a shorter list would read as undefined fields at run
 * time. Checked by `npm run typecheck`; the bodies never run.
 */
describe("publicPlansByScore's column lists", () => {
  it("names each list and types its rows", () => {
    const typed = () => {
      expectTypeOf(publicPlansByScore(10, "summary")).resolves.toEqualTypeOf<PlanRow[]>();
      expectTypeOf(publicPlansByScore(10, "links")).resolves.toEqualTypeOf<PlanLinkRow[]>();
      // @ts-expect-error an arbitrary column list is not one of the names
      void publicPlansByScore(10, "id,name");
    };
    expect(typeof typed).toBe("function");
  });
});
