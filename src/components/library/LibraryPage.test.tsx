// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignSummary } from "@/lib/designs/design-library";
import { openLibrary } from "@/lib/library/library-tab";
import { useDesignStore } from "@/store/design-store";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => true, useIsCompactViewport: () => true }));
vi.mock("@/components/community/auth", () => ({
  useCommunityUser: () => ({ user: { username: "alex" }, isLoading: false, setUser: vi.fn(), signOut: vi.fn() }),
}));
const community = vi.hoisted(() => ({
  listCommunityPlans: vi.fn(async () => ({
    plans: [{ id: "post-1", name: "Benzene", isPublic: true, tags: [] }],
    total: 1,
  })),
  deleteCommunityPlan: vi.fn(async () => undefined),
  patchCommunityPlan: vi.fn(async () => undefined),
}));
vi.mock("@/lib/community/client", () => community);
vi.mock("@/components/library/SetupsGrid", () => ({
  SetupsGrid: () => <div data-testid="public-grid">grid</div>,
}));

import { LibraryPage } from "./LibraryPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function design(id: string, name: string, extra: Partial<DesignSummary> = {}): DesignSummary {
  return { id, name, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra };
}

const removeDesign = vi.fn(async () => undefined);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const fn of Object.values(community)) fn.mockClear();
  removeDesign.mockClear();
  useDesignStore.setState({
    designs: [design("a", "Benzene", { communityPlanId: "post-1" }), design("b", "Steel")],
    folders: [],
    activeDesignId: "a",
    removeDesign,
  });
  openLibrary({ kind: "all" });
});
afterEach(() => cleanup());

async function renderPage() {
  const view = render(<LibraryPage />);
  // Lets the posts query (when there is one) land.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

const railOptions = () =>
  [...(screen.getByLabelText("Where in Plans") as HTMLSelectElement).options].map((option) => option.textContent);

async function openTileMenu(name: string) {
  const tile = screen.getAllByText(name)[0]!.closest("[role='button']")!;
  fireEvent.contextMenu(tile);
  await act(async () => undefined);
}

describe("Plans with the community library switched on", () => {
  withModAndCommunityOn();

  it("has the Community and Saved shelves, and a posted plan's link and visibility keys", async () => {
    await renderPage();
    expect(railOptions()).toEqual(expect.arrayContaining(["Community", "Saved (0)"]));
    expect(community.listCommunityPlans).toHaveBeenCalled();
    await openTileMenu("Benzene");
    expect(screen.getByText("Copy link")).toBeTruthy();
    expect(screen.getByText("Make private")).toBeTruthy();
  });

  it("offers to post a plan that is not posted", async () => {
    await renderPage();
    await openTileMenu("Steel");
    expect(screen.getByText("Post as a public setup")).toBeTruthy();
  });
});

describe("Plans with the setting unset", () => {
  withModAndCommunityUnset();

  it("has no Community or Saved shelf", async () => {
    await renderPage();
    const options = railOptions();
    expect(options).not.toContain("Community");
    expect(options.some((option) => option?.startsWith("Saved"))).toBe(false);
    expect(document.body.textContent).not.toMatch(/community/i);
  });

  it("never asks for posts, and a posted plan has no link, visibility key or post", async () => {
    await renderPage();
    expect(community.listCommunityPlans).not.toHaveBeenCalled();
    await openTileMenu("Benzene");
    expect(screen.queryByText("Copy link")).toBeNull();
    expect(screen.queryByText(/Make (private|public)/)).toBeNull();
    expect(screen.queryByText("Post as a public setup")).toBeNull();
    expect(screen.queryByLabelText("Post to Community")).toBeNull();
  });

  it("offers no post for a plan that is not posted", async () => {
    await renderPage();
    await openTileMenu("Steel");
    expect(screen.queryByText("Post as a public setup")).toBeNull();
  });

  it("a public view opens My designs", async () => {
    openLibrary({ kind: "public" });
    await renderPage();
    expect(screen.queryByTestId("public-grid")).toBeNull();
    expect(screen.getAllByText("Steel").length).toBeGreaterThan(0);
  });

  it("deleting a plan that was posted never reaches for the post", async () => {
    await renderPage();
    await openTileMenu("Benzene");
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm delete"));
    await act(async () => undefined);
    expect(community.deleteCommunityPlan).not.toHaveBeenCalled();
    expect(removeDesign).toHaveBeenCalledWith("a");
  });
});
