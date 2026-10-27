import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";

// The card's element tree, as handed to the renderer: the words on it are what a chat shows.
const rendered = vi.hoisted(() => ({ tree: undefined as unknown }));
vi.mock("@vercel/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown) {
      rendered.tree = tree;
    }
  },
}));
vi.mock("@/lib/server/services/plan-preview", () => ({
  getPublicPlanRow: async (planId: string) =>
    planId === "p1" ? { id: "p1", name: "Steel line", game_version: "2.9" } : undefined,
  getPlanPreviewPng: async () => undefined,
  sizePlanPreview: () => undefined,
}));

const { GET } = await import("./route");

function words(node: unknown): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(words);
  if (isValidElement(node)) return words((node.props as { children?: ReactNode }).children);
  return [];
}

const ctx = (planId: string) => ({ params: Promise.resolve({ planId }) });

async function cardWords(): Promise<string> {
  rendered.tree = undefined;
  await GET(new Request("http://localhost/api/community/plans/p1/card"), ctx("p1"));
  return words(rendered.tree).join(" ");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the community share card", () => {
  withModAndCommunityOn();

  it("prints the site's own host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net");
    const text = await cardWords();
    expect(text).toContain("Steel line");
    expect(text).toContain("stage.gtnhplanner.idebugger.net");
    expect(text).not.toContain("gtnhplanner.com");
  });

  it("prints no address when the site's URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    const text = await cardWords();
    expect(text).toMatch(/GTNH\s+2\.9/);
    expect(text).not.toMatch(/gtnhplanner|localhost/);
  });

  it("sends a missing plan to the site's own generic card, on the site's own origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://gtnhplanner.com");
    const answer = await GET(new Request("http://0.0.0.0:3000/api/community/plans/x/card"), ctx("x"));
    expect([answer.status, answer.headers.get("location")]).toEqual([
      302,
      "https://gtnhplanner.com/opengraph-image.png",
    ]);
  });
});
