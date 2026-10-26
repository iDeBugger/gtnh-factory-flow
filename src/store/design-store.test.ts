import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesignFolder,
  DesignRecord,
  DesignSummary,
} from "@/lib/designs/design-library";

const storage = vi.hoisted(() => ({
  listDesignSummaries: vi.fn<() => Promise<DesignSummary[]>>(),
  listDesignFolders: vi.fn<() => Promise<DesignFolder[]>>(async () => []),
  readDesign: vi.fn<(id: string) => Promise<DesignRecord | undefined>>(),
  readDesignSummary: vi.fn<(id: string) => Promise<DesignSummary | undefined>>(),
  writeDesignIfUnchanged: vi.fn<
    (record: DesignRecord, expectedUpdatedAt: string | undefined) => Promise<"written" | "conflict">
  >(),
  writeDesign: vi.fn<(record: DesignRecord) => Promise<void>>(async () => undefined),
  writeDesignSummary: vi.fn<(summary: DesignSummary) => Promise<void>>(async () => undefined),
  writeDesignFolder: vi.fn<(folder: DesignFolder) => Promise<void>>(async () => undefined),
  deleteDesign: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  deleteDesignFolder: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  readActiveDesignId: vi.fn<() => string | undefined>(),
  writeActiveDesignId: vi.fn<(id: string | undefined) => void>(),
}));

vi.mock("@/lib/designs/design-storage", () => storage);

/** Another browser tab, as far as this one can tell: the focus it has, and the saves it hears. */
const tabs = vi.hoisted(() => ({
  editing: true,
  announced: [] as Array<{ designId: string; updatedAt: string }>,
  heard: undefined as ((message: { designId: string; updatedAt: string }) => void) | undefined,
}));
vi.mock("@/lib/designs/design-tab-sync", () => ({
  THIS_TAB_ID: "this-tab",
  isEditingInThisTab: () => tabs.editing,
  announceDesignSaved: (designId: string, updatedAt: string) => {
    tabs.announced.push({ designId, updatedAt });
  },
  subscribeDesignSaved: (handler: (message: { designId: string; updatedAt: string }) => void) => {
    tabs.heard = handler;
    return () => {
      tabs.heard = undefined;
    };
  },
}));
vi.mock("@/lib/designs/design-camera", () => ({
  keepDesignCameras: vi.fn(),
  forgetDesignCameras: vi.fn(),
  rememberDesignCamera: vi.fn(),
  readDesignCamera: vi.fn(),
  beginDesignCameraHandover: vi.fn(),
  beginDesignHandover: vi.fn(),
  endDesignHandover: vi.fn(),
}));

import { readLibraryTabState } from "@/lib/library/library-tab";
import { toDesignSummary } from "@/lib/designs/design-library";
import { planGameVersion } from "@/lib/model/game-version";
import { createEmptyProject, createNewProject } from "@/examples";
import { useDesignStore } from "./design-store";
import { useFactoryStore } from "./factory-store";
import { copyViewedPost } from "@/lib/community/open-post";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { resetNewPlanVersionForTests, writeNewPlanVersion } from "@/lib/datasets/new-plan-version";
import type { DatasetManifest } from "@/lib/datasets/types";

