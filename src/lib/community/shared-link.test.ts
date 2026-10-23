// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

/**
 * A `?plan=` arrival. The id is captured as the module loads, so each case
 * sets the address and loads the modules afresh, as a page load would.
 */
async function arriveOn(search: string) {
  window.history.replaceState(null, "", `/${search}`);
  vi.resetModules();
  const link = await import("./shared-link");
  const welcome = await import("@/lib/welcome/welcome-tab");
  const { SharedAddressSync } = await import("@/components/SharedAddressSync");
  return { link, welcome, SharedAddressSync };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("a ?plan= link with the community library switched on", () => {
  withModAndCommunityOn();

  it("names the post to open, and the visit skips Welcome", async () => {
    const { link, welcome } = await arriveOn("?plan=x");
    expect(link.readSharedPlanId()).toBe("x");
    expect(welcome.readWelcomeTabState().active).toBe(false);
  });
});

describe("a ?plan= link with the setting unset", () => {
  withModAndCommunityUnset();

  it("opens nothing: no post is named, and the visit greets like any other", async () => {
    const { link, welcome } = await arriveOn("?plan=x");
    expect(link.readSharedPlanId()).toBeUndefined();
    expect(welcome.readWelcomeTabState().active).toBe(true);
  });

  it("leaves the address once the app is up, and a linked design never advertises its post", async () => {
    const { SharedAddressSync } = await arriveOn("?plan=x");
    const { useFactoryStore } = await import("@/store/factory-store");
    const project = useFactoryStore.getState().project;
    useFactoryStore.setState({ project: { ...project, metadata: { ...project.metadata, communityPlanId: "post-1" } } });
    render(createElement(SharedAddressSync));
    expect(window.location.search).toBe("");
  });
});
