import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRecord, DesignSummary } from "@/lib/designs/design-library";

// The pure rules need neither; the sync runs below use them as IndexedDB and
// the account would: summaries made from records as `writeDesign` makes them.
const storage = vi.hoisted(() => ({ records: new Map<string, DesignRecord>() }));
vi.mock("@/lib/designs/design-storage", async () => {
  const { toDesignSummary } = await import("@/lib/designs/design-library");
  const summaryOf = (record: DesignRecord): DesignSummary => {
    const summary: Partial<DesignRecord> = { ...record };
    delete summary.project;
    return summary as DesignSummary;
  };
  return {
    listDesignSummaries: vi.fn(async () => [...storage.records.values()].map(summaryOf)),
    listDesignFolders: vi.fn(async () => []),
    readDesign: vi.fn(async (id: string) => storage.records.get(id)),
    readDesignSummary: vi.fn(async (id: string) => {
      const record = storage.records.get(id);
      return record ? summaryOf(record) : undefined;
    }),
    writeDesign: vi.fn(async (record: DesignRecord) => {
      storage.records.set(record.id, { ...toDesignSummary(record), project: record.project });
    }),
    writeDesignIfUnchanged: vi.fn(async () => "written"),
    writeDesignSummary: vi.fn(async (summary: DesignSummary & { project?: DesignRecord["project"] }) => {
      const record = storage.records.get(summary.id);
      if (record) {
        const kept: Partial<DesignRecord> = { ...summary };
        delete kept.project;
        storage.records.set(summary.id, { ...(kept as DesignSummary), project: record.project });
      }
    }),
    writeDesignFolder: vi.fn(async () => undefined),
    deleteDesign: vi.fn(async (id: string) => {
      storage.records.delete(id);
    }),
    deleteDesignFolder: vi.fn(async () => undefined),
    readActiveDesignId: vi.fn(() => undefined),
    writeActiveDesignId: vi.fn(),
  };
});
vi.mock("@/lib/designs/design-camera", () => ({
  keepDesignCameras: vi.fn(),
  forgetDesignCameras: vi.fn(),
  rememberDesignCamera: vi.fn(),
  readDesignCamera: vi.fn(),
  beginDesignCameraHandover: vi.fn(),
}));
const account = vi.hoisted(() => ({
  library: { designs: [] as unknown[], folders: [] as unknown[], shared: [] as unknown[] },
  plans: new Map<string, unknown>(),
  pushes: [] as Array<{ id: string; body: Record<string, unknown> }>,
}));
vi.mock("./client", () => ({
  fetchRemoteLibrary: vi.fn(async () => account.library),
  fetchRemoteDesignPlan: vi.fn(async (id: string) => ({
    design: account.library.designs.find((design) => (design as { id: string }).id === id),
    plan: account.plans.get(id),
  })),
  pushRemoteDesign: vi.fn(async (id: string, body: Record<string, unknown>) => {
    account.pushes.push({ id, body });
    return { design: { id, updatedAt: body.updatedAt }, behind: false };
  }),
  deleteRemoteDesign: vi.fn(async () => undefined),
  pushRemoteFolder: vi.fn(async () => ({ folder: {}, behind: false })),
  deleteRemoteFolder: vi.fn(async () => undefined),
}));

import { createNewProject } from "@/examples";
import { useCommunityAuthStore } from "@/store/community-auth-store";
import { useDesignStore } from "@/store/design-store";
import {
  libraryChangeSignature,
  reconcileDesigns,
  reconcileFolders,
  remoteMetaToSummary,
  syncLibraryNow,
} from "./library-sync";
import type { RemoteDesignMeta, RemoteFolder } from "./sync-types";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T01:00:00.000Z";
const T2 = "2026-09-01T02:00:00.000Z";
const T3 = "2026-09-01T03:00:00.000Z";

function remote(id: string, extra: Partial<RemoteDesignMeta> = {}): RemoteDesignMeta {
  return {
    id,
    name: id,
    icon: null,
    folderId: null,
    closed: false,
    favorite: false,
    order: null,
    communityPlanId: null,
    createdAt: T0,
    updatedAt: T1,
    planUpdatedAt: T1,
    deletedAt: null,
    ...extra,
  };
}