function summary(id: string, extra: Partial<DesignSummary> = {}): DesignSummary {
  return {
    id,
    name: `Design ${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    order: 0,
    ...extra,
  };
}

/** The mock library: summaries answer the list, records answer reads. */
function library(...designs: DesignSummary[]) {
  const current = new Map(designs.map((design) => [design.id, design]));
  storage.listDesignSummaries.mockImplementation(async () => [...current.values()]);
  storage.readDesign.mockImplementation(async (id: string) => {
    const design = current.get(id);
    return design ? { ...design, project: createEmptyProject() } : undefined;
  });
  storage.writeDesignSummary.mockImplementation(async (design: DesignSummary) => {
    current.set(design.id, design);
  });
  storage.writeDesign.mockImplementation(async (record: DesignRecord) => {
    const rest: Partial<DesignRecord> = { ...record };
    delete rest.project;
    current.set(record.id, rest as DesignSummary);
  });
  storage.deleteDesign.mockImplementation(async (id: string) => {
    current.delete(id);
  });
  storage.readDesignSummary.mockImplementation(async (id: string) => current.get(id));
  storage.writeDesignIfUnchanged.mockImplementation(async (record, expectedUpdatedAt) => {
    const stored = current.get(record.id);
    if (stored && expectedUpdatedAt !== undefined && stored.updatedAt !== expectedUpdatedAt) {
      return "conflict";
    }
    await storage.writeDesign(record);
    return "written";
  });
  return current;
}

beforeEach(() => {
  useDesignStore.setState({
    designs: [],
    folders: [],
    activeDesignId: undefined,
    isHydrated: false,
    error: undefined,
  });
  vi.clearAllMocks();
  storage.listDesignFolders.mockResolvedValue([]);
  tabs.editing = true;
  tabs.announced = [];
  storage.readDesignSummary.mockResolvedValue(undefined);
  storage.writeDesignIfUnchanged.mockImplementation(async (record) => {
    await storage.writeDesign(record);
    return "written";
  });
});

describe("opening the design library", () => {
  beforeEach(() => {
    storage.listDesignSummaries.mockResolvedValue([summary("a"), summary("b")]);
    storage.readActiveDesignId.mockReturnValue("a");
  });

  it("still lists every tab when the remembered design cannot be opened", async () => {
    // Issue #45: a plan saved by an older version that trips a load-time
    // migration used to take the whole strip down with it - the player saw
    // every design gone, though nothing but that one plan was at fault.
    storage.readDesign.mockRejectedValue(new TypeError("Cannot read properties of undefined"));

    await useDesignStore.getState().hydrate();

    const state = useDesignStore.getState();
    expect(state.isHydrated).toBe(true);
    expect(state.designs.map((design) => design.id)).toEqual(["a", "b"]);
    expect(state.activeDesignId).toBeUndefined();
    expect(state.error).toContain("Cannot read");
  });

  it("never makes an unreadable design active over an empty canvas", async () => {
    // With the record active and nothing on the canvas, the next autosave
    // wrote the empty canvas over the plan. Listed, yes; active, never.
    storage.readDesign.mockResolvedValue(undefined);

    await useDesignStore.getState().hydrate();

    const state = useDesignStore.getState();
    expect(state.designs).toHaveLength(2);
    expect(state.activeDesignId).toBeUndefined();
    expect(storage.writeActiveDesignId).not.toHaveBeenCalledWith("a");
    expect(storage.writeDesign).not.toHaveBeenCalled();
  });

  it("lands on the shelf when every design is closed", async () => {
    library(summary("a", { closed: true }), summary("b", { closed: true }));
    storage.readActiveDesignId.mockReturnValue(undefined);

    await useDesignStore.getState().hydrate();

    const state = useDesignStore.getState();
    expect(state.activeDesignId).toBeUndefined();
    expect(state.designs).toHaveLength(2);
    expect(readLibraryTabState().active).toBe(true);
  });

  it("opens the first open design when the remembered one is gone", async () => {
    library(summary("a", { closed: true }), summary("b"));
    storage.readActiveDesignId.mockReturnValue("gone");

    await useDesignStore.getState().hydrate();

    expect(useDesignStore.getState().activeDesignId).toBe("b");
  });
});

describe("closing tabs", () => {
  it("keeps the design and moves to the neighbour on the left", async () => {
    const records = library(summary("a"), summary("b"), summary("c"));
    storage.readActiveDesignId.mockReturnValue("b");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().closeDesign("b");

    const state = useDesignStore.getState();
    expect(state.activeDesignId).toBe("a");
    expect(records.get("b")?.closed).toBe(true);
    expect(storage.deleteDesign).not.toHaveBeenCalled();
    expect(state.designs.map((design) => design.id)).toEqual(["a", "b", "c"]);
  });

  it("lands on the shelf when the last open tab closes", async () => {
    library(summary("a"), summary("b", { closed: true }));
    storage.readActiveDesignId.mockReturnValue("a");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().closeDesign("a");

    expect(useDesignStore.getState().activeDesignId).toBeUndefined();
    expect(readLibraryTabState().active).toBe(true);
    expect(storage.deleteDesign).not.toHaveBeenCalled();
  });

  it("reopens a closed design when it is switched to", async () => {
    const records = library(summary("a"), summary("b", { closed: true }));
    storage.readActiveDesignId.mockReturnValue("a");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().switchToDesign("b");

    expect(useDesignStore.getState().activeDesignId).toBe("b");
    expect(records.get("b")?.closed).toBeUndefined();
    expect(readLibraryTabState().active).toBe(false);
  });

  it("closes a run of tabs and keeps the one the menu came from", async () => {
    const records = library(summary("a"), summary("b"), summary("c"));
    storage.readActiveDesignId.mockReturnValue("c");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().closeDesigns(["a", "b", "c"], "a");

    expect(useDesignStore.getState().activeDesignId).toBe("a");
    expect(records.get("a")?.closed).toBeUndefined();
    expect(records.get("b")?.closed).toBe(true);
    expect(records.get("c")?.closed).toBe(true);
  });
});

describe("folders", () => {
  it("files and unfiles a design", async () => {
    const records = library(summary("a"));
    storage.readActiveDesignId.mockReturnValue("a");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().moveDesignToFolder("a", "f1");
    expect(records.get("a")?.folderId).toBe("f1");
    expect(useDesignStore.getState().designs[0].folderId).toBe("f1");

    await useDesignStore.getState().moveDesignToFolder("a", undefined);
    expect(records.get("a")?.folderId).toBeUndefined();
  });

  it("deleting a folder unfiles its designs and loses none", async () => {
    const records = library(summary("a", { folderId: "f1" }), summary("b", { folderId: "f2" }));
    storage.readActiveDesignId.mockReturnValue("a");
    storage.listDesignFolders.mockResolvedValue([
      { id: "f1", name: "Oil", createdAt: "2026-08-01" },
      { id: "f2", name: "Bees", createdAt: "2026-08-01" },
    ]);
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().deleteFolder("f1");

    const state = useDesignStore.getState();
    expect(state.folders.map((folder) => folder.id)).toEqual(["f2"]);
    expect(records.get("a")?.folderId).toBeUndefined();
    expect(records.get("b")?.folderId).toBe("f2");
    expect(state.designs).toHaveLength(2);
    expect(storage.deleteDesignFolder).toHaveBeenCalledWith("f1");
  });
});

describe("closing a blank tab", () => {
  it("throws away an untouched Untitled design instead of keeping it", async () => {
    const records = library(
      summary("a"),
      summary("blank", { name: "Untitled design" }),
    );
    storage.readActiveDesignId.mockReturnValue("blank");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().closeDesign("blank");

    expect(storage.deleteDesign).toHaveBeenCalledWith("blank");
    expect(records.has("blank")).toBe(false);
    expect(useDesignStore.getState().activeDesignId).toBe("a");
  });

  it("keeps a renamed design even when its board is empty", async () => {
    const records = library(summary("a"), summary("named", { name: "Platline" }));
    storage.readActiveDesignId.mockReturnValue("named");
    await useDesignStore.getState().hydrate();

    await useDesignStore.getState().closeDesign("named");

    expect(storage.deleteDesign).not.toHaveBeenCalled();
    expect(records.get("named")?.closed).toBe(true);
  });
});


describe("public viewing sessions", () => {
  withModAndCommunityOn();
  beforeEach(async () => {
    vi.clearAllMocks();
    useFactoryStore.getState().markHydratedProject(createEmptyProject());
    useDesignStore.setState({ activeDesignId: undefined, publicView: undefined, publicViews: [] });
    library(summary("a"));
    storage.readActiveDesignId.mockReturnValue("a");
    await useDesignStore.getState().hydrate();
  });

  it("flushes your outgoing design but never saves the viewed post into it", async () => {
    useFactoryStore.getState().renameProject("My last edit");
    const post = { ...createEmptyProject(), name: "Someone else's setup" };
    await useDesignStore.getState().viewPublicProject({ id: "post", name: post.name }, post);
    expect(storage.writeDesign).toHaveBeenCalledTimes(1);
    expect(storage.writeDesign.mock.calls[0][0].project.nodes).toEqual([]);
    expect(storage.writeDesign.mock.calls[0][0].project.name).not.toBe(post.name);
    expect(useDesignStore.getState().designs).toHaveLength(1);
    expect(useDesignStore.getState().activeDesignId).toBeUndefined();
    storage.writeDesign.mockClear();
    await useDesignStore.getState().saveActiveProject("a", post);
    await useDesignStore.getState().saveActiveProject(undefined, post);
    await useDesignStore.getState().reloadActiveDesign();
    expect(storage.writeDesign).not.toHaveBeenCalled();
    expect(useFactoryStore.getState().project.name).toBe(post.name);
    await useDesignStore.getState().switchToDesign("a");
    expect(storage.writeDesign).not.toHaveBeenCalled();
    expect(useFactoryStore.getState().isReadOnly).toBe(false);
    expect(useDesignStore.getState().publicView).toBeUndefined();
  });

  it("keeps multiple public tabs while switching to personal designs and closes only the chosen view", async () => {
    const store = useDesignStore.getState();
    await store.viewPublicProject({ id: "one", name: "One" }, { ...createEmptyProject(), name: "One" });
    await store.viewPublicProject({ id: "two", name: "Two" }, { ...createEmptyProject(), name: "Two" });
    await store.switchToDesign("a");
    expect(useDesignStore.getState().publicViews.map((view) => view.id)).toEqual(["one", "two"]);
    storage.writeDesign.mockClear();
    await store.switchToPublicView("one");
    expect(useFactoryStore.getState().isReadOnly).toBe(true);
    expect(useFactoryStore.getState().project.name).toBe("One");
    expect(useDesignStore.getState().publicViews.map((view) => view.id)).toEqual(["one", "two"]);
    storage.writeDesign.mockClear();
    await store.switchToPublicView("two");
    expect(storage.writeDesign).not.toHaveBeenCalled();
    await store.closePublicView("one");
    expect(useDesignStore.getState().publicView?.id).toBe("two");
    expect(useDesignStore.getState().publicViews.map((view) => view.id)).toEqual(["two"]);
    await store.closePublicView("two");
    expect(useDesignStore.getState().publicViews).toEqual([]);
    expect(useFactoryStore.getState().isReadOnly).toBe(false);
  });

  it("only Open a copy creates a design, and the copy is editable and unlinked", async () => {
    const post = { ...createEmptyProject(), name: "Public setup", metadata: { communityPlanId: "post" } };
    await useDesignStore.getState().viewPublicProject({ id: "post", name: post.name }, post);
    storage.writeDesign.mockClear();
    await copyViewedPost();
    expect(storage.writeDesign).toHaveBeenCalledTimes(1);
    const copy = storage.writeDesign.mock.calls[0][0];
    expect(copy.id).not.toBe("a");
    expect(copy.project.metadata?.communityPlanId).toBeUndefined();
    expect(useDesignStore.getState().activeDesignId).toBe(copy.id);
    expect(useDesignStore.getState().designs).toHaveLength(2);
    expect(useDesignStore.getState().publicView).toBeUndefined();
    expect(useFactoryStore.getState().isReadOnly).toBe(false);
  });
});


describe("public viewing sessions with the community library switched off", () => {
  withModAndCommunityUnset();

  it("opens no public view: the open design stays, read-write", async () => {
    useFactoryStore.getState().markHydratedProject(createEmptyProject());
    useDesignStore.setState({ activeDesignId: "a", publicView: undefined, publicViews: [] });
    const before = useFactoryStore.getState().project;
    const post = { ...createEmptyProject(), name: "Someone else's setup" };
    await useDesignStore.getState().viewPublicProject({ id: "post", name: post.name }, post);
    expect(useDesignStore.getState().publicView).toBeUndefined();
    expect(useDesignStore.getState().publicViews).toEqual([]);
    expect(useDesignStore.getState().activeDesignId).toBe("a");
    expect(useFactoryStore.getState().isReadOnly).toBe(false);
    expect(useFactoryStore.getState().project).toBe(before);
  });
});

describe("two browser tabs on one library (Jack, 2026-09-23: hours lost to a second tab)", () => {
  const T0 = "2026-09-23T10:00:00.000Z";
  const T1 = "2026-09-23T15:00:00.000Z";

  beforeEach(async () => {
    useDesignStore.setState({ publicView: undefined, publicViews: [], tabConflict: undefined });
    storage.readActiveDesignId.mockReturnValue("a");
  });

  /** This tab opens design "a" as stored at T0; returns the library map. */
  async function openAt(...more: DesignSummary[]) {
    const current = library(summary("a", { updatedAt: T0 }), ...more);
    await useDesignStore.getState().hydrate();
    storage.writeDesign.mockClear();
    return current;
  }

  /** Another tab saves a newer "a". */
  function otherTabSaves(current: Map<string, DesignSummary>) {
    current.set("a", { ...current.get("a")!, updatedAt: T1 });
  }

  const writesOf = (id: string) =>
    storage.writeDesign.mock.calls.filter(([record]) => record.id === id).length;

  it("never saves an old copy over a newer version: this tab's edits become a copy", async () => {
    const current = await openAt();
    otherTabSaves(current);
    useFactoryStore.getState().renameProject("An edit made on the old copy");
    await useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);

    expect(writesOf("a")).toBe(0);
    expect(current.get("a")?.updatedAt).toBe(T1);
    const copy = storage.writeDesign.mock.calls.at(-1)?.[0];
    expect(copy?.name).toBe("Design a (conflict copy)");
    expect(useDesignStore.getState().activeDesignId).toBe(copy?.id);
    expect(useDesignStore.getState().tabConflict).toEqual({
      name: "Design a",
      copyName: "Design a (conflict copy)",
    });
  });

  it("an untouched old copy is never written, not even on the way out", async () => {
    const current = await openAt(summary("b"));
    otherTabSaves(current);
    await useDesignStore.getState().switchToDesign("b");
    expect(writesOf("a")).toBe(0);
    expect(current.get("a")?.updatedAt).toBe(T1);
  });

  it("writes nothing a background tab changed by itself", async () => {
    await openAt();
    tabs.editing = false;
    useFactoryStore.getState().renameProject("A recipe refresh, say");
    await useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);
    expect(storage.writeDesign).not.toHaveBeenCalled();
  });

  it("two saves in flight at once never make a conflict copy of this tab's own work", async () => {
    // A player on one browser tab got "(conflict copy) (conflict copy) ..."
    // over and over (2026-09-25): a big plan's write was still landing when
    // the next autosave started, both checked against the same stored version,
    // and the second one read the first as another tab's save.
    const current = await openAt();
    useFactoryStore.getState().renameProject("First edit");
    const first = useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);
    useFactoryStore.getState().renameProject("Second edit");
    const second = useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);
    await Promise.all([first, second]);

    expect(useDesignStore.getState().tabConflict).toBeUndefined();
    expect(useDesignStore.getState().activeDesignId).toBe("a");
    expect([...current.keys()]).toEqual(["a"]);
    expect(storage.writeDesign.mock.calls.at(-1)?.[0].project.name).toBe("Design a");
    expect(writesOf("a")).toBe(2);
  });

  it("a conflict copy of a conflict copy does not stack the words", async () => {
    const current = library(summary("a", { updatedAt: T0, name: "Oil (conflict copy)" }));
    await useDesignStore.getState().hydrate();
    otherTabSaves(current);
    useFactoryStore.getState().renameProject("An edit");
    await useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);
    expect(useDesignStore.getState().tabConflict?.copyName).toBe("Oil (conflict copy) (2)");
  });

  it("a conflict copy's name fits the account's 80 characters", async () => {
    const long = "a".repeat(78);
    const current = library(summary("a", { updatedAt: T0, name: long }));
    await useDesignStore.getState().hydrate();
    otherTabSaves(current);
    useFactoryStore.getState().renameProject("An edit");
    await useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);
    const copyName = useDesignStore.getState().tabConflict?.copyName ?? "";
    expect(copyName.length).toBeLessThanOrEqual(80);
    expect(copyName.endsWith("(conflict copy)")).toBe(true);
  });

  it("saves its own edits and tells the other tabs", async () => {
    const current = await openAt();
    useFactoryStore.getState().renameProject("Real work");
    await useDesignStore.getState().saveActiveProject("a", useFactoryStore.getState().project);
    expect(writesOf("a")).toBe(1);
    expect(tabs.announced.map((message) => message.designId)).toEqual(["a"]);
    expect(tabs.announced[0]?.updatedAt).toBe(current.get("a")?.updatedAt);
  });

  it("loads another tab's save when it has nothing of its own, and keeps its edits when it has", async () => {
    const current = await openAt();
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const { startDesignTabSync } = await import("./design-store");
    const stop = startDesignTabSync();
    try {
      otherTabSaves(current);
      const newer = { ...createEmptyProject(), notes: "Three hours of tetranitromethane" };
      storage.readDesign.mockImplementation(async (id) =>
        id === "a" ? { ...current.get("a")!, project: newer } : undefined,
      );
      tabs.heard?.({ designId: "a", updatedAt: T1 });
      await vi.waitFor(() =>
        expect(useFactoryStore.getState().project.notes).toBe("Three hours of tetranitromethane"),
      );

      // Now this tab edits, and another save arrives: its edits stay put.
      useFactoryStore.getState().renameProject("Mine");
      current.set("a", { ...current.get("a")!, updatedAt: "2026-09-23T16:00:00.000Z" });
      tabs.heard?.({ designId: "a", updatedAt: "2026-09-23T16:00:00.000Z" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(useFactoryStore.getState().project.name).toBe("Mine");
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });
});

describe("the game version a design is for", () => {
  /** Storage as IndexedDB keeps it: records whole, summaries made from them as `writeDesign` makes them. */
  function versionedLibrary(...records: DesignRecord[]) {
    const stored = new Map(records.map((record) => [record.id, structuredClone(record)]));
    storage.listDesignSummaries.mockImplementation(async () =>
      [...stored.values()].map((record) => toDesignSummary(record)),
    );
    storage.readDesign.mockImplementation(async (id) => {
      const record = stored.get(id);
      return record ? structuredClone(record) : undefined;
    });
    storage.writeDesign.mockImplementation(async (record) => {
      stored.set(record.id, { ...toDesignSummary(record), project: structuredClone(record.project) });
    });
    return stored;
  }

  it("an IndexedDB record with no field opens as 2.9 and is not rewritten on load", async () => {
    useFactoryStore.getState().markHydratedProject(createEmptyProject());
    const old: DesignRecord = { ...summary("old"), project: createEmptyProject() };
    const other: DesignRecord = { ...summary("other"), project: { ...createEmptyProject(), gameVersion: "2.8.1" } };
    const stored = versionedLibrary(old, other);
    const raw = JSON.stringify(stored.get("old"));
    storage.readActiveDesignId.mockReturnValue("other");
    await useDesignStore.getState().hydrate();
    await useDesignStore.getState().switchToDesign("old");

    const project = useFactoryStore.getState().project;
    expect("gameVersion" in project).toBe(false);
    expect(planGameVersion(project)).toBe("2.9");
    expect(useDesignStore.getState().designs.find((design) => design.id === "old")?.gameVersion).toBeUndefined();
    // Nothing was written over the old record: no field, the same stamp.
    expect(JSON.stringify(stored.get("old"))).toBe(raw);
    expect(stored.get("old")?.updatedAt).toBe(old.updatedAt);
  });

  it("addDesign({ gameVersion: '2.8.1' }) stores a plan and a summary on 2.8.1", async () => {
    const stored = versionedLibrary();
    await useDesignStore.getState().addDesign({ gameVersion: "2.8.1" });

    const id = useDesignStore.getState().activeDesignId!;
    expect(stored.get(id)?.project.gameVersion).toBe("2.8.1");
    expect(useDesignStore.getState().designs.find((design) => design.id === id)?.gameVersion).toBe("2.8.1");
    expect(useFactoryStore.getState().project.gameVersion).toBe("2.8.1");
  });

  it("addDesign() with no version stamps none, and a task board takes the version it is given", async () => {
    const stored = versionedLibrary();
    await useDesignStore.getState().addDesign();
    const plain = useDesignStore.getState().activeDesignId!;
    expect("gameVersion" in stored.get(plain)!.project).toBe(false);

    await useDesignStore.getState().addTaskBoard({ gameVersion: "2.8.1" });
    const board = useDesignStore.getState().activeDesignId!;
    expect(stored.get(board)?.project).toMatchObject({ primaryView: "tasks", gameVersion: "2.8.1" });
    expect(useDesignStore.getState().designs.find((design) => design.id === board)).toMatchObject({
      taskBoard: true,
      gameVersion: "2.8.1",
    });
  });

  describe("blank plans the library makes itself take the New plans choice", () => {
    const version = (id: string, gtnhVersion: string) => ({
      id,
      gtnhVersion,
      channel: "stable" as const,
      publishedAt: "2026-10-20T00:00:00.000Z",
      manifestPath: "/datasets/gtnh/datasets.manifest.json",
      recipeDatasetPath: `/datasets/gtnh/${id}/recipes.json.gz`,
      sourceInfo: { sourceId: "recex" as const, generatedAt: "2026-10-20T00:00:00.000Z" },
    });
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestStableVersion: "local-2.9.0-rc-2",
      versions: [version("local-2.9.0-rc-2", "2.9.0-RC-2"), version("local-2.8.1", "2.8.1")],
    };
    beforeEach(() => {
      useFactoryStore.setState({ datasetManifest: manifest });
      // This suite runs with no localStorage, so the pick is held as the page's own choice.
      writeNewPlanVersion("2.8.1");
    });
    afterEach(() => {
      resetNewPlanVersionForTests();
      useFactoryStore.setState({ datasetManifest: undefined });
    });

    it("deleting the last plan seeds a blank plan on 2.8.1, with its tab's version", async () => {
      const stored = versionedLibrary({ ...summary("only"), project: createEmptyProject() });
      storage.deleteDesign.mockImplementation(async (id: string) => {
        stored.delete(id);
      });
      await useDesignStore.getState().hydrate();
      await useDesignStore.getState().removeDesign("only");

      const id = useDesignStore.getState().activeDesignId!;
      expect(id).not.toBe("only");
      expect(stored.get(id)?.project.gameVersion).toBe("2.8.1");
      // The tab's chip reads the summary.
      expect(useDesignStore.getState().designs.find((design) => design.id === id)?.gameVersion).toBe("2.8.1");
      expect(planGameVersion(useFactoryStore.getState().project)).toBe("2.8.1");
    });

    it("the first-run seed of an empty library is on 2.8.1 too", async () => {
      const stored = versionedLibrary();
      await useDesignStore.getState().hydrate();

      const [seeded] = [...stored.values()];
      expect(seeded?.project.gameVersion).toBe("2.8.1");
      expect(useDesignStore.getState().designs[0]?.gameVersion).toBe("2.8.1");
    });
  });

  it("duplicate and copy keep the version", async () => {
    const stored = versionedLibrary({ ...summary("src"), project: { ...createNewProject(), gameVersion: "2.8.1" } });
    await useDesignStore.getState().hydrate();
    await useDesignStore.getState().copyDesign("src");

    const copy = useDesignStore.getState().activeDesignId!;
    expect(copy).not.toBe("src");
    expect(stored.get(copy)?.project.gameVersion).toBe("2.8.1");
    expect(useDesignStore.getState().designs.find((design) => design.id === copy)?.gameVersion).toBe("2.8.1");
    expect(stored.get("src")?.project.gameVersion).toBe("2.8.1");
  });
});
