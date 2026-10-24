// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import { searchAccounts } from "@/lib/library/cloud-library";
import { PlanShareDialog } from "./PlanShareDialog";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.mocked(searchAccounts).mockClear();
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

  it("asks for two letters before it searches, and says so after one", async () => {
    await renderDialog();
    const box = screen.getByLabelText("Add someone");
    fireEvent.change(box, { target: { value: "b" } });
    expect(screen.getByText("Type two letters at least.")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(searchAccounts).not.toHaveBeenCalled();
    expect(screen.queryByText("No one by that name.")).toBeNull();
    fireEvent.change(box, { target: { value: "bo" } });
    expect(screen.queryByText("Type two letters at least.")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(searchAccounts).toHaveBeenCalledWith("bo", expect.anything());
    expect(screen.getByText("No one by that name.")).toBeTruthy();
  });
});
