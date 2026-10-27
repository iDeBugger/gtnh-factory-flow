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
  getPublicPlanRow: async () => ({ id: "p1", name: "Steel line", game_version: "2.9" }),
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

async function cardWords(): Promise<string> {
  rendered.tree = undefined;
  await GET(new Request("http://localhost/api/community/plans/p1/card"), { params: Promise.resolve({ planId: "p1" }) });
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
});
