import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

/**
 * The library across reloads: a reload while on it lands back on it, in the
 * same view; a new visit (fresh sessionStorage) starts off it.
 */

function makeStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

type Storage = ReturnType<typeof makeStorage>;

let local: Storage;
let session: Storage;

function visit(localStorage: Storage, sessionStorage: Storage) {
  (globalThis as { window?: unknown }).window = {
    localStorage,
    sessionStorage,
    location: { search: "" },
  };
  vi.resetModules();
  return import("./library-tab");
}

beforeEach(() => {
  local = makeStorage();
  session = makeStorage();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("library tab", () => {
  withModAndCommunityOn();

  it("starts closed, on everything", async () => {
    const library = await visit(local, session);
    expect(library.readLibraryTabState()).toEqual({ active: false, view: { kind: "all" } });
  });

  it("comes back after a reload, in the same view", async () => {
    const first = await visit(local, session);
    first.openLibrary({ kind: "folder", folderId: "f1" });
    expect((await visit(local, session)).readLibraryTabState()).toEqual({
      active: true,
      view: { kind: "folder", folderId: "f1" },
    });
  });

  it("is off on a new visit", async () => {
    const first = await visit(local, session);
    first.openLibrary({ kind: "public" });
    const later = await visit(local, makeStorage());
    expect(later.readLibraryTabState().active).toBe(false);
  });

  it("steps Welcome down when it opens", async () => {
    const library = await visit(local, session);
    const welcome = await import("@/lib/welcome/welcome-tab");
    welcome.openWelcomeTab();
    library.openLibrary();
    expect(welcome.readWelcomeTabState().active).toBe(false);
    expect(library.readLibraryTabState().active).toBe(true);
  });

  it("keeps the view when opened without one, and leaves cleanly", async () => {
    const library = await visit(local, session);
    library.setLibraryView({ kind: "public" });
    library.openLibrary();
    expect(library.readLibraryTabState().view).toEqual({ kind: "public" });
    library.leaveLibrary();
    expect(library.readLibraryTabState()).toEqual({ active: false, view: { kind: "public" } });
  });
});

describe("library tab with the mod and the community switched off (unset)", () => {
  withModAndCommunityUnset();

  it("the public and saved views open My plans instead", async () => {
    const library = await visit(local, session);
    library.openLibrary({ kind: "public", search: "@someone" });
    expect(library.readLibraryTabState()).toEqual({ active: true, view: { kind: "all" } });
    library.setLibraryView({ kind: "saved" });
    expect(library.readLibraryTabState().view).toEqual({ kind: "all" });
    library.setLibraryView({ kind: "favorites" });
    expect(library.readLibraryTabState().view).toEqual({ kind: "favorites" });
  });

  it("a public view kept from before a reload comes back as My plans", async () => {
    session.setItem("gtnh-factory-flow-library", JSON.stringify({ active: true, view: { kind: "public" } }));
    const library = await visit(local, session);
    expect(library.readLibraryTabState()).toEqual({ active: true, view: { kind: "all" } });
  });
});
