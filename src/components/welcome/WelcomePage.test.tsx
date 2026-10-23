// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

const community = vi.hoisted(() => ({
  listCommunityPlans: vi.fn(async () => ({
    plans: [{ id: "post-1", name: "Shared benzene", authorName: "sam", score: 3 }],
    total: 1,
  })),
}));
vi.mock("@/lib/community/client", () => community);
vi.mock("./WelcomeBackdrop", () => ({ WelcomeBackdrop: () => null }));

import { WelcomePage } from "./WelcomePage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.localStorage.clear();
  community.listCommunityPlans.mockClear();
});
afterEach(() => cleanup());

async function renderPage() {
  const view = render(<WelcomePage />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

describe("Welcome with the community library switched on", () => {
  withModAndCommunityOn();

  it("offers the shared setups and shows the newest", async () => {
    await renderPage();
    expect(screen.getByText("Browse shared setups")).toBeTruthy();
    expect(screen.getByText("New from the community")).toBeTruthy();
    expect(community.listCommunityPlans).toHaveBeenCalled();
  });
});

describe("Welcome with the setting unset", () => {
  withModAndCommunityUnset();

  it("has no shared setups and never asks for them", async () => {
    await renderPage();
    expect(screen.queryByText("Browse shared setups")).toBeNull();
    expect(screen.queryByText("New from the community")).toBeNull();
    expect(document.body.textContent).not.toMatch(/community|shared setup/i);
    expect(community.listCommunityPlans).not.toHaveBeenCalled();
    // The rest of the page is as before.
    expect(screen.getByText("New design")).toBeTruthy();
    expect(screen.getByText("Your plans")).toBeTruthy();
  });
});
