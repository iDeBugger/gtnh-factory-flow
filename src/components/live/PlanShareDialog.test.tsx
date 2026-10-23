// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommunityAuthStore } from "@/store/community-auth-store";
import { useDesignStore } from "@/store/design-store";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

vi.mock("@/lib/library/cloud-library", () => ({
  fetchPlanMembers: vi.fn(async () => ({ ownerId: "me", ownerName: "ann_smith", role: "owner", members: [] })),
  addPlanMember: vi.fn(),
  removePlanMember: vi.fn(),
  searchAccounts: vi.fn(async () => []),
}));
vi.mock("@/lib/library/library-sync", () => ({ syncLibraryNow: vi.fn() }));

import { PlanShareDialog } from "./PlanShareDialog";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  useCommunityAuthStore.setState({ user: { username: "ann_smith" }, hasHydrated: true });
  useDesignStore.setState({
    designs: [
      {
        id: "d1",
        name: "Benzene",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        remoteUpdatedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    activeDesignId: "d1",
  });
});
afterEach(() => {
  cleanup();
  useCommunityAuthStore.setState({ user: undefined });
});

async function renderDialog() {
  render(<PlanShareDialog onClose={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  await screen.findByText(/Everyone here can edit the plan with you, live\./);
}

describe("the share-with-people dialog with the community on", () => {
  withModAndCommunityOn();

  it("says posting a copy to Community is separate", async () => {
    await renderDialog();
    expect(screen.getByText(/Everyone here can edit the plan with you, live\./).textContent).toBe(
      "Everyone here can edit the plan with you, live. Posting a copy to Community is separate.",
    );
  });
});

describe("the share-with-people dialog with the community switched off (unset)", () => {
  withModAndCommunityUnset();

  it("has no community line", async () => {
    await renderDialog();
    expect(screen.getByText(/Everyone here can edit the plan with you, live\./).textContent).toBe(
      "Everyone here can edit the plan with you, live.",
    );
    expect(document.body.textContent).not.toContain("Community");
  });
});