describe("reconcileDesigns", () => {
  it("pulls a design this browser has never seen", () => {
    expect(reconcileDesigns([], [remote("a")])).toEqual([
      { kind: "pull-plan", id: "a", remote: remote("a") },
    ]);
  });

  it("pushes a design the account has never seen, plan and all", () => {
    expect(reconcileDesigns([{ id: "a", updatedAt: T1 }], [])).toEqual([
      { kind: "push", id: "a", withPlan: true },
    ]);
  });

  it("does nothing when both sides still agree", () => {
    const local = { id: "a", updatedAt: T1, metaUpdatedAt: T1, remoteUpdatedAt: T1 };
    expect(reconcileDesigns([local], [remote("a")])).toEqual([]);
  });

  it("pushes only the metadata for a rename", () => {
    // The plan stamp stayed at T1; the meta stamp moved to T2.
    const local = { id: "a", updatedAt: T1, metaUpdatedAt: T2, remoteUpdatedAt: T1 };
    expect(reconcileDesigns([local], [remote("a")])).toEqual([
      { kind: "push", id: "a", withPlan: false },
    ]);
  });

  it("pushes the plan after an edit", () => {
    const local = { id: "a", updatedAt: T2, metaUpdatedAt: T2, remoteUpdatedAt: T1 };
    expect(reconcileDesigns([local], [remote("a")])).toEqual([
      { kind: "push", id: "a", withPlan: true },
    ]);
  });

  it("pulls only the metadata when the account renamed it", () => {
    const local = { id: "a", updatedAt: T1, metaUpdatedAt: T1, remoteUpdatedAt: T1 };
    const r = remote("a", { updatedAt: T2, planUpdatedAt: T1 });
    expect(reconcileDesigns([local], [r])).toEqual([{ kind: "pull-meta", id: "a", remote: r }]);
  });

  it("pulls the plan when the account edited it", () => {
    const local = { id: "a", updatedAt: T1, metaUpdatedAt: T1, remoteUpdatedAt: T1 };
    const r = remote("a", { updatedAt: T2, planUpdatedAt: T2 });
    expect(reconcileDesigns([local], [r])).toEqual([{ kind: "pull-plan", id: "a", remote: r }]);
  });

  it("lets the later writer win when both sides moved", () => {
    const localOlder = { id: "a", updatedAt: T2, metaUpdatedAt: T2, remoteUpdatedAt: T1 };
    const remoteNewer = remote("a", { updatedAt: T3, planUpdatedAt: T3 });
    expect(reconcileDesigns([localOlder], [remoteNewer])).toEqual([
      { kind: "pull-plan", id: "a", remote: remoteNewer },
    ]);

    const localNewer = { id: "a", updatedAt: T3, metaUpdatedAt: T3, remoteUpdatedAt: T1 };
    const remoteOlder = remote("a", { updatedAt: T2, planUpdatedAt: T2 });
    expect(reconcileDesigns([localNewer], [remoteOlder])).toEqual([
      { kind: "push", id: "a", withPlan: true },
    ]);
  });

  it("deletes the local copy for a tombstone it had synced", () => {
    const local = { id: "a", updatedAt: T1, metaUpdatedAt: T1, remoteUpdatedAt: T1 };
    const gone = remote("a", { updatedAt: T2, deletedAt: T2 });
    expect(reconcileDesigns([local], [gone])).toEqual([{ kind: "delete-local", id: "a" }]);
  });

  it("brings a design back when it was edited after the delete", () => {
    const local = { id: "a", updatedAt: T3, metaUpdatedAt: T3, remoteUpdatedAt: T1 };
    const gone = remote("a", { updatedAt: T2, deletedAt: T2 });
    expect(reconcileDesigns([local], [gone])).toEqual([
      { kind: "push", id: "a", withPlan: true },
    ]);
  });

  it("ignores a tombstone for a design it never had", () => {
    expect(reconcileDesigns([], [remote("a", { deletedAt: T2 })])).toEqual([]);
  });
});

describe("reconcileFolders", () => {
  const folder = (id: string, extra: Partial<RemoteFolder> = {}): RemoteFolder => ({
    id,
    name: id,
    createdAt: T0,
    updatedAt: T1,
    deletedAt: null,
    ...extra,
  });

  it("pulls, pushes and deletes by the same rules", () => {
    expect(reconcileFolders([], [folder("f")])).toEqual([
      { kind: "pull", id: "f", remote: folder("f") },
    ]);
    expect(reconcileFolders([{ id: "g", createdAt: T1, updatedAt: T1 }], [])).toEqual([
      { kind: "push", id: "g" },
    ]);
    const synced = { id: "f", createdAt: T0, updatedAt: T1, remoteUpdatedAt: T1 };
    expect(reconcileFolders([synced], [folder("f")])).toEqual([]);
    expect(reconcileFolders([synced], [folder("f", { updatedAt: T2, deletedAt: T2 })])).toEqual([
      { kind: "delete-local", id: "f" },
    ]);
    const renamedHere = { ...synced, updatedAt: T2 };
    expect(reconcileFolders([renamedHere], [folder("f")])).toEqual([{ kind: "push", id: "f" }]);
  });
});

