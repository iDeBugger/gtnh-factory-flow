// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { BoardHelp } from "./BoardHelp";

afterEach(cleanup);

it.each([false, true])("survives viewport layout changes starting with compact=%s", (compact) => {
  const view = render(<BoardHelp compact={compact} />);
  view.rerender(<BoardHelp compact={!compact} />);
  expect(view.getByRole("button", { name: "Show board help" })).toBeDefined();
  view.rerender(<BoardHelp compact={compact} />);
  expect(view.getByRole("button", { name: "Show board help" })).toBeDefined();
});

describe("the Plans card", () => {
  const openSheet = () => {
    const view = render(<BoardHelp compact />);
    fireEvent.click(view.getByRole("button", { name: "Show board help" }));
    return view;
  };

  describe("with the community library switched on", () => {
    withModAndCommunityOn();

    it("points to the community setups", () => {
      expect(openSheet().baseElement.textContent).toContain("Community setups");
    });
  });

  describe("with the setting unset", () => {
    withModAndCommunityUnset();

    it("has no community setups, saved or posted", () => {
      const text = openSheet().baseElement.textContent ?? "";
      expect(text).toContain("Board help");
      expect(text).toContain("Your plans, in folders");
      expect(text).not.toMatch(/community/i);
      expect(text).not.toMatch(/posted/i);
    });
  });
});
