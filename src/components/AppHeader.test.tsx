// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestShareDialog } from "@/lib/setups-tab";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

// The bar and the post dialog have their own tests; here only whether the header mounts them.
vi.mock("./chrome/ModBar", () => ({ ModBar: () => <header data-testid="bar" /> }));
vi.mock("./community/SharePlanDialog", () => ({ SharePlanDialog: () => <div data-testid="post-dialog" /> }));

import { AppHeader } from "./AppHeader";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHeaderAndWait() {
  render(<AppHeader onLoadDatasetVersion={vi.fn()} />);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
}

describe("the app header with the mod and the community on", () => {
  withModAndCommunityOn();

  it("opens the mod announcement once, and mounts the post dialog when asked", () => {
    renderHeaderAndWait();
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => requestShareDialog("save"));
    expect(screen.getByTestId("post-dialog")).toBeTruthy();
  });
});

describe("the app header with the mod and the community switched off (unset)", () => {
  withModAndCommunityUnset();

  it("never opens the mod announcement, and never mounts the post dialog", () => {
    renderHeaderAndWait();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => requestShareDialog("save"));
    expect(screen.queryByTestId("post-dialog")).toBeNull();
    expect(screen.getByTestId("bar")).toBeTruthy();
  });
});
