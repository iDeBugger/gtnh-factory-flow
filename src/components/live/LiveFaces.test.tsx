// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LivePerson } from "@/lib/live/protocol";
import { useLiveSession } from "@/store/live-session";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { LiveFaces, liveFaceName } from "./LiveFaces";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const fromGame: LivePerson = { id: "u1", username: "ann_smith", color: "#3b82f6", client: "game", conn: "c1" };
const fromWeb: LivePerson = { id: "u2", username: "bob", color: "#ef4444", client: "web", conn: "c2" };

function renderFaces() {
  useLiveSession.setState({ status: "live", present: [fromGame, fromWeb] });
  return render(<LiveFaces />);
}
const titles = () => [...document.querySelectorAll("[data-live-faces] [title]")].map((face) => face.getAttribute("title"));

afterEach(() => {
  cleanup();
  useLiveSession.setState({ status: "off", present: [] });
});

describe("live faces with the mod on", () => {
  withModAndCommunityOn();

  it("a face from the game says so", () => {
    renderFaces();
    expect(titles()).toEqual(["ann_smith (in game)", "bob"]);
    expect(liveFaceName(fromGame)).toBe("ann_smith (in game)");
  });
});

describe("live faces with the mod switched off (unset)", () => {
  withModAndCommunityUnset();

  it("no face says (in game)", () => {
    renderFaces();
    expect(titles()).toEqual(["ann_smith", "bob"]);
    expect(liveFaceName(fromGame)).toBe("ann_smith");
    expect(document.body.textContent).not.toContain("in game");
  });
});
