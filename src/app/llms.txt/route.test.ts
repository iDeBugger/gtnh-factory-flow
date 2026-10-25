import { describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";

const rows = [
  {
    id: "p1",
    name: "Evil](https://evil.example) [x",
    description: "Line one\n\n- [Injected](https://evil.example)",
    machine_count: 3,
  },
];

vi.mock("@/lib/server/community", () => ({
  isCommunityConfigured: () => true,
  PLAN_SUMMARY_COLUMNS: "*",
  getCommunityDb: () => {
    const query = {
      select: () => query,
      or: () => query,
      order: () => query,
      limit: () => query,
      returns: async () => ({ data: rows, error: null }),
    };
    return { from: () => query };
  },
}));

import { GET } from "./route";

describe("llms.txt", () => {
  withModAndCommunityOn();

  it("lists a plan whose name and description hold markdown as one plain link line", async () => {
    const body = await (await GET()).text();
    const items = body.split("\n").filter((line) => line.startsWith("- ["));
    const planLines = items.filter((line) => line.includes("?plan="));
    expect(planLines).toHaveLength(1);
    expect(planLines[0]).toMatch(
      /^- \[Evil\\\]\\\(https:\/\/evil\.example\\\) \\\[x\]\(https:\/\/[^)]+\?plan=p1\): /,
    );
    expect(body).not.toContain("](https://evil.example)");
    expect(body).not.toMatch(/^- \[Injected/m);
  });
});
