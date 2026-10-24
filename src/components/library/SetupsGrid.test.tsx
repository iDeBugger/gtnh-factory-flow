// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false, useIsCompactViewport: () => false }));
vi.mock("@/components/community/auth", () => ({
  useCommunityUser: () => ({ user: undefined, isLoading: false, setUser: vi.fn(), signOut: vi.fn() }),
}));
const community = vi.hoisted(() => ({
  listCommunityPlans: vi.fn(async () => ({
    plans: [
      {
        id: "post-1",
        name: "Benzene",
        description: "",
        isPublic: true,
        tags: [],
        needs: [],
        outputs: [],
        totalEuT: 0,
        machineCount: 1,
        nodeCount: 1,
        storageCount: 0,
        edgeCount: 0,
        upvotes: 0,
        downvotes: 0,
        score: 0,
        downloads: 0,
        views: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        commentCount: 0,
      },
    ],
    total: 1,
  })),
  getCommunityPlan: vi.fn(async () => undefined),
  countPlanView: vi.fn(),
  listPlanComments: vi.fn(async () => []),
}));
vi.mock("@/lib/community/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community/client")>()),
  ...community,
}));

import { SetupsGrid } from "./SetupsGrid";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  for (const fn of Object.values(community)) fn.mockClear();
});
afterEach(() => cleanup());

describe("the setups grid", () => {
  withModAndCommunityOn();

  it("counts a view once when a post's page opens, and never on a lookup", async () => {
    render(<SetupsGrid scope="network" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(community.countPlanView).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("Benzene"));
    expect(community.countPlanView).toHaveBeenCalledTimes(1);
    expect(community.countPlanView).toHaveBeenCalledWith("post-1");
    // The post's page is up, and its stat refresh is a lookup.
    expect(community.getCommunityPlan).toHaveBeenCalledWith("post-1");
  });
});
