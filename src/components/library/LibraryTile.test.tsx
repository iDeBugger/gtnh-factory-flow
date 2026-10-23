// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { LibraryTile } from "./LibraryTile";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());

function renderTile(extra: Partial<Parameters<typeof LibraryTile>[0]> = {}) {
  return render(<LibraryTile name="Benzene" when="2d ago" onOpen={vi.fn()} onMenu={vi.fn()} {...extra} />);
}

describe("a library tile with the community on", () => {
  withModAndCommunityOn();

  it("a plan not posted has the dim globe that posts it", () => {
    renderTile({ onPost: vi.fn() });
    expect(screen.getByLabelText("Post to Community")).toBeTruthy();
  });

  it("a posted plan wears the globe", () => {
    renderTile({ marks: { posted: true, privatePost: true } });
    expect(screen.getByLabelText("Posted, private")).toBeTruthy();
  });
});

describe("a library tile with the community switched off (unset)", () => {
  withModAndCommunityUnset();

  it("no Post to Community, and no post marks", () => {
    renderTile({ onPost: vi.fn() });
    expect(screen.queryByLabelText("Post to Community")).toBeNull();
    cleanup();
    renderTile({ marks: { posted: true, privatePost: true }, onCopyLink: vi.fn() });
    expect(screen.queryByLabelText("Posted, private")).toBeNull();
    expect(screen.queryByLabelText("Private: only you can see it")).toBeNull();
    expect(screen.queryByLabelText("Copy link")).toBeNull();
    cleanup();
    renderTile({ marks: { fromNetwork: true } });
    expect(screen.queryByLabelText("Opened from a shared setup")).toBeNull();
    cleanup();
    renderTile({ marks: { linked: true } });
    expect(screen.queryByLabelText("Linked to a post")).toBeNull();
  });
});