describe("libraryChangeSignature", () => {
  const design = { id: "a", name: "A", createdAt: T0, updatedAt: T1, metaUpdatedAt: T1 };
  const folder = { id: "f", name: "F", createdAt: T0, updatedAt: T1 };
  const base = libraryChangeSignature([design], [folder]);

  it("does not move for a relist that changed nothing, or for sync's own stamp", () => {
    // A refused design kept sync relisting the library every run, and the
    // relist read as an edit: one player's browser synced every 6 s for hours.
    expect(libraryChangeSignature([{ ...design }], [{ ...folder }])).toBe(base);
    expect(libraryChangeSignature([{ ...design, remoteUpdatedAt: T2 } as typeof design], [folder])).toBe(base);
  });

  it("moves for an edit, a rename, a new design or a folder change", () => {
    expect(libraryChangeSignature([{ ...design, updatedAt: T2 }], [folder])).not.toBe(base);
    expect(libraryChangeSignature([{ ...design, metaUpdatedAt: T2 }], [folder])).not.toBe(base);
    expect(libraryChangeSignature([design, { ...design, id: "b" }], [folder])).not.toBe(base);
    expect(libraryChangeSignature([design], [{ ...folder, updatedAt: T2 }])).not.toBe(base);
    expect(libraryChangeSignature([design], [])).not.toBe(base);
  });
});

describe("the game version through the account sync", () => {
  beforeEach(() => {
    storage.records.clear();
    account.library = { designs: [], folders: [], shared: [] };
    account.plans.clear();
    account.pushes = [];
    useDesignStore.setState({ designs: [], activeDesignId: undefined });
    useCommunityAuthStore.setState({ user: { username: "ann" }, hasHydrated: true });
  });

  it("account sync pull and push keep gameVersion", async () => {
    // Pulled: a plan this browser has never seen, made for 2.8.1.
    account.library.designs = [remote("pulled")];
    account.plans.set("pulled", { ...createNewProject(), gameVersion: "2.8.1" });
    // Pushed: a 2.8.1 plan the account has never seen.
    storage.records.set("pushed", {
      id: "pushed",
      name: "Pushed",
      createdAt: T0,
      updatedAt: T2,
      gameVersion: "2.8.1",
      project: { ...createNewProject(), gameVersion: "2.8.1" },
    });

    await syncLibraryNow();

    expect(storage.records.get("pulled")?.project.gameVersion).toBe("2.8.1");
    expect(storage.records.get("pulled")?.gameVersion).toBe("2.8.1");
    const push = account.pushes.find((entry) => entry.id === "pushed");
    expect((push?.body.plan as { gameVersion?: string } | undefined)?.gameVersion).toBe("2.8.1");
    expect(storage.records.get("pushed")?.gameVersion).toBe("2.8.1");
  });

  it("a pulled plan with no version leaves no stale one on the summary, and a pull of the name alone keeps it", async () => {
    storage.records.set("old", {
      id: "old",
      name: "Old",
      createdAt: T0,
      updatedAt: T1,
      metaUpdatedAt: T1,
      remoteUpdatedAt: T1,
      gameVersion: "2.8.1",
      project: { ...createNewProject(), gameVersion: "2.8.1" },
    });
    storage.records.set("renamed", {
      id: "renamed",
      name: "Renamed",
      createdAt: T0,
      updatedAt: T1,
      metaUpdatedAt: T1,
      remoteUpdatedAt: T1,
      gameVersion: "2.8.1",
      project: { ...createNewProject(), gameVersion: "2.8.1" },
    });
    account.library.designs = [
      remote("old", { updatedAt: T2, planUpdatedAt: T2 }),
      remote("renamed", { name: "Renamed again", updatedAt: T2, planUpdatedAt: T1 }),
    ];
    account.plans.set("old", createNewProject());

    await syncLibraryNow();

    expect("gameVersion" in storage.records.get("old")!.project).toBe(false);
    expect(storage.records.get("old")?.gameVersion).toBeUndefined();
    expect(storage.records.get("renamed")).toMatchObject({ name: "Renamed again", gameVersion: "2.8.1" });
  });

  it("a listing-only summary has no version until its plan is pulled", () => {
    // The account's listing carries no plan: the tab knows no version yet, never "2.9".
    const summary = remoteMetaToSummary(remote("listed"));
    expect("gameVersion" in summary).toBe(false);
  });
});
