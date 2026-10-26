import { beforeEach, describe, expect, it } from "vitest";
import { DatasetCache } from "@/lib/datasets/dataset-cache";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "@/lib/datasets";
import type { Recipe } from "@/lib/model/types";
import { getStorageRole } from "@/lib/model/storage-role";
import { PROJECT_SCHEMA_VERSION, type FactoryProject } from "@/lib/model/types";
import { makeResourceHandleId } from "@/components/flow/resource-handles";
import { captureBoardSelection, replaceDatasetCacheForTests, useFactoryStore } from "./factory-store";
import { allowLegacyModesForTests } from "@/lib/model/project-normalize";

// These tests exercise the old Build, Solve and Pool code, which the app no longer reaches.
allowLegacyModesForTests();

describe("factory resource links", () => {
  beforeEach(() => {
    useFactoryStore.getState().setProject(createLinkTestProject());
  });

  it("connects matching item recipe slots with explicit handles", () => {
    useFactoryStore.getState().connectNodes("item-source", "item-target", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
    });

    expect(useFactoryStore.getState().project.edges).toEqual([
      expect.objectContaining({
        source: "item-source",
        target: "item-target",
        sourceHandle: "output:item:dust:0",
        targetHandle: "input:item:dust:0",
        resourceKind: "item",
        resourceId: "dust",
      }),
    ]);
  });

  it("connects concrete item outputs to ore dictionary inputs", () => {
    useFactoryStore.getState().connectNodes("stick-source", "stick-oredict-target", {
      kind: "item",
      id: "minecraft:stick@0",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "minecraft:stick@0" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "oredict:stickWood" }, 0),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "stick-source",
        target: "stick-oredict-target",
        sourceHandle: "output:item:minecraft%3Astick%400:0",
        targetHandle: "input:item:minecraft%3Astick%400",
        resourceKind: "item",
        resourceId: "minecraft:stick@0",
      }),
    );
  });

  it("stores the concrete connected resource on an ore dictionary input node", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "connected-oredict-override-test",
      name: "Connected oredict override test",
      fuelProfiles: [],
      recipes: [
        {
          id: "tgs",
          name: "Tree Growth Simulator",
          machineType: "Tree Growth Simulator",
          minimumTier: "LV",
          durationTicks: 100,
          eut: 0,
          inputs: [],
          outputs: [
            {
              kind: "item",
              id: "minecraft:log@1",
              amount: 16,
              displayName: "Spruce Log",
              iconPath: "/items/spruce-log.png",
            },
          ],
        },
        {
          id: "coke",
          name: "Coke Oven",
          machineType: "Coke Oven",
          minimumTier: "MV",
          durationTicks: 256,
          eut: 96,
          inputs: [
            {
              kind: "item",
              id: "oredict:logWood",
              amount: 16,
              displayName: "Ore Dictionary: logWood",
              alternatives: [
                {
                  kind: "item",
                  id: "minecraft:log@0",
                  displayName: "Oak Log",
                  iconPath: "/items/oak-log.png",
                },
                {
                  kind: "item",
                  id: "minecraft:log@1",
                  displayName: "Spruce Log",
                  iconPath: "/items/old-spruce-log.png",
                },
              ],
            },
          ],
          outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
        },
      ],
      nodes: [
        {
          id: "tgs-node",
          recipeId: "tgs",
          machineCount: 1,
          parallel: 1,
          overclockTier: "LV",
          enabled: true,
          position: { x: 0, y: 0 },
        },
        {
          id: "coke-node",
          recipeId: "coke",
          machineCount: 1,
          parallel: 1,
          overclockTier: "MV",
          enabled: true,
          position: { x: 400, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().connectNodes("tgs-node", "coke-node", {
      kind: "item",
      id: "minecraft:log@1",
      displayName: "Spruce Log",
      iconPath: "/items/spruce-log.png",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "minecraft:log@1" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "oredict:logWood" }, 0),
    });

    expect(useFactoryStore.getState().project.nodes[1]?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        id: "minecraft:log@1",
        displayName: "Spruce Log",
        iconPath: "/items/spruce-log.png",
        alternatives: undefined,
      }),
    );
  });

  it("connects explicit concrete handles even when the source recipe output is contextual", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "contextual-output-link-test",
      name: "Contextual output link test",
      fuelProfiles: [],
      recipes: [
        {
          id: "tgs",
          name: "Tree Growth Simulator",
          machineType: "Tree Growth Simulator",
          minimumTier: "LV",
          durationTicks: 100,
          eut: 0,
          inputs: [],
          outputs: [
            {
              kind: "item",
              id: "oredict:logWood",
              amount: 16,
              displayName: "Ore Dictionary: logWood",
              alternatives: [{ kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" }],
            },
          ],
        },
        {
          id: "coke",
          name: "Coke Oven",
          machineType: "Coke Oven",
          minimumTier: "MV",
          durationTicks: 256,
          eut: 96,
          inputs: [
            {
              kind: "item",
              id: "oredict:logWood",
              amount: 16,
              displayName: "Ore Dictionary: logWood",
              alternatives: [{ kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" }],
            },
          ],
          outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
        },
      ],
      nodes: [
        {
          id: "tgs-node",
          recipeId: "tgs",
          machineCount: 1,
          parallel: 1,
          overclockTier: "LV",
          enabled: true,
          position: { x: 0, y: 0 },
        },
        {
          id: "coke-node",
          recipeId: "coke",
          machineCount: 1,
          parallel: 1,
          overclockTier: "MV",
          recipeInputOverrides: {
            "0": {
              kind: "item",
              id: "minecraft:log@1",
              amount: 16,
              displayName: "Spruce Log",
            },
          },
          enabled: true,
          position: { x: 400, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().connectNodes("tgs-node", "coke-node", {
      kind: "item",
      id: "minecraft:log@1",
      displayName: "Spruce Log",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "minecraft:log@1" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "minecraft:log@1" }, 0),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "tgs-node",
        target: "coke-node",
        resourceKind: "item",
        resourceId: "minecraft:log@1",
        sourceHandle: "output:item:minecraft%3Alog%401:0",
        targetHandle: "input:item:minecraft%3Alog%401:0",
      }),
    );

    useFactoryStore.getState().updateNode("tgs-node", {
      machineConfigTiers: { tgsToolSlot1: "saw" },
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "tgs-node",
        target: "coke-node",
        resourceKind: "item",
        resourceId: "minecraft:log@1",
      }),
    );
  });

  it("connects tool outputs to matching ore dictionary tool inputs", () => {
    useFactoryStore.getState().connectNodes("screwdriver-source", "screwdriver-oredict-target", {
      kind: "item",
      id: "gregtech:screwdriver.lv@0",
      sourceHandle: makeResourceHandleId(
        "output",
        { kind: "item", id: "gregtech:screwdriver.lv@0" },
        0,
      ),
      targetHandle: makeResourceHandleId(
        "input",
        { kind: "item", id: "oredict:craftingToolScrewdriver" },
        0,
      ),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "screwdriver-source",
        target: "screwdriver-oredict-target",
        sourceHandle: "output:item:gregtech%3Ascrewdriver.lv%400:0",
        targetHandle: "input:item:gregtech%3Ascrewdriver.lv%400",
        resourceKind: "item",
        resourceId: "gregtech:screwdriver.lv@0",
      }),
    );
  });

  it("connects concrete item drawers to ore dictionary inputs", () => {
    useFactoryStore.getState().connectNodes("stick-drawer", "stick-oredict-target", {
      kind: "item",
      id: "minecraft:stick@0",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "minecraft:stick@0" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "oredict:stickWood" }, 0),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "stick-drawer",
        target: "stick-oredict-target",
        resourceKind: "item",
        resourceId: "minecraft:stick@0",
      }),
    );
  });

  it("connects matching fluid recipe slots with explicit handles", () => {
    useFactoryStore.getState().connectNodes("fluid-source", "fluid-target", {
      kind: "fluid",
      id: "water",
      sourceHandle: makeResourceHandleId("output", { kind: "fluid", id: "water" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "water" }, 0),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "fluid-source",
        target: "fluid-target",
        sourceHandle: "output:fluid:water:0",
        targetHandle: "input:fluid:water:0",
        resourceKind: "fluid",
        resourceId: "water",
      }),
    );
  });

  it("refuses mismatched item and fluid resources", () => {
    useFactoryStore.getState().connectNodes("item-source", "fluid-target", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "water" }, 0),
    });

    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
  });

  it("connects recipe outputs into matching drawers or tanks", () => {
    useFactoryStore.getState().connectNodes("fluid-source", "water-tank", {
      kind: "fluid",
      id: "water",
      sourceHandle: makeResourceHandleId("output", { kind: "fluid", id: "water" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "water" }),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "fluid-source",
        target: "water-tank",
        targetHandle: "input:fluid:water",
        resourceKind: "fluid",
        resourceId: "water",
      }),
    );
  });

  it("connects matching drawers or tanks into recipe inputs", () => {
    useFactoryStore.getState().connectNodes("dust-drawer", "item-target", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "dust-drawer",
        target: "item-target",
        sourceHandle: "output:item:dust",
        resourceKind: "item",
        resourceId: "dust",
      }),
    );
  });

  it("connects a drawer into a drawer of the same resource", () => {
    const base = useFactoryStore.getState().project;
    useFactoryStore.getState().setProject({
      ...base,
      storages: [
        ...(base.storages ?? []),
        {
          id: "dust-drawer-2",
          kind: "item",
          resourceId: "dust",
          displayName: "Dust 2",
          position: { x: 300, y: 0 },
        },
      ],
    });

    useFactoryStore.getState().connectNodes("dust-drawer", "dust-drawer-2", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "dust-drawer",
        target: "dust-drawer-2",
        resourceKind: "item",
        resourceId: "dust",
      }),
    );

    // The same gesture again is the undo: one wire between two rows, toggled.
    useFactoryStore.getState().connectNodes("dust-drawer", "dust-drawer-2", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }),
    });
    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
  });

  it("wires the neighbours straight together when a pass-through drawer is deleted", () => {
    // The undo of the board menu's "Add a drawer here": scrub the drawer
    // away and the wire it stood in the middle of is back.
    const base = useFactoryStore.getState().project;
    const out = makeResourceHandleId("output", { kind: "item", id: "dust" });
    const into = makeResourceHandleId("input", { kind: "item", id: "dust" });
    const drawer = (id: string, x: number) => ({
      id,
      kind: "item" as const,
      resourceId: "dust",
      displayName: "Dust",
      position: { x, y: 0 },
    });
    const wire = (id: string, source: string, target: string) => ({
      id,
      source,
      target,
      sourceHandle: out,
      targetHandle: into,
      resourceKind: "item" as const,
      resourceId: "dust",
    });
    useFactoryStore.getState().setProject({
      ...base,
      storages: [drawer("dust-a", 0), drawer("dust-b", 200), drawer("dust-c", 400)],
      edges: [wire("a-b", "dust-a", "dust-b"), wire("b-c", "dust-b", "dust-c")],
    });

    useFactoryStore.getState().deleteStorage("dust-b");

    const project = useFactoryStore.getState().project;
    expect((project.storages ?? []).map((entry) => entry.id)).toEqual(["dust-a", "dust-c"]);
    expect(project.edges).toEqual([
      expect.objectContaining({ source: "dust-a", target: "dust-c", resourceId: "dust" }),
    ]);
  });

  it("heals nothing when the deleted drawer was a junction", () => {
    // Two feeders AND two takers: there is no one wire that says what the
    // drawer meant, so its neighbours are left unwired rather than guessed.
    const base = useFactoryStore.getState().project;
    const out = makeResourceHandleId("output", { kind: "item", id: "dust" });
    const into = makeResourceHandleId("input", { kind: "item", id: "dust" });
    const drawer = (id: string, x: number) => ({
      id,
      kind: "item" as const,
      resourceId: "dust",
      displayName: "Dust",
      position: { x, y: 0 },
    });
    const wire = (id: string, source: string, target: string) => ({
      id,
      source,
      target,
      sourceHandle: out,
      targetHandle: into,
      resourceKind: "item" as const,
      resourceId: "dust",
    });
    useFactoryStore.getState().setProject({
      ...base,
      storages: [
        drawer("in-1", 0),
        drawer("in-2", 0),
        drawer("hub", 200),
        drawer("out-1", 400),
        drawer("out-2", 400),
      ],
      edges: [
        wire("i1", "in-1", "hub"),
        wire("i2", "in-2", "hub"),
        wire("o1", "hub", "out-1"),
        wire("o2", "hub", "out-2"),
      ],
    });

    useFactoryStore.getState().deleteStorage("hub");

    expect(useFactoryStore.getState().project.edges).toEqual([]);
  });

  it("refuses a drawer wired to a drawer of a different resource, or to itself", () => {
    useFactoryStore.getState().connectNodes("dust-drawer", "mold-drawer", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "mold" }),
    });
    useFactoryStore.getState().connectNodes("dust-drawer", "dust-drawer", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }),
    });

    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
  });

  it("spawns a wired feeder drawer off a drawer, the make-up source", () => {
    const store = useFactoryStore.getState();
    store.addStorageForConnection(
      { kind: "item", id: "dust", displayName: "Dust" },
      "dust-drawer",
      "input",
      { x: 320, y: 200 },
      makeResourceHandleId("input", { kind: "item", id: "dust" }),
    );

    const project = useFactoryStore.getState().project;
    const feeder = (project.storages ?? []).find((entry) => entry.id !== "dust-drawer");
    expect(feeder).toBeDefined();
    expect(project.edges).toEqual([
      expect.objectContaining({ source: feeder?.id, target: "dust-drawer" }),
    ]);
  });

  it("keeps a drawer-to-drawer wire through the edge validity prune", () => {
    const base = useFactoryStore.getState().project;
    useFactoryStore.getState().setProject({
      ...base,
      storages: [
        ...(base.storages ?? []),
        {
          id: "dust-drawer-2",
          kind: "item",
          resourceId: "dust",
          displayName: "Dust 2",
          position: { x: 300, y: 0 },
        },
      ],
      edges: [
        {
          id: "drawer-feed",
          source: "dust-drawer",
          target: "dust-drawer-2",
          resourceKind: "item",
          resourceId: "dust",
        },
      ],
    });

    // updateNode runs the invalid-edge prune; the drawer wire must survive it.
    useFactoryStore.getState().updateNode("item-source", { machineCount: 2 });

    expect(useFactoryStore.getState().project.edges).toEqual([
      expect.objectContaining({ source: "dust-drawer", target: "dust-drawer-2" }),
    ]);
  });

  it("does not create multiple storage cards from the same recipe slot", () => {
    const store = useFactoryStore.getState();
    store.addStorageForConnection(
      { kind: "item", id: "dust", displayName: "Dust" },
      "item-source",
      "output",
      { x: 320, y: 20 },
      makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
    );
    store.addStorageForConnection(
      { kind: "item", id: "dust", displayName: "Dust" },
      "item-source",
      "output",
      { x: 420, y: 20 },
      makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
    );

    const dustStorages =
      useFactoryStore
        .getState()
        .project.storages?.filter((storage) => storage.resourceId === "dust") ?? [];
    const createdDustStorages = dustStorages.filter((storage) => storage.id !== "dust-drawer");

    expect(createdDustStorages).toHaveLength(1);
    expect(useFactoryStore.getState().project.edges).toHaveLength(1);
    expect(useFactoryStore.getState().project.edges[0]?.target).toBe(createdDustStorages[0]?.id);
  });

  it("allows separate storage cards for the same resource on different recipe slots", () => {
    const store = useFactoryStore.getState();
    store.addStorageForConnection(
      { kind: "item", id: "dust", displayName: "Dust" },
      "item-source",
      "output",
      { x: 320, y: 20 },
      makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
    );
    store.addStorageForConnection(
      { kind: "item", id: "dust", displayName: "Dust" },
      "item-target",
      "input",
      { x: 420, y: 20 },
      makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
    );

    const createdDustStorages =
      useFactoryStore
        .getState()
        .project.storages?.filter((storage) => storage.resourceId === "dust")
        .filter((storage) => storage.id !== "dust-drawer") ?? [];

    expect(createdDustStorages).toHaveLength(2);
    expect(useFactoryStore.getState().project.edges).toHaveLength(2);
  });

  it("creates a drawer of cells, not a tank, when dragging a filled cell input", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "filled-cell-storage-test",
      name: "Filled cell storage test",
      fuelProfiles: [],
      recipes: [
        {
          id: "cell-consumer",
          name: "Cell Consumer",
          machineType: "Assembler",
          minimumTier: "LV",
          durationTicks: 20,
          eut: 1,
          inputs: [
            {
              kind: "item",
              id: "gregtech:gt.metaitem.99@143",
              amount: 2,
              displayName: "Molten Magmatter Cell",
              alternatives: [
                {
                  kind: "fluid",
                  id: "molten.magmatter",
                  displayName: "Molten Magmatter",
                  amount: 144,
                },
              ],
            },
          ],
          outputs: [{ kind: "item", id: "plate", amount: 1 }],
        },
      ],
      nodes: [makeNode("cell-consumer-node", "cell-consumer", 0)],
      storages: [],
      edges: [],
    });

    useFactoryStore.getState().addStorageForConnection(
      {
        kind: "item",
        id: "gregtech:gt.metaitem.99@143",
        amount: 2,
        displayName: "Molten Magmatter Cell",
        alternatives: [
          {
            kind: "fluid",
            id: "molten.magmatter",
            displayName: "Molten Magmatter",
            amount: 144,
          },
        ],
      },
      "cell-consumer-node",
      "input",
      { x: 320, y: 20 },
      makeResourceHandleId("input", { kind: "item", id: "gregtech:gt.metaitem.99@143" }, 0),
    );

    // The buffer holds what the slot holds. It used to be rewritten into the
    // fluid, which turned an item slot into a tank reading litres and quietly
    // dropped the Canner that crossing the two forms really takes.
    const state = useFactoryStore.getState();
    expect(state.project.storages?.[0]).toEqual(
      expect.objectContaining({
        kind: "item",
        resourceId: "gregtech:gt.metaitem.99@143",
        displayName: "Molten Magmatter Cell",
      }),
    );
    expect(state.project.edges[0]).toEqual(
      expect.objectContaining({
        source: state.project.storages?.[0]?.id,
        target: "cell-consumer-node",
        resourceKind: "item",
        resourceId: "gregtech:gt.metaitem.99@143",
        targetHandle: "input:item:gregtech%3Agt.metaitem.99%40143:0",
      }),
    );
    // Same kind in, same kind out: the requirement is left exactly as written,
    // never multiplied by a guessed 1000 L per cell.
    const override = state.project.nodes[0]?.recipeInputOverrides?.["0"];
    expect(override?.kind ?? "item").toBe("item");
    expect(override?.amount ?? 2).toBe(2);
  });

  it("connects a new drawer to an overridden concrete recipe input", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "overridden-input-storage-link",
      name: "Overridden input storage link",
      fuelProfiles: [],
      recipes: [
        {
          id: "pyro",
          name: "Pyrolyse Oven: Charcoal",
          machineType: "Pyrolyse Oven",
          minimumTier: "MV",
          durationTicks: 320,
          eut: 96,
          inputs: [
            {
              kind: "item",
              id: "minecraft:log@32767",
              amount: 16,
              displayName: "Oak Log",
            },
          ],
          outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
        },
      ],
      nodes: [
        {
          id: "pyro-node",
          recipeId: "pyro",
          machineCount: 1,
          parallel: 1,
          overclockTier: "MV",
          recipeInputOverrides: {
            "0": {
              kind: "item",
              id: "minecraft:log@1",
              amount: 16,
              displayName: "Spruce Log",
            },
          },
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
      storages: [],
      edges: [],
    });

    useFactoryStore
      .getState()
      .addStorageForConnection(
        { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" },
        "pyro-node",
        "input",
        { x: 220, y: 0 },
        makeResourceHandleId("input", { kind: "item", id: "minecraft:log@1" }, 0),
      );

    const project = useFactoryStore.getState().project;
    expect(project.storages).toEqual([
      expect.objectContaining({
        kind: "item",
        resourceId: "minecraft:log@1",
        displayName: "Spruce Log",
      }),
    ]);
    expect(project.edges).toEqual([
      expect.objectContaining({
        source: project.storages?.[0]?.id,
        target: "pyro-node",
        sourceHandle: "output:item:minecraft%3Alog%401",
        targetHandle: "input:item:minecraft%3Alog%401:0",
        resourceKind: "item",
        resourceId: "minecraft:log@1",
        label: "Spruce Log",
      }),
    ]);
  });

  it("does not connect storage to non-consumed recipe inputs", () => {
    useFactoryStore.getState().connectNodes("mold-drawer", "nc-target", {
      kind: "item",
      id: "mold",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "mold" }),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "mold" }, 0),
    });

    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
  });

  it("connects pending fluid slots regardless of click order", () => {
    const store = useFactoryStore.getState();
    store.selectResourceConnectionSlot({
      nodeId: "fluid-target",
      side: "input",
      kind: "fluid",
      resourceId: "water",
      displayName: "Water",
      handleId: makeResourceHandleId("input", { kind: "fluid", id: "water" }, 0),
    });
    useFactoryStore.getState().selectResourceConnectionSlot({
      nodeId: "fluid-source",
      side: "output",
      kind: "fluid",
      resourceId: "water",
      displayName: "Water",
      handleId: makeResourceHandleId("output", { kind: "fluid", id: "water" }, 0),
    });

    expect(useFactoryStore.getState().project.edges[0]).toEqual(
      expect.objectContaining({
        source: "fluid-source",
        target: "fluid-target",
        resourceKind: "fluid",
        resourceId: "water",
      }),
    );
  });

  it("removes an existing resource edge when the same slots are linked again", () => {
    const firstSlot = {
      nodeId: "item-source",
      side: "output" as const,
      kind: "item" as const,
      resourceId: "dust",
      displayName: "Dust",
      handleId: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
    };
    const secondSlot = {
      nodeId: "item-target",
      side: "input" as const,
      kind: "item" as const,
      resourceId: "dust",
      displayName: "Dust",
      handleId: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
    };

    useFactoryStore.getState().selectResourceConnectionSlot(firstSlot);
    useFactoryStore.getState().selectResourceConnectionSlot(secondSlot);
    expect(useFactoryStore.getState().project.edges).toHaveLength(1);

    useFactoryStore.getState().selectResourceConnectionSlot(firstSlot);
    useFactoryStore.getState().selectResourceConnectionSlot(secondSlot);
    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
  });

  it("never draws a second wire between the same two port rows", () => {
    // What auto-connect and plan imports write: handles carrying the recipe's
    // slot index. A card draws one row per resource, so a hand-drawn wire onto
    // the same rows is that same wire and toggles it off rather than stacking a
    // copy on top of it.
    useFactoryStore.getState().connectNodes("item-source", "item-target", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
    });
    expect(useFactoryStore.getState().project.edges).toHaveLength(1);

    const dragOntoTheSameRows = () =>
      useFactoryStore.getState().connectNodes("item-source", "item-target", {
        kind: "item",
        id: "dust",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }),
      });

    dragOntoTheSameRows();
    expect(useFactoryStore.getState().project.edges).toHaveLength(0);

    dragOntoTheSameRows();
    dragOntoTheSameRows();
    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
  });

  it("auto-connects a repeated resource once, not once per slot pair", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "repeated-slot-test",
      name: "Repeated slot test",
      fuelProfiles: [],
      recipes: [
        {
          id: "double-out-recipe",
          name: "Double out",
          machineType: "Source",
          minimumTier: "LV",
          durationTicks: 20,
          eut: 1,
          inputs: [],
          outputs: [
            { kind: "item", id: "dust", amount: 1 },
            { kind: "item", id: "dust", amount: 2 },
          ],
        },
        {
          id: "double-in-recipe",
          name: "Double in",
          machineType: "Target",
          minimumTier: "LV",
          durationTicks: 20,
          eut: 1,
          inputs: [
            { kind: "item", id: "dust", amount: 1 },
            { kind: "item", id: "dust", amount: 2 },
          ],
          outputs: [{ kind: "item", id: "plate", amount: 1 }],
        },
      ],
      nodes: [
        {
          id: "double-out",
          recipeId: "double-out-recipe",
          machineCount: 1,
          parallel: 1,
          enabled: true,
          overclockTier: "LV",
          position: { x: 0, y: 0 },
        },
        {
          id: "double-in",
          recipeId: "double-in-recipe",
          machineCount: 1,
          parallel: 1,
          enabled: true,
          overclockTier: "LV",
          position: { x: 400, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().autoConnectNode("double-in");

    // Two output slots against two input slots pair up four ways; the cards draw
    // one output row and one input row, so that is one wire.
    expect(useFactoryStore.getState().project.edges).toHaveLength(1);
  });

  describe("custom rate cards", () => {
    /** A fresh unadopted card, plus the wire the board would hand it. */
    const wireSupplyIntoTarget = (customNodeId: string) =>
      useFactoryStore.getState().connectCustomRate(
        customNodeId,
        "output",
        {
          nodeId: "item-target",
          handleId: makeResourceHandleId("input", { kind: "item", id: "dust" }),
        },
        { kind: "item", id: "dust", displayName: "Dust" },
      );

    const addCard = () => {
      useFactoryStore.getState().addCustomRateNode();
      const nodes = useFactoryStore.getState().project.nodes;
      return nodes[nodes.length - 1]!.id;
    };

    it("wires a supplying card once however many times the same port is offered", () => {
      const card = addCard();

      wireSupplyIntoTarget(card);
      expect(useFactoryStore.getState().project.edges).toHaveLength(1);

      wireSupplyIntoTarget(card);
      wireSupplyIntoTarget(card);
      wireSupplyIntoTarget(card);
      expect(useFactoryStore.getState().project.edges).toHaveLength(1);
    });

    it("wires a requesting card once however many times the same port is offered", () => {
      const card = addCard();
      const request = () =>
        useFactoryStore.getState().connectCustomRate(
          card,
          "input",
          {
            nodeId: "item-source",
            handleId: makeResourceHandleId("output", { kind: "item", id: "dust" }),
          },
          { kind: "item", id: "dust", displayName: "Dust" },
        );

      request();
      expect(useFactoryStore.getState().project.edges).toHaveLength(1);

      request();
      request();
      expect(useFactoryStore.getState().project.edges).toHaveLength(1);
    });

    it("still lets one card supply two different machines", () => {
      const card = addCard();

      wireSupplyIntoTarget(card);
      useFactoryStore.getState().connectCustomRate(
        card,
        "output",
        {
          nodeId: "fluid-target",
          handleId: makeResourceHandleId("input", { kind: "fluid", id: "water" }),
        },
        { kind: "fluid", id: "water", displayName: "Water" },
      );

      // The second machine wants a different resource, so the card lets go of
      // dust and adopts water: one wire, to the machine that asked last.
      expect(useFactoryStore.getState().project.edges).toEqual([
        expect.objectContaining({ source: card, target: "fluid-target", resourceId: "water" }),
      ]);

      // Now the same resource to a second taker: that is a second real wire.
      useFactoryStore.getState().connectCustomRate(
        card,
        "output",
        {
          nodeId: "water-tank",
          handleId: makeResourceHandleId("input", { kind: "fluid", id: "water" }),
        },
        { kind: "fluid", id: "water", displayName: "Water" },
      );
      expect(
        useFactoryStore
          .getState()
          .project.edges.map((edge) => `${edge.source}->${edge.target}`)
          .sort(),
      ).toEqual([`${card}->fluid-target`, `${card}->water-tank`]);
    });

    it("drops the old wire when the card is handed a different resource", () => {
      const card = addCard();

      wireSupplyIntoTarget(card);
      useFactoryStore.getState().connectCustomRate(
        card,
        "input",
        {
          nodeId: "item-source",
          handleId: makeResourceHandleId("output", { kind: "item", id: "dust" }),
        },
        { kind: "item", id: "dust", displayName: "Dust" },
      );

      // Flipping the card from supply to request turns the line around rather
      // than leaving both directions wired.
      expect(useFactoryStore.getState().project.edges).toEqual([
        expect.objectContaining({ source: "item-source", target: card, resourceId: "dust" }),
      ]);
    });
  });

  it("removes an orphan drawer or tank when its last edge is deleted", () => {
    useFactoryStore.getState().connectNodes("fluid-source", "water-tank", {
      kind: "fluid",
      id: "water",
      sourceHandle: makeResourceHandleId("output", { kind: "fluid", id: "water" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "water" }),
    });
    const edgeId = useFactoryStore.getState().project.edges[0]?.id;
    expect(useFactoryStore.getState().project.storages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "water-tank" })]),
    );

    useFactoryStore.getState().deleteEdge(edgeId);

    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
    expect(useFactoryStore.getState().project.storages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "water-tank" })]),
    );
  });

  it("keeps a pool-made product drawer through other edits and the trip back to build", () => {
    useFactoryStore.getState().setBoardMode("pool");
    useFactoryStore.getState().addStorageForConnection(
      { kind: "item", id: "dust", displayName: "Dust" },
      "item-source",
      "output",
      { x: 600, y: 300 },
      makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
    );
    const drawer = useFactoryStore
      .getState()
      .project.storages?.find((storage) => storage.poolSide === "drain");
    expect(drawer).toBeDefined();
    expect(useFactoryStore.getState().project.edges).toHaveLength(0);

    // Any edit on any card used to sweep it as an orphan: it has no wires,
    // because in pool mode the declared side is the whole link.
    useFactoryStore.getState().updateNode("item-target", { overclockTier: "HV" });
    expect(useFactoryStore.getState().project.storages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: drawer!.id, poolSide: "drain" })]),
    );

    // Back in build or solve it lingers as the product it was made as.
    useFactoryStore.getState().setBoardMode("solve");
    expect(useFactoryStore.getState().project.storages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: drawer!.id })]),
    );
    expect(getStorageRole(useFactoryStore.getState().project, drawer!.id)).toBe("product");

    const { nodes, recipes, edges, storages, productionGroups, poolResourceRules } = useFactoryStore.getState().project;
    for (const mode of ["build", "pool", "solve", "pool"] as const) {
      useFactoryStore.getState().setBoardMode(mode);
      expect(useFactoryStore.getState().project).toMatchObject({ nodes, recipes, edges, storages });
      expect(useFactoryStore.getState().project.productionGroups).toEqual(productionGroups);
      expect(useFactoryStore.getState().project.poolResourceRules).toEqual(poolResourceRules);
    }
  });

  it("migrates a stored recipe to its content match and moves the node onto the new id", () => {
    const before = useFactoryStore.getState().project;
    const stored = before.recipes.find((recipe) => recipe.id === "item-recipe") ?? before.recipes[0]!;
    const node = before.nodes.find((entry) => entry.recipeId === stored.id)!;
    const rekeyed = { ...stored, id: stored.id + "-content", machineHandlers: [{ id: "fam", label: "Fam", machineType: "Fam", minimumTier: "LV", maximumTier: "HV" }] };
    useFactoryStore.getState().refreshProjectRecipes([rekeyed], { [stored.id]: rekeyed.id });
    const after = useFactoryStore.getState().project;
    expect(after.recipes.some((recipe) => recipe.id === rekeyed.id)).toBe(true);
    expect(after.recipes.some((recipe) => recipe.id === stored.id)).toBe(false);
    expect(after.nodes.find((entry) => entry.id === node.id)?.recipeId).toBe(rekeyed.id);
    expect(after.recipes.find((recipe) => recipe.id === rekeyed.id)?.machineHandlers?.[0]?.maximumTier).toBe("HV");
  });

  it("keeps the machine a game recipe names when the dataset's body lacks it", () => {
    const before = useFactoryStore.getState().project;
    const original = before.recipes.find((recipe) => recipe.id === "item-recipe") ?? before.recipes[0]!;
    const node = before.nodes.find((entry) => entry.recipeId === original.id)!;
    // The game writes its card's recipe under its own id with the housing it runs in first (the plain Apiary).
    const apiary = { id: "apiary", label: "Apiary", machineType: "Apiary", minimumTier: "LV", maximumTier: "LV" };
    const magic = { id: "magic-apiary", label: "Magic Apiary", machineType: "Magic Apiary", minimumTier: "LV", maximumTier: "LV" };
    const game = { ...original, id: `gtnhplanner:${node.id}`, machineHandlers: [apiary] };
    useFactoryStore.getState().setProject({
      ...before,
      recipes: [...before.recipes.filter((recipe) => recipe.id !== original.id), game],
      nodes: before.nodes.map((entry) =>
        entry.id === node.id ? { ...entry, recipeId: game.id, machineHandlerId: "apiary" } : entry,
      ),
    });
    const dataset = { ...original, id: "dataset-bee", machineHandlers: [magic] };
    useFactoryStore.getState().refreshProjectRecipes([dataset], { [game.id]: dataset.id });
    const after = useFactoryStore.getState().project;
    const card = after.nodes.find((entry) => entry.id === node.id)!;
    expect(card.recipeId).toBe("dataset-bee");
    expect(card.machineHandlerId).toBe("apiary");
    expect(after.recipes.find((recipe) => recipe.id === "dataset-bee")?.machineHandlers?.map((h) => h.id)).toEqual([
      "apiary",
      "magic-apiary",
    ]);
  });

  it("undoes and redoes structural project edits", () => {
    useFactoryStore.getState().connectNodes("item-source", "item-target", {
      kind: "item",
      id: "dust",
      sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
    });
    expect(useFactoryStore.getState().project.edges).toHaveLength(1);

    useFactoryStore.getState().undo();
    expect(useFactoryStore.getState().project.edges).toHaveLength(0);

    useFactoryStore.getState().redo();
    expect(useFactoryStore.getState().project.edges).toHaveLength(1);
  });

  it("clears redo history after a new edit", () => {
    useFactoryStore.getState().updateNode("item-source", { machineCount: 4 });
    useFactoryStore.getState().undo();
    expect(useFactoryStore.getState().redoHistory).toHaveLength(1);

    useFactoryStore.getState().updateNode("item-source", { overclockTier: "HV" });

    expect(useFactoryStore.getState().redoHistory).toHaveLength(0);
    expect(
      useFactoryStore.getState().project.nodes.find((node) => node.id === "item-source")
        ?.overclockTier,
    ).toBe("HV");
  });

  it("removes storage links when a node is changed to a recipe that no longer references it", () => {
    useFactoryStore.getState().connectNodes("fluid-source", "water-tank", {
      kind: "fluid",
      id: "water",
      sourceHandle: makeResourceHandleId("output", { kind: "fluid", id: "water" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "water" }),
    });

    useFactoryStore.getState().updateNode("fluid-source", { recipeId: "item-source-recipe" });

    expect(useFactoryStore.getState().project.edges).toHaveLength(0);
    expect(useFactoryStore.getState().project.storages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "water-tank" })]),
    );
  });

  it("links a sodium to NaK coolant fluid chain without creating storage", () => {
    useFactoryStore.getState().setProject(createNakCoolantProject());

    useFactoryStore.getState().connectNodes("fluid-heater", "distillery", {
      kind: "fluid",
      id: "liquid_sodium",
      sourceHandle: makeResourceHandleId("output", { kind: "fluid", id: "liquid_sodium" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "liquid_sodium" }, 1),
    });
    useFactoryStore.getState().connectNodes("distillery", "fluid-canner", {
      kind: "fluid",
      id: "sodium_potassium",
      sourceHandle: makeResourceHandleId("output", { kind: "fluid", id: "sodium_potassium" }, 0),
      targetHandle: makeResourceHandleId("input", { kind: "fluid", id: "sodium_potassium" }, 1),
    });

    expect(useFactoryStore.getState().project.storages).toHaveLength(0);
    expect(useFactoryStore.getState().project.edges).toEqual([
      expect.objectContaining({
        source: "fluid-heater",
        target: "distillery",
        resourceKind: "fluid",
        resourceId: "liquid_sodium",
      }),
      expect.objectContaining({
        source: "distillery",
        target: "fluid-canner",
        resourceKind: "fluid",
        resourceId: "sodium_potassium",
      }),
    ]);
  });
});

describe("project recipe refresh", () => {
  it("replaces stale machine handlers from the loaded dataset recipe", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "refresh-test",
      name: "Refresh test",
      fuelProfiles: [],
      recipes: [
        {
          id: "fluid-extractor-recipe",
          name: "Fluid Extractor: Charcoal",
          machineType: "Fluid Extractor",
          minimumTier: "LV",
          durationTicks: 30,
          eut: 16,
          inputs: [{ kind: "item", id: "minecraft:coal@1", amount: 1 }],
          outputs: [{ kind: "fluid", id: "woodtar", amount: 100 }],
          machineHandlers: [
            {
              id: "nei-catalyst-basic-fluid-extractor",
              label: "Basic Fluid Extractor",
              machineType: "Basic Fluid Extractor",
              minimumTier: "LV",
              kind: "single",
            },
          ],
        },
      ],
      nodes: [
        {
          id: "node-1",
          recipeId: "fluid-extractor-recipe",
          machineCount: 1,
          parallel: 1,
          overclockTier: "LV",
          machineHandlerId: "nei-catalyst-basic-fluid-extractor",
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().refreshProjectRecipes([
      {
        id: "fluid-extractor-recipe",
        name: "Fluid Extractor: Charcoal",
        machineType: "Fluid Extractor",
        minimumTier: "LV",
        durationTicks: 30,
        eut: 16,
        inputs: [{ kind: "item", id: "minecraft:coal@1", amount: 1 }],
        outputs: [{ kind: "fluid", id: "woodtar", amount: 100 }],
      },
    ]);

    expect(useFactoryStore.getState().project.recipes[0]?.machineHandlers).toBeUndefined();
    expect(useFactoryStore.getState().project.nodes[0]?.machineHandlerId).toBeUndefined();
  });

  it("moves a legacy concrete ore dictionary input from the recipe to the node", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "refresh-context-test",
      name: "Refresh context test",
      fuelProfiles: [],
      recipes: [
        {
          id: "coke-oven-log",
          name: "Coke Oven: Charcoal",
          machineType: "Coke Oven",
          minimumTier: "MV",
          durationTicks: 256,
          eut: 96,
          inputs: [
            {
              kind: "item",
              id: "minecraft:log@1",
              amount: 16,
              displayName: "Spruce Log",
            },
          ],
          outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
        },
      ],
      nodes: [
        {
          id: "node-1",
          recipeId: "coke-oven-log",
          machineCount: 1,
          parallel: 1,
          overclockTier: "MV",
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().refreshProjectRecipes([
      {
        id: "coke-oven-log",
        name: "Coke Oven: Charcoal",
        machineType: "Coke Oven",
        minimumTier: "MV",
        durationTicks: 256,
        eut: 96,
        inputs: [
          {
            kind: "item",
            id: "oredict:logWood",
            amount: 16,
            displayName: "Oak Log",
            alternatives: [{ kind: "item", id: "minecraft:log@1" }],
          },
        ],
        outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
      },
    ]);

    expect(useFactoryStore.getState().project.recipes[0]?.inputs[0]).toEqual(
      expect.objectContaining({
        id: "oredict:logWood",
        alternatives: [{ kind: "item", id: "minecraft:log@1" }],
      }),
    );
    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        id: "minecraft:log@1",
        displayName: "Spruce Log",
        alternatives: undefined,
      }),
    );
  });

  it("keeps the shared recipe generic when adding a concrete uses node", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "add-context-test",
      name: "Add context test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });

    useFactoryStore.getState().addNodeForRecipeObject(
      {
        id: "coke-oven-log",
        name: "Coke Oven: Charcoal",
        machineType: "Coke Oven",
        minimumTier: "MV",
        durationTicks: 256,
        eut: 96,
        inputs: [
          {
            kind: "item",
            id: "oredict:logWood",
            amount: 16,
            displayName: "Ore Dictionary: logWood",
            alternatives: [
              { kind: "item", id: "minecraft:log@0", displayName: "Oak Log" },
              { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" },
            ],
          },
        ],
        outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
      },
      { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log", mode: "uses" },
    );

    expect(useFactoryStore.getState().project.recipes[0]?.inputs[0]).toEqual(
      expect.objectContaining({
        id: "oredict:logWood",
        displayName: "Ore Dictionary: logWood",
      }),
    );
    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        id: "minecraft:log@1",
        displayName: "Spruce Log",
        alternatives: undefined,
      }),
    );
  });

  it("keeps an input's own face when it is the context item itself, so NBT variants stay apart", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "add-context-nbt-test",
      name: "Add context NBT test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });

    useFactoryStore.getState().addNodeForRecipeObject(
      {
        id: "orange-box",
        name: "Shapeless Crafting: Orange Shulker Box",
        machineType: "Shapeless Crafting",
        minimumTier: "NONE",
        durationTicks: 1,
        eut: 0,
        inputs: [{ kind: "item", id: "etfuturum:shulker_box", amount: 1, displayName: "Shulker Box", iconPath: "box.png" }],
        outputs: [{ kind: "item", id: "etfuturum:shulker_box", amount: 1, displayName: "Orange Shulker Box" }],
      },
      // The catalog entry the player browsed is named after the first colour.
      { kind: "item", id: "etfuturum:shulker_box", displayName: "White Shulker Box", iconPath: "white.png", mode: "recipes" },
    );

    // The context matches the input, so an override is always written; it must carry the slot's own face.
    const override = useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["0"];
    expect(override).toMatchObject({ displayName: "Shulker Box", iconPath: "box.png" });
  });

  it("stores concrete input context even when the browser mode is not uses", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "add-context-mode-test",
      name: "Add context mode test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });

    useFactoryStore.getState().addNodeForRecipeObject(
      {
        id: "coke-oven-log",
        name: "Coke Oven: Charcoal",
        machineType: "Coke Oven",
        minimumTier: "MV",
        durationTicks: 256,
        eut: 96,
        inputs: [
          {
            kind: "item",
            id: "oredict:logWood",
            amount: 16,
            displayName: "Ore Dictionary: logWood",
            alternatives: [
              { kind: "item", id: "minecraft:log@0", displayName: "Oak Log" },
              { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" },
            ],
          },
        ],
        outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
      },
      { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log", mode: "recipes" },
    );

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        id: "minecraft:log@1",
        displayName: "Spruce Log",
        alternatives: undefined,
      }),
    );
  });

  it("never fills an input with the product a makes-search was for", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "add-context-self-loop-test",
      name: "Add context self loop test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });

    // Picked from what makes Distilled Water, with a Water slot that also
    // lists Distilled Water: the card makes it from Water.
    useFactoryStore.getState().addNodeForRecipeObject(
      {
        id: "distillery-distilled-water",
        name: "Distillery: Distilled Water",
        machineType: "Distillery",
        minimumTier: "ULV",
        durationTicks: 25,
        eut: 7,
        inputs: [
          {
            kind: "fluid",
            id: "water",
            amount: 10,
            displayName: "Water",
            alternatives: [
              { kind: "fluid", id: "water", displayName: "Water", amount: 1 },
              { kind: "fluid", id: "ic2distilledwater", displayName: "Distilled Water", amount: 1 },
            ],
          },
        ],
        outputs: [{ kind: "fluid", id: "ic2distilledwater", amount: 10, displayName: "Distilled Water" }],
      },
      { kind: "fluid", id: "ic2distilledwater", displayName: "Distilled Water", mode: "recipes" },
    );

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides).toBeUndefined();
  });

  describe("a substitute the refreshed recipe no longer offers", () => {
    const solder = { kind: "fluid", id: "molten.solderingalloy", displayName: "Molten Soldering Alloy" } as const;
    const tin = { kind: "fluid", id: "molten.tin", displayName: "Molten Tin" } as const;
    const lead = { kind: "fluid", id: "molten.lead", displayName: "Molten Lead" } as const;
    const substitutes = [{ ...solder, amount: 1 }, { ...tin, amount: 2 }, { ...lead, amount: 4 }];
    const solderRecipe = (id: string, offered: boolean, slot: { kind: "fluid"; id: string; displayName: string } = solder) => ({
      id,
      name: id === "solidifier" ? "Fluid Solidifier: Solder Ingot" : id === "tin-ingot" ? "Fluid Solidifier: Tin Ingot" : "Assembler: Circuit",
      machineType: id === "assembler" ? "Assembler" : "Fluid Solidifier",
      minimumTier: "LV",
      durationTicks: 20,
      eut: 8,
      inputs: [{ ...slot, amount: 144, alternatives: offered ? substitutes : undefined }],
      outputs: [{ kind: "item" as const, id: `${id}-out`, amount: 1 }],
    });
    const node = (id: string) => ({
      id,
      recipeId: id,
      machineCount: 1,
      parallel: 1,
      overclockTier: "LV",
      enabled: true,
      position: { x: 0, y: 0 },
      recipeInputOverrides: { "0": { ...tin, amount: 288 } },
    });
    const wire = (target: string) => ({
      id: `tin-${target}`,
      source: "drawer",
      target,
      sourceHandle: "output:fluid:molten.tin",
      targetHandle: "input:fluid:molten.tin",
      resourceKind: "fluid" as const,
      resourceId: "molten.tin",
    });
    function landSolderPlan() {
      useFactoryStore.getState().setProject({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: "revoked-substitute-test",
        name: "Revoked substitute test",
        fuelProfiles: [],
        // Saved when the dataset gave every solder slot the Assembler's substitutes.
        recipes: [solderRecipe("solidifier", true), solderRecipe("assembler", true)],
        nodes: [node("solidifier"), node("assembler")],
        storages: [{ id: "drawer", kind: "fluid", resourceId: "molten.tin", position: { x: -400, y: 0 } }],
        edges: [wire("solidifier"), wire("assembler")],
      });
      useFactoryStore.getState().dismissPlanNotice();
      // The rebuilt dataset keeps the Assembler's own substitutes and gives the solidifier's slot none.
      return useFactoryStore.getState().refreshProjectRecipes([solderRecipe("solidifier", false), solderRecipe("assembler", true)]);
    }

    it("is reported, and the refresh changes neither the pick nor the wire", () => {
      const { revoked } = landSolderPlan();

      expect(revoked.map((entry) => [entry.nodeId, entry.slot, entry.pick.id])).toEqual([["solidifier", 0, "molten.tin"]]);
      const { nodes, edges } = useFactoryStore.getState().project;
      expect(nodes.find((entry) => entry.id === "solidifier")?.recipeInputOverrides?.["0"]?.id).toBe("molten.tin");
      expect(edges.map((edge) => edge.id).sort()).toEqual(["tin-assembler", "tin-solidifier"]);
    });

    it("keeps the card's stored body until it is settled, then lands the fresh one", () => {
      const { revoked, deferred } = landSolderPlan();
      const stored = () =>
        useFactoryStore.getState().project.recipes.find((recipe) => recipe.id === "solidifier")?.inputs[0]?.alternatives;
      // The stored body is the evidence: a lookup that fails leaves it for the next landing to find again.
      expect(stored()?.map((entry) => entry.id)).toEqual(["molten.solderingalloy", "molten.tin", "molten.lead"]);
      expect(deferred.map((recipe) => recipe.id)).toEqual(["solidifier"]);

      useFactoryStore.getState().settleRevokedSubstitutes(revoked.map((entry) => ({ revoked: entry })), deferred);

      expect(stored()).toBeUndefined();
      expect(useFactoryStore.getState().planNotice?.details).toHaveLength(1);
    });

    it("leaves a card with no twin as it is and names it in the plan notice", () => {
      const { revoked, deferred } = landSolderPlan();
      useFactoryStore.getState().settleRevokedSubstitutes(revoked.map((entry) => ({ revoked: entry })), deferred);

      const state = useFactoryStore.getState();
      expect(state.project.nodes.find((entry) => entry.id === "solidifier")?.recipeInputOverrides?.["0"]?.id).toBe(
        "molten.tin",
      );
      expect(state.project.edges).toHaveLength(2);
      expect(state.planNotice).toEqual({
        origin: "plan",
        text: "Some cards used an input the game does not accept there.",
        details: [
          "Fluid Solidifier: Solder Ingot takes Molten Tin in place of Molten Soldering Alloy. The game does not accept that.",
        ],
      });
    });

    it("moves a card onto the recipe that takes its pick, wire kept, as one undoable edit", () => {
      const { revoked } = landSolderPlan();
      const twin = { ...solderRecipe("tin-ingot", false, tin), inputs: [{ ...tin, amount: 288 }] };
      useFactoryStore.getState().settleRevokedSubstitutes(revoked.map((entry) => ({ revoked: entry, twin })));

      const state = useFactoryStore.getState();
      const card = state.project.nodes.find((entry) => entry.id === "solidifier");
      expect(card?.recipeId).toBe("tin-ingot");
      // The carried wire names the twin's own slot resource, nothing else.
      expect(card?.recipeInputOverrides?.["0"]?.id ?? "molten.tin").toBe("molten.tin");
      expect(state.project.edges.find((edge) => edge.id === "tin-solidifier")?.targetHandle).toContain("molten.tin");
      expect(state.planNotice?.details).toEqual([
        "Fluid Solidifier: Solder Ingot now runs the recipe that takes Molten Tin. Its wires stay.",
      ]);
      state.undo();
      expect(useFactoryStore.getState().project.nodes.find((entry) => entry.id === "solidifier")?.recipeId).toBe(
        "solidifier",
      );
    });

    it("moves a card without selecting it, keeping a pick the twin's slot still takes", () => {
      const plate = { kind: "item", id: "oredict:plateTin", displayName: "Ore Dictionary: plateTin" } as const;
      const concrete = { kind: "item", id: "gregtech:tin-plate", displayName: "Tin Plate", amount: 1 } as const;
      const withPlate = (recipe: ReturnType<typeof solderRecipe>) => ({
        ...recipe,
        inputs: [...recipe.inputs, { ...plate, amount: 1, alternatives: [concrete] }],
      });
      useFactoryStore.getState().setProject({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: "twin-picks-test",
        name: "Twin picks test",
        fuelProfiles: [],
        recipes: [withPlate(solderRecipe("solidifier", true))],
        nodes: [{ ...node("solidifier"), recipeInputOverrides: { "0": { ...tin, amount: 288 }, "1": concrete } }],
        edges: [],
      });
      useFactoryStore.getState().selectNode(undefined);
      const { revoked } = useFactoryStore.getState().refreshProjectRecipes([withPlate(solderRecipe("solidifier", false))]);
      const twin = withPlate({ ...solderRecipe("tin-ingot", false, tin), inputs: [{ ...tin, amount: 288, alternatives: undefined }] });
      useFactoryStore.getState().settleRevokedSubstitutes(revoked.map((entry) => ({ revoked: entry, twin })));

      const state = useFactoryStore.getState();
      const card = state.project.nodes.find((entry) => entry.id === "solidifier");
      expect(card?.recipeId).toBe("tin-ingot");
      expect(card?.recipeInputOverrides?.["1"]?.id).toBe("gregtech:tin-plate");
      expect(state.selectedNodeId).toBeUndefined();
    });

    for (const waits of ["own recipe", "extra section"] as const) {
      it(`keeps a migrated sibling's new id while the card's ${waits} waits`, () => {
        // One section holds a revoked Tin pick; the other's recipe is re-keyed in the same refresh.
        const named = (id: string, offered: boolean, out = `${id}-out`) => ({ ...solderRecipe(id, offered), id, outputs: [{ kind: "item" as const, id: out, amount: 1 }] });
        const pick = { "0": { ...tin, amount: 288 } };
        const own = waits === "own recipe";
        useFactoryStore.getState().setProject({
          schemaVersion: PROJECT_SCHEMA_VERSION,
          id: "deferred-sections-test",
          name: "Deferred sections test",
          fuelProfiles: [],
          recipes: [named("a", true), named(own ? "old-b" : "old-a", false, "b-out")],
          nodes: [
            {
              ...node("n"),
              recipeId: own ? "a" : "old-a",
              recipeInputOverrides: own ? pick : undefined,
              extraRecipes: [{ recipeId: own ? "old-b" : "a", ...(own ? {} : { recipeInputOverrides: pick }) }],
            },
          ],
          edges: [],
        });
        const migrated: Record<string, string> = own ? { "old-b": "new-b" } : { "old-a": "new-a" };
        const { revoked, deferred } = useFactoryStore
          .getState()
          .refreshProjectRecipes([named("a", false), named(own ? "new-b" : "new-a", false, "b-out")], migrated);

        const check = () => {
          const { project } = useFactoryStore.getState();
          const ids = new Set(project.recipes.map((recipe) => recipe.id));
          const card = project.nodes[0]!;
          expect([card.recipeId, ...(card.extraRecipes ?? []).map((extra) => extra.recipeId)].every((id) => ids.has(id))).toBe(true);
          expect(card.recipeId).toBe(own ? "a" : "new-a");
          expect(card.extraRecipes?.[0]?.recipeId).toBe(own ? "new-b" : "a");
        };
        expect(revoked.map((entry) => entry.section)).toEqual([own ? 0 : 1]);
        check();
        // The waiting section still holds its pick until it is settled.
        const card = useFactoryStore.getState().project.nodes[0]!;
        expect((own ? card.recipeInputOverrides : card.extraRecipes?.[0]?.recipeInputOverrides)?.["0"]?.id).toBe("molten.tin");

        useFactoryStore.getState().settleRevokedSubstitutes(revoked.map((entry) => ({ revoked: entry })), deferred);
        check();
      });
    }

    it("skips a card that changed before its twin arrived", () => {
      const { revoked } = landSolderPlan();
      useFactoryStore.getState().updateNode("solidifier", { recipeInputOverrides: undefined });
      useFactoryStore.getState().settleRevokedSubstitutes(revoked.map((entry) => ({ revoked: entry })));

      expect(useFactoryStore.getState().planNotice).toBeNull();
    });
  });

  describe("a card saved on a steam multiblock that cannot take its fluid", () => {
    const handler = (label: string, kind: "single" | "multiblock") => ({
      id: label.toLowerCase().replace(/ /g, "-"),
      label,
      machineType: label,
      minimumTier: "LV",
      kind,
    });
    const centrifuge = (handlers: string[]) => ({
      id: "lava",
      name: "Centrifuge: Silicon Dioxide Dust",
      machineType: "Centrifuge",
      minimumTier: "LV",
      durationTicks: 20,
      eut: 8,
      inputs: [{ kind: "fluid" as const, id: "lava", amount: 100 }],
      outputs: [{ kind: "item" as const, id: "sio2", amount: 1 }],
      machineHandlers: handlers.map((label) => handler(label, label === "Centrifuge" ? "single" : "multiblock")),
    });
    function land(stored: string[]) {
      useFactoryStore.getState().setProject({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: "steam-card-test",
        name: "Steam card test",
        fuelProfiles: [],
        recipes: [centrifuge(stored)],
        nodes: [
          {
            id: "c",
            recipeId: "lava",
            machineCount: 1,
            parallel: 1,
            overclockTier: "LV",
            machineHandlerId: "steam-separator",
            enabled: true,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });
      useFactoryStore.getState().dismissPlanNotice();
    }
    const line = "Centrifuge: Silicon Dioxide Dust now runs on the Centrifuge: the Steam Separator has no fluid input hatch.";

    it("says where it went when the refreshed recipe still lists it", () => {
      land(["Centrifuge", "Steam Separator"]);
      useFactoryStore.getState().refreshProjectRecipes([centrifuge(["Centrifuge", "Steam Separator"])]);

      const state = useFactoryStore.getState();
      expect(state.project.nodes[0]?.machineHandlerId).toBeUndefined();
      expect(state.planNotice).toEqual({
        origin: "plan",
        text: "Some cards moved off a steam machine that has no hatch for their fluid.",
        details: [line],
      });
    });

    it("says where it went when the dataset no longer lists it", () => {
      land(["Centrifuge", "Steam Separator"]);
      useFactoryStore.getState().refreshProjectRecipes([centrifuge(["Centrifuge"])]);

      expect(useFactoryStore.getState().planNotice?.details).toEqual([line]);
    });

    it("names the hatch a 2.8.1 Squasher or a Presser lacks", () => {
      const hammer = (handlers: string[], fluid: "input" | "output") => ({
        id: "hammer",
        name: "Forge Hammer: Plate",
        machineType: "Forge Hammer",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 8,
        inputs: [{ kind: "item" as const, id: "ingot", amount: 1 }, ...(fluid === "input" ? [{ kind: "fluid" as const, id: "lubricant", amount: 10 }] : [])],
        outputs: [{ kind: "item" as const, id: "plate", amount: 1 }, ...(fluid === "output" ? [{ kind: "fluid" as const, id: "molten", amount: 10 }] : [])],
        machineHandlers: handlers.map((label) => handler(label, label === "Forge Hammer" ? "single" : "multiblock")),
      });
      for (const fluid of ["input", "output"] as const) {
        useFactoryStore.getState().setProject({
          schemaVersion: PROJECT_SCHEMA_VERSION,
          id: `hammer-${fluid}`,
          name: "Hammer",
          fuelProfiles: [],
          recipes: [hammer(["Forge Hammer", "Steam Presser"], fluid)],
          nodes: [{ id: "h", recipeId: "hammer", machineCount: 1, parallel: 1, overclockTier: "LV", machineHandlerId: "steam-presser", enabled: true, position: { x: 0, y: 0 } }],
          edges: [],
        });
        useFactoryStore.getState().dismissPlanNotice();
        // 2.8.1's pipeline drops the Presser from a fluid-input recipe; both packs drop it from a fluid output.
        useFactoryStore.getState().refreshProjectRecipes([hammer(["Forge Hammer"], fluid)]);

        expect(useFactoryStore.getState().planNotice?.details).toEqual([
          `Forge Hammer: Plate now runs on the Forge Hammer: the Steam Presser has no fluid ${fluid} hatch.`,
        ]);
      }
    });
  });

  it("keeps every substitute while the refreshed recipe still offers it", () => {
    const water = { kind: "fluid", id: "water", displayName: "Water" } as const;
    const distilled = { kind: "fluid", id: "ic2distilledwater", displayName: "Distilled Water" } as const;
    const cutter = {
      id: "cutter",
      name: "Cutting Machine: Plank",
      machineType: "Cutting Machine",
      minimumTier: "LV",
      durationTicks: 20,
      eut: 8,
      inputs: [{ ...water, amount: 4, alternatives: [{ ...water, amount: 1 }, { ...distilled, amount: 1 }] }],
      outputs: [{ kind: "item" as const, id: "plank", amount: 1 }],
    };
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "kept-substitute-test",
      name: "Kept substitute test",
      fuelProfiles: [],
      recipes: [cutter],
      nodes: [
        {
          id: "cutter",
          recipeId: "cutter",
          machineCount: 1,
          parallel: 1,
          overclockTier: "LV",
          enabled: true,
          position: { x: 0, y: 0 },
          recipeInputOverrides: { "0": { ...distilled, amount: 4 } },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().refreshProjectRecipes([{ ...cutter }]);

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["0"]?.id).toBe("ic2distilledwater");
  });

  it("stores concrete uses inputs on connected recipe nodes", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "connected-context-test",
      name: "Connected context test",
      fuelProfiles: [],
      recipes: [
        {
          id: "drawer-source",
          name: "Drawer",
          machineType: "Drawer",
          minimumTier: "NONE",
          durationTicks: 20,
          eut: 0,
          inputs: [],
          outputs: [{ kind: "item", id: "minecraft:log@1", amount: 1, displayName: "Spruce Log" }],
        },
      ],
      nodes: [
        {
          id: "source-node",
          recipeId: "drawer-source",
          machineCount: 1,
          parallel: 1,
          overclockTier: "NONE",
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().addConnectedNodeForRecipeObject(
      {
        id: "coke-oven-log",
        name: "Coke Oven: Charcoal",
        machineType: "Coke Oven",
        minimumTier: "MV",
        durationTicks: 256,
        eut: 96,
        inputs: [
          {
            kind: "item",
            id: "minecraft:log@1",
            amount: 16,
            displayName: "Spruce Log",
          },
        ],
        outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
      },
      "source-node",
      { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log", mode: "uses" },
    );

    const node = useFactoryStore
      .getState()
      .project.nodes.find((entry) => entry.recipeId === "coke-oven-log");

    expect(node?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        id: "minecraft:log@1",
        displayName: "Spruce Log",
        alternatives: undefined,
      }),
    );
  });

  it("stores concrete uses inputs when the recipe input is an ore dictionary alternative", () => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "connected-oredict-context-test",
      name: "Connected oredict context test",
      fuelProfiles: [],
      recipes: [
        {
          id: "drawer-source",
          name: "Drawer",
          machineType: "Drawer",
          minimumTier: "NONE",
          durationTicks: 20,
          eut: 0,
          inputs: [],
          outputs: [{ kind: "item", id: "minecraft:log@1", amount: 1, displayName: "Spruce Log" }],
        },
      ],
      nodes: [
        {
          id: "source-node",
          recipeId: "drawer-source",
          machineCount: 1,
          parallel: 1,
          overclockTier: "NONE",
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });

    useFactoryStore.getState().addConnectedNodeForRecipeObject(
      {
        id: "coke-oven-log",
        name: "Coke Oven: Charcoal",
        machineType: "Coke Oven",
        minimumTier: "MV",
        durationTicks: 256,
        eut: 96,
        inputs: [
          {
            kind: "item",
            id: "oredict:logWood",
            amount: 16,
            displayName: "Ore Dictionary: logWood",
            alternatives: [
              { kind: "item", id: "minecraft:log@0", displayName: "Oak Log" },
              { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" },
            ],
          },
        ],
        outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20 }],
      },
      "source-node",
      { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log", mode: "uses" },
    );

    const node = useFactoryStore
      .getState()
      .project.nodes.find((entry) => entry.recipeId === "coke-oven-log");

    expect(node?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        kind: "item",
        id: "minecraft:log@1",
        displayName: "Spruce Log",
        alternatives: undefined,
      }),
    );
  });
});

describe("recipe search wiring and refactor", () => {
  const REFACTOR_PROJECT = (): FactoryProject => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "refactor-test",
    name: "Refactor test",
    fuelProfiles: [],
    recipes: [
      {
        id: "ore-source",
        name: "Ore drawer",
        machineType: "Drawer",
        minimumTier: "NONE" as const,
        durationTicks: 20,
        eut: 0,
        inputs: [],
        outputs: [{ kind: "item" as const, id: "ore", amount: 1 }],
      },
      {
        id: "macerator",
        name: "Macerate",
        machineType: "Macerator",
        minimumTier: "LV" as const,
        durationTicks: 40,
        eut: 8,
        inputs: [
          { kind: "item" as const, id: "ore", amount: 1 },
          { kind: "item" as const, id: "lube", amount: 1 },
        ],
        outputs: [{ kind: "item" as const, id: "dust", amount: 2 }],
      },
      {
        id: "dust-eater",
        name: "Press",
        machineType: "Press",
        minimumTier: "LV" as const,
        durationTicks: 40,
        eut: 8,
        inputs: [{ kind: "item" as const, id: "dust", amount: 1 }],
        outputs: [{ kind: "item" as const, id: "plate", amount: 1 }],
      },
    ],
    nodes: [
      {
        id: "src",
        recipeId: "ore-source",
        machineCount: 1,
        parallel: 1,
        overclockTier: "NONE" as const,
        enabled: true,
        position: { x: 0, y: 0 },
      },
      {
        id: "mid",
        recipeId: "macerator",
        machineCount: 1,
        parallel: 1,
        overclockTier: "LV" as const,
        enabled: true,
        position: { x: 440, y: 0 },
      },
      {
        id: "sink",
        recipeId: "dust-eater",
        machineCount: 1,
        parallel: 1,
        overclockTier: "LV" as const,
        enabled: true,
        position: { x: 880, y: 0 },
      },
    ],
    edges: [
      {
        id: "e-ore",
        source: "src",
        target: "mid",
        resourceKind: "item" as const,
        resourceId: "ore",
      },
      {
        id: "e-dust",
        source: "mid",
        target: "sink",
        resourceKind: "item" as const,
        resourceId: "dust",
      },
    ],
  });

  it("wires a consumer added from a port browse to its anchor", () => {
    useFactoryStore.getState().setProject(REFACTOR_PROJECT());

    useFactoryStore.getState().addConnectedNodeForRecipeObject(
      {
        id: "washer",
        name: "Wash ore",
        machineType: "Ore Washer",
        minimumTier: "LV",
        durationTicks: 40,
        eut: 16,
        inputs: [{ kind: "item", id: "ore", amount: 1 }],
        outputs: [{ kind: "item", id: "clean-ore", amount: 1 }],
      },
      "src",
      { kind: "item", id: "ore", mode: "uses" },
    );

    const state = useFactoryStore.getState();
    const washer = state.project.nodes.find((entry) => entry.recipeId === "washer");
    expect(washer).toBeDefined();
    const wire = state.project.edges.find(
      (edge) => edge.source === "src" && edge.target === washer?.id,
    );
    expect(wire?.resourceId).toBe("ore");
    // A consumer stands downstream of its anchor.
    expect(washer!.position.x).toBeGreaterThan(0);
  });

  it("replaces a refactored card in place and carries the wires that still fit", () => {
    useFactoryStore.getState().setProject(REFACTOR_PROJECT());

    useFactoryStore.getState().refactorNodeWithRecipe("mid", {
      id: "wet-macerator",
      name: "Wet macerate",
      machineType: "Wet Macerator",
      minimumTier: "MV",
      durationTicks: 30,
      eut: 32,
      inputs: [
        { kind: "item", id: "ore", amount: 1 },
        { kind: "fluid", id: "water", amount: 100 },
      ],
      outputs: [{ kind: "item", id: "dust", amount: 3 }],
    });

    const state = useFactoryStore.getState();
    const mid = state.project.nodes.find((entry) => entry.id === "mid");
    expect(mid?.recipeId).toBe("wet-macerator");
    // Both wires still have ports on the new recipe, so both survive, and the
    // card itself never moved.
    expect(state.project.edges.map((edge) => edge.id).sort()).toEqual(["e-dust", "e-ore"]);
    expect(mid?.position).toEqual({ x: 440, y: 0 });
  });

  it("drops only the wires the new recipe cannot serve", () => {
    const project = REFACTOR_PROJECT();
    project.edges.push({
      id: "e-lube",
      source: "src",
      target: "mid",
      resourceKind: "item",
      resourceId: "lube",
    });
    useFactoryStore.getState().setProject(project);

    useFactoryStore.getState().refactorNodeWithRecipe("mid", {
      id: "dry-macerator",
      name: "Dry macerate",
      machineType: "Dry Macerator",
      minimumTier: "LV",
      durationTicks: 60,
      eut: 4,
      inputs: [{ kind: "item", id: "ore", amount: 1 }],
      outputs: [{ kind: "item", id: "dust", amount: 2 }],
    });

    const state = useFactoryStore.getState();
    expect(state.project.edges.map((edge) => edge.id).sort()).toEqual(["e-dust", "e-ore"]);
  });

  it("keeps the old card and lands beside it when no wire survives", () => {
    useFactoryStore.getState().setProject(REFACTOR_PROJECT());

    useFactoryStore.getState().refactorNodeWithRecipe("mid", {
      id: "unrelated",
      name: "Unrelated",
      machineType: "Assembler",
      minimumTier: "LV",
      durationTicks: 40,
      eut: 8,
      inputs: [{ kind: "item", id: "bolt", amount: 8 }],
      outputs: [{ kind: "item", id: "frame", amount: 1 }],
    });

    const state = useFactoryStore.getState();
    const mid = state.project.nodes.find((entry) => entry.id === "mid");
    expect(mid?.recipeId).toBe("macerator");
    expect(state.project.edges.map((edge) => edge.id).sort()).toEqual(["e-dust", "e-ore"]);
    expect(state.project.nodes.some((entry) => entry.recipeId === "unrelated")).toBe(true);
  });

  it("seeds the refactor stencil from the card's own slots", () => {
    useFactoryStore.getState().setProject(REFACTOR_PROJECT());

    useFactoryStore.getState().beginRecipeRefactor("mid");

    const state = useFactoryStore.getState();
    expect(state.recipeBrowserRefactorNodeId).toBe("mid");
    expect(state.recipeBrowserResource?.anchorNodeId).toBe("mid");
    expect(state.recipeBrowserSeed).toEqual([
      expect.objectContaining({ role: "takes", kind: "item", id: "ore" }),
      expect.objectContaining({ role: "takes", kind: "item", id: "lube" }),
      expect.objectContaining({ role: "makes", kind: "item", id: "dust" }),
    ]);

    // A plain browse afterwards is not a refactor any more.
    useFactoryStore.getState().browseResource({ kind: "item", id: "ore" }, "recipes");
    expect(useFactoryStore.getState().recipeBrowserRefactorNodeId).toBeUndefined();
    expect(useFactoryStore.getState().recipeBrowserSeed).toBeUndefined();
  });

  it("walks back and forward through the pages the search has shown", () => {
    const store = useFactoryStore.getState();
    store.clearResourceBrowser();
    store.browseResource({ kind: "item", id: "ingot" }, "recipes");
    store.browseResource({ kind: "item", id: "dust" }, "uses");
    store.browseResource({ kind: "item", id: "ore" }, "recipes");
    // The page already open is not filed again.
    store.browseResource({ kind: "item", id: "ore" }, "recipes");
    expect(useFactoryStore.getState().recipeBrowserBack).toHaveLength(2);
    expect(useFactoryStore.getState().recipeBrowserForward).toHaveLength(0);

    store.browseBack();
    expect(useFactoryStore.getState().recipeBrowserResource?.id).toBe("dust");
    expect(useFactoryStore.getState().recipeBrowserMode).toBe("uses");
    expect(useFactoryStore.getState().recipeBrowserForward).toHaveLength(1);

    store.browseBack();
    expect(useFactoryStore.getState().recipeBrowserResource?.id).toBe("ingot");
    expect(useFactoryStore.getState().recipeBrowserBack).toHaveLength(0);
    // Nothing further back: a no-op, not a crash.
    store.browseBack();
    expect(useFactoryStore.getState().recipeBrowserResource?.id).toBe("ingot");

    store.browseForward();
    expect(useFactoryStore.getState().recipeBrowserResource?.id).toBe("dust");
    expect(useFactoryStore.getState().recipeBrowserMode).toBe("uses");

    // A fresh browse from the middle drops the forward branch, like a browser.
    store.browseResource({ kind: "fluid", id: "steam" }, "recipes");
    expect(useFactoryStore.getState().recipeBrowserForward).toHaveLength(0);
    expect(useFactoryStore.getState().recipeBrowserBack.map((page) => page.resource.id)).toEqual([
      "ingot",
      "dust",
    ]);

    // Closing the search forgets both stacks.
    store.clearResourceBrowser();
    expect(useFactoryStore.getState().recipeBrowserBack).toHaveLength(0);
    expect(useFactoryStore.getState().recipeBrowserForward).toHaveLength(0);
  });

  it("files the search a refactor press replaces, and back restores the refactor", () => {
    const store = useFactoryStore.getState();
    store.clearResourceBrowser();
    store.setProject(REFACTOR_PROJECT());
    store.beginRecipeRefactor("mid");
    expect(useFactoryStore.getState().recipeBrowserRefactorNodeId).toBe("mid");
    store.browseResource({ kind: "item", id: "ore" }, "recipes");
    expect(useFactoryStore.getState().recipeBrowserRefactorNodeId).toBeUndefined();
    store.browseBack();
    expect(useFactoryStore.getState().recipeBrowserRefactorNodeId).toBe("mid");
    expect(useFactoryStore.getState().recipeBrowserSeed?.length).toBeGreaterThan(0);
  });

  // A card whose recipe was not converted to the plan's version: no body, a marker, its wires.
  const UNCONVERTED_PROJECT = (): FactoryProject => {
    const project = REFACTOR_PROJECT();
    project.gameVersion = "2.9";
    project.recipes = project.recipes.filter((recipe) => recipe.id !== "macerator");
    project.nodes = project.nodes.map((node) =>
      node.id === "mid"
        ? {
            ...node,
            unconverted: {
              fromGameVersion: "2.8.1",
              recipeId: "macerator",
              recipeName: "Macerate",
              machineType: "Macerator",
            },
          }
        : node,
    );
    return project;
  };
  const MACERATE_29: Recipe = {
    id: "macerator",
    name: "Macerate",
    machineType: "Macerator",
    minimumTier: "LV",
    durationTicks: 80,
    eut: 8,
    inputs: [{ kind: "item", id: "ore", amount: 1 }],
    outputs: [{ kind: "item", id: "dust", amount: 2 }],
  };

  it("seeds the refactor of an unconverted card with no recipe body from its wires", () => {
    useFactoryStore.getState().clearResourceBrowser();
    useFactoryStore.getState().setProject(UNCONVERTED_PROJECT());
    useFactoryStore.getState().beginRecipeRefactor("mid");
    const state = useFactoryStore.getState();
    expect(state.recipeBrowserRefactorNodeId).toBe("mid");
    expect(state.recipeBrowserResource?.anchorNodeId).toBe("mid");
    // What comes in is taken, what goes out is made: the old body's lube has no wire, so it is not asked for.
    expect(state.recipeBrowserSeed).toEqual([
      expect.objectContaining({ role: "takes", kind: "item", id: "ore" }),
      expect.objectContaining({ role: "makes", kind: "item", id: "dust" }),
    ]);
  });

  it("an edit elsewhere keeps an unconverted card's wires: they are its ports", () => {
    useFactoryStore.getState().setProject(UNCONVERTED_PROJECT());
    useFactoryStore.getState().updateNode("sink", { machineCount: 2 });
    expect(useFactoryStore.getState().project.edges.map((edge) => edge.id).sort()).toEqual(["e-dust", "e-ore"]);
  });

  it("the pick clears the marker, keeps the wires and the card joins the solve, even under the same id", () => {
    useFactoryStore.getState().setProject(UNCONVERTED_PROJECT());
    expect(useFactoryStore.getState().lastResult?.nodes["mid"]?.unconverted).toBe(true);

    useFactoryStore.getState().refactorNodeWithRecipe("mid", MACERATE_29);

    const state = useFactoryStore.getState();
    const mid = state.project.nodes.find((entry) => entry.id === "mid")!;
    expect(mid.recipeId).toBe("macerator");
    expect("unconverted" in mid).toBe(false);
    expect(mid.position).toEqual({ x: 440, y: 0 });
    expect(state.project.recipes.find((entry) => entry.id === "macerator")?.durationTicks).toBe(80);
    expect(state.project.edges.map((edge) => edge.id).sort()).toEqual(["e-dust", "e-ore"]);
    const result = state.lastResult?.nodes["mid"];
    expect(result?.unconverted).toBeUndefined();
    expect(result?.status).not.toBe("missing-recipe");
    expect(result?.recipeName).toBe("Macerate");
  });

  it("picks a recipe for a shared card's unconverted section in its place", () => {
    const project = REFACTOR_PROJECT();
    project.gameVersion = "2.9";
    // "mid" runs the macerator and, on section 1, a recipe that was not converted, wired by its r1: handles.
    project.nodes = project.nodes.map((node) =>
      node.id === "mid"
        ? {
            ...node,
            extraRecipes: [
              {
                recipeId: "old-grind",
                unconverted: {
                  fromGameVersion: "2.8.1",
                  recipeId: "old-grind",
                  recipeName: "Grind",
                  machineType: "Macerator",
                },
              },
            ],
          }
        : node,
    );
    project.edges.push({
      id: "e-ore-r1",
      source: "src",
      target: "mid",
      targetHandle: "r1:input:item:ore",
      resourceKind: "item",
      resourceId: "ore",
    });
    useFactoryStore.getState().clearResourceBrowser();
    useFactoryStore.getState().setProject(project);

    useFactoryStore.getState().beginRecipeRefactor("mid#r1");
    expect(useFactoryStore.getState().recipeBrowserRefactorNodeId).toBe("mid#r1");
    expect(useFactoryStore.getState().recipeBrowserSeed).toEqual([
      expect.objectContaining({ role: "takes", kind: "item", id: "ore" }),
    ]);

    const grind: Recipe = { ...MACERATE_29, id: "grind-29", name: "Grind", outputs: [{ kind: "item", id: "grit", amount: 1 }] };
    useFactoryStore.getState().refactorNodeWithRecipe("mid#r1", grind);

    const state = useFactoryStore.getState();
    const mid = state.project.nodes.find((entry) => entry.id === "mid")!;
    expect(mid.recipeId).toBe("macerator");
    expect(mid.extraRecipes).toHaveLength(1);
    expect(mid.extraRecipes![0]!.recipeId).toBe("grind-29");
    expect(mid.extraRecipes![0]!.unconverted).toBeUndefined();
    const wire = state.project.edges.find((edge) => edge.id === "e-ore-r1");
    expect(wire?.targetHandle).toBe("r1:input:item:ore:0");
    expect(state.lastResult?.nodes["mid#r1"]?.unconverted).toBeUndefined();
  });
});

describe("factory machine count optimization", () => {
  it("propagates suggested machine counts through connected recipe chains", () => {
    useFactoryStore.getState().setProject(createRatioOptimizationProject());

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dust-source", machineCount: 10 }),
        expect.objectContaining({ id: "plate-target", machineCount: 10 }),
      ]),
    );
  });

  it("normalizes every optimized machine count to an integer", () => {
    const project = createRatioOptimizationProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "dust-source" ? { ...node, machineCount: 1.6 } : node,
      ),
      edges: [],
    });

    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.every((node) => Number.isInteger(node.machineCount)),
    ).toBe(true);
  });

  it("rounds optimized machine counts up to keep logistical surplus", () => {
    const project = createRatioOptimizationProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "plate-target"
          ? {
              ...node,
              targetOutput: {
                kind: "item",
                resourceId: "plate",
                amountPerSecond: 1.4,
              },
            }
          : node,
      ),
    });

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dust-source", machineCount: 2 }),
        expect.objectContaining({ id: "plate-target", machineCount: 2 }),
      ]),
    );
    expect(useFactoryStore.getState().lastResult.externalInputs).toHaveLength(0);
  });

  it("does not amplify cyclic recipe chains across optimization passes", () => {
    useFactoryStore.getState().setProject(createCyclicRatioProject());

    useFactoryStore.getState().optimizeMachineCounts();

    const machineCounts = useFactoryStore.getState().project.nodes.map((node) => node.machineCount);

    expect(machineCounts.every((machineCount) => Number.isInteger(machineCount))).toBe(true);
    expect(Math.max(...machineCounts)).toBeLessThanOrEqual(2);
  });

  it("balances stable direct recipe cycles without an explicit target", () => {
    useFactoryStore.getState().setProject(createStableDirectCycleOptimizationProject());

    useFactoryStore.getState().optimizeMachineCounts();
    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cycle-ingot-to-nuggets", machineCount: 1 }),
        expect.objectContaining({ id: "cycle-nuggets-to-ingot", machineCount: 2 }),
      ]),
    );
  });

  it("does not amplify cycles connected through separate buses for the same resource", () => {
    useFactoryStore.getState().setProject(createStorageBusCycleProject());

    useFactoryStore.getState().optimizeMachineCounts();
    useFactoryStore.getState().optimizeMachineCounts();
    useFactoryStore.getState().optimizeMachineCounts();

    const machineCounts = useFactoryStore.getState().project.nodes.map((node) => node.machineCount);

    expect(machineCounts.every((machineCount) => Number.isInteger(machineCount))).toBe(true);
    expect(Math.max(...machineCounts)).toBeLessThanOrEqual(2);
  });

  it("keeps cyclic SCC optimization bounded from external demand", () => {
    const project = createSmallCyclicBottleneckProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "small-cycle-source"
          ? { ...node, machineCount: 50 }
          : { ...node, machineCount: 51 },
      ),
    });

    useFactoryStore.getState().optimizeMachineCount("small-cycle-source");

    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().optimizeMachineCount("small-cycle-source");

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
    expect(
      Math.max(...useFactoryStore.getState().project.nodes.map((node) => node.machineCount)),
    ).toBeLessThanOrEqual(51);
  });

  it("sizes internal suppliers in catalyst loops from downstream demand", () => {
    useFactoryStore.getState().setProject(createCatalystLoopOptimizationProject());

    useFactoryStore.getState().optimizeMachineCounts();
    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "loop-compressor", machineCount: 5 }),
        expect.objectContaining({ id: "loop-centrifuge", machineCount: 1 }),
        expect.objectContaining({ id: "loop-canner", machineCount: 1 }),
        expect.objectContaining({ id: "loop-terminal", machineCount: 1 }),
      ]),
    );
  });

  it("keeps global optimization idempotent across repeated clicks", () => {
    useFactoryStore.getState().setProject(createStorageBusCycleProject());

    useFactoryStore.getState().optimizeMachineCounts();
    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().optimizeMachineCounts();
    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
  });

  it("ignores placeholder machine counts during global optimization", () => {
    const project = createAcyclicStorageBusProject();
    const placeholderProject = {
      ...project,
      nodes: project.nodes.map((node) => ({
        ...node,
        machineCount: node.id === "bus-source" ? 999 : 37,
      })),
    };

    useFactoryStore.getState().setProject(project);
    useFactoryStore.getState().optimizeMachineCounts();
    const baselineCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().setProject(placeholderProject);
    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(baselineCounts);
  });

  it("does not count pure storage sinks as extra ratio demand", () => {
    useFactoryStore.getState().setProject(createRecipeChainWithStorageSinkProject());

    useFactoryStore.getState().optimizeMachineCounts();
    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sink-source", machineCount: 10 }),
        expect.objectContaining({ id: "sink-target", machineCount: 10 }),
      ]),
    );
  });

  it("does not let surplus storage sinks pin single-node optimization to the current count", () => {
    const project = createRecipeChainWithStorageSinkProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "sink-source"
          ? { ...node, machineCount: 3 }
          : {
              ...node,
              targetOutput: {
                kind: "item",
                resourceId: "plate",
                amountPerSecond: 1,
              },
            },
      ),
    });

    useFactoryStore.getState().optimizeMachineCount("sink-source");

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "sink-source", machineCount: 1 })]),
    );
  });

  it("uses the split share when storage and another edge feed the same input", () => {
    const project = createSplitStorageInputOptimizationProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "storage-source" ? { ...node, machineCount: 10 } : node,
      ),
    });

    useFactoryStore.getState().optimizeMachineCount("storage-source");

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "storage-source", machineCount: 1 })]),
    );
  });

  it("optimizes a multi-output producer when one output is split through storage", () => {
    const project = createMultiOutputSplitInputOptimizationProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "source" ? { ...node, machineCount: 41 } : node,
      ),
    });

    useFactoryStore.getState().optimizeMachineCount("source");

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "source", machineCount: 1 })]),
    );
  });

  it("sizes upstream inputs from downstream storage demand instead of storage surplus", () => {
    const project = createSurplusStorageConsumerInputProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "input-source" ? { ...node, machineCount: 100 } : node,
      ),
      targetRate: {
        kind: "fluid",
        resourceId: "benzene",
        amountPerSecond: 1,
      },
    });

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "input-source", machineCount: 1 }),
        expect.objectContaining({ id: "storage-producer", machineCount: 1 }),
      ]),
    );
  });

  it("scales terminal consumers to consume produced output when no explicit target exists", () => {
    useFactoryStore.getState().setProject(createImplicitTerminalStorageDemandProject());

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implicit-source", machineCount: 1 }),
        expect.objectContaining({ id: "implicit-consumer", machineCount: 10 }),
      ]),
    );
  });

  it("uses rounded storage producer capacity for implicit terminal ratios", () => {
    const project = createImplicitRoundedStorageProducerProject();
    useFactoryStore.getState().setProject({
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "storage-consumer"
          ? {
              ...node,
              machineCount: 100,
            }
          : node,
      ),
    });

    useFactoryStore.getState().optimizeMachineCounts();
    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);
    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "storage-producer", machineCount: 1 }),
        expect.objectContaining({ id: "storage-consumer", machineCount: 3 }),
      ]),
    );
  });

  it("scales producers to fill one configured parallel terminal consumer", () => {
    useFactoryStore.getState().setProject(createImplicitParallelTerminalStorageDemandProject());

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "parallel-source", machineCount: 256 }),
        expect.objectContaining({ id: "parallel-consumer", machineCount: 1 }),
      ]),
    );
  });

  it("stabilizes rounded implicit source output in one click", () => {
    useFactoryStore.getState().setProject(createImplicitRoundedSourceProject());

    useFactoryStore.getState().optimizeMachineCounts();
    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "rounded-source", machineCount: 4 }),
        expect.objectContaining({ id: "rounded-producer", machineCount: 20 }),
        expect.objectContaining({ id: "rounded-indirect", machineCount: 20 }),
        expect.objectContaining({ id: "rounded-terminal", machineCount: 1 }),
      ]),
    );
  });

  it("combines direct and indirect storage output for implicit terminal demand", () => {
    useFactoryStore.getState().setProject(createImplicitDirectAndIndirectStorageOutputProject());

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implicit-coke", machineCount: 1 }),
        expect.objectContaining({ id: "implicit-extractor", machineCount: 3 }),
        expect.objectContaining({ id: "implicit-distillation", machineCount: 5 }),
      ]),
    );
  });

  it("combines direct and indirect storage output when optimizing a shared producer", () => {
    useFactoryStore.getState().setProject(createDirectAndIndirectStorageOutputProject());

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "coke-oven", machineCount: 1 }),
        expect.objectContaining({ id: "fluid-extractor", machineCount: 1 }),
        expect.objectContaining({ id: "distillation-tower", machineCount: 1 }),
      ]),
    );
  });

  it("uses the global solver result for single-node optimization", () => {
    const project = createDirectAndIndirectStorageOutputProject();
    useFactoryStore.getState().setProject(project);
    useFactoryStore.getState().optimizeMachineCounts();
    const globalCokeCount = useFactoryStore
      .getState()
      .project.nodes.find((node) => node.id === "coke-oven")?.machineCount;

    useFactoryStore.getState().setProject(project);
    useFactoryStore.getState().optimizeMachineCount("coke-oven");

    expect(
      useFactoryStore.getState().project.nodes.find((node) => node.id === "coke-oven")
        ?.machineCount,
    ).toBe(globalCokeCount);
  });

  it("does not amplify an externally seeded recipe cycle", () => {
    useFactoryStore.getState().setProject(createAmplifyingCycleProject());

    useFactoryStore.getState().optimizeMachineCounts();
    const firstCounts = useFactoryStore
      .getState()
      .project.nodes.map((node) => [node.id, node.machineCount]);

    useFactoryStore.getState().optimizeMachineCounts();

    expect(
      useFactoryStore.getState().project.nodes.map((node) => [node.id, node.machineCount]),
    ).toEqual(firstCounts);
    expect(
      Math.max(...useFactoryStore.getState().project.nodes.map((node) => node.machineCount)),
    ).toBeLessThanOrEqual(10);
  });

  it("keeps single-node optimization idempotent across repeated clicks", () => {
    useFactoryStore.getState().setProject(createStorageBusCycleProject());

    useFactoryStore.getState().optimizeMachineCount("bus-cycle-b");
    const firstCount = useFactoryStore
      .getState()
      .project.nodes.find((node) => node.id === "bus-cycle-b")?.machineCount;

    useFactoryStore.getState().optimizeMachineCount("bus-cycle-b");
    useFactoryStore.getState().optimizeMachineCount("bus-cycle-b");

    expect(
      useFactoryStore.getState().project.nodes.find((node) => node.id === "bus-cycle-b")
        ?.machineCount,
    ).toBe(firstCount);
  });

  it("still propagates ratios through separate buses when there is no feedback loop", () => {
    useFactoryStore.getState().setProject(createAcyclicStorageBusProject());

    useFactoryStore.getState().optimizeMachineCounts();

    expect(useFactoryStore.getState().project.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bus-source", machineCount: 10 }),
        expect.objectContaining({ id: "bus-target", machineCount: 10 }),
      ]),
    );
  });
});

function createLinkTestProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "link-test",
    name: "Link test",
    recipes: [
      {
        id: "item-source-recipe",
        name: "Item source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "dust", amount: 1 }],
      },
      {
        id: "item-target-recipe",
        name: "Item target",
        machineType: "Target",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "dust", amount: 1 }],
        outputs: [{ kind: "item", id: "plate", amount: 1 }],
      },
      {
        id: "fluid-source-recipe",
        name: "Fluid source",
        machineType: "Pump",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "fluid", id: "water", amount: 1000 }],
      },
      {
        id: "fluid-target-recipe",
        name: "Fluid target",
        machineType: "Canner",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "water", amount: 1000 }],
        outputs: [{ kind: "item", id: "cell", amount: 1 }],
      },
      {
        id: "nc-target-recipe",
        name: "Non consumed target",
        machineType: "Extruder",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "mold", amount: 1, consumed: false }],
        outputs: [{ kind: "item", id: "gear", amount: 1 }],
      },
      {
        id: "stick-source-recipe",
        name: "Stick source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "minecraft:stick@0", amount: 1, displayName: "Stick" }],
      },
      {
        id: "stick-oredict-target-recipe",
        name: "Ore dictionary target",
        machineType: "Crafting",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [
          {
            kind: "item",
            id: "oredict:stickWood",
            amount: 1,
            displayName: "Stick",
            alternatives: [
              { kind: "item", id: "minecraft:stick@0", displayName: "Stick" },
              { kind: "item", id: "other:stick@0", displayName: "Other Stick" },
            ],
          },
        ],
        outputs: [{ kind: "item", id: "crafted", amount: 1 }],
      },
      {
        id: "screwdriver-source-recipe",
        name: "Screwdriver source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [
          {
            kind: "item",
            id: "gregtech:screwdriver.lv@0",
            amount: 1,
            displayName: "Screwdriver (LV)",
          },
        ],
      },
      {
        id: "screwdriver-oredict-target-recipe",
        name: "Ore dictionary tool target",
        machineType: "Crafting",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [
          {
            kind: "item",
            id: "oredict:craftingToolScrewdriver",
            amount: 1,
            displayName: "Screwdriver",
            alternatives: [
              {
                kind: "item",
                id: "gregtech:screwdriver.lv@0",
                displayName: "Screwdriver (LV)",
              },
              {
                kind: "item",
                id: "gregtech:screwdriver.mv@0",
                displayName: "Screwdriver (MV)",
              },
            ],
          },
        ],
        outputs: [{ kind: "item", id: "tool-crafted", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("item-source", "item-source-recipe", 0),
      makeNode("item-target", "item-target-recipe", 200),
      makeNode("fluid-source", "fluid-source-recipe", 0, 140),
      makeNode("fluid-target", "fluid-target-recipe", 200, 140),
      makeNode("nc-target", "nc-target-recipe", 200, 280),
      makeNode("stick-source", "stick-source-recipe", 0, 420),
      makeNode("stick-oredict-target", "stick-oredict-target-recipe", 200, 420),
      makeNode("screwdriver-source", "screwdriver-source-recipe", 0, 560),
      makeNode("screwdriver-oredict-target", "screwdriver-oredict-target-recipe", 200, 560),
    ],
    storages: [
      {
        id: "dust-drawer",
        kind: "item",
        resourceId: "dust",
        displayName: "Dust",
        position: { x: 100, y: 0 },
      },
      {
        id: "mold-drawer",
        kind: "item",
        resourceId: "mold",
        displayName: "Mold",
        position: { x: 100, y: 280 },
      },
      {
        id: "water-tank",
        kind: "fluid",
        resourceId: "water",
        displayName: "Water",
        position: { x: 100, y: 140 },
      },
      {
        id: "stick-drawer",
        kind: "item",
        resourceId: "minecraft:stick@0",
        displayName: "Stick",
        position: { x: 100, y: 420 },
      },
    ],
    edges: [],
    fuelProfiles: [],
  };
}

function createRatioOptimizationProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "ratio-optimization",
    name: "Ratio optimization",
    recipes: [
      {
        id: "dust-source-recipe",
        name: "Dust source",
        machineType: "Macerator",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "dust", amount: 1 }],
      },
      {
        id: "plate-target-recipe",
        name: "Plate target",
        machineType: "Assembler",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "dust", amount: 1 }],
        outputs: [{ kind: "item", id: "plate", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("dust-source", "dust-source-recipe", 0),
      {
        ...makeNode("plate-target", "plate-target-recipe", 240),
        targetOutput: {
          kind: "item",
          resourceId: "plate",
          amountPerSecond: 10,
        },
      },
    ],
    storages: [],
    edges: [
      {
        id: "dust-edge",
        source: "dust-source",
        target: "plate-target",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
        resourceKind: "item",
        resourceId: "dust",
      },
    ],
    fuelProfiles: [],
  };
}

function createCyclicRatioProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "cycle-ratio",
    name: "Cycle ratio",
    recipes: [
      {
        id: "cycle-a-recipe",
        name: "Cycle A",
        machineType: "A",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "y", amount: 2 }],
        outputs: [{ kind: "item", id: "x", amount: 1 }],
      },
      {
        id: "cycle-b-recipe",
        name: "Cycle B",
        machineType: "B",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "x", amount: 2 }],
        outputs: [{ kind: "item", id: "y", amount: 1 }],
      },
    ],
    nodes: [
      {
        ...makeNode("cycle-a", "cycle-a-recipe", 0),
        targetOutput: {
          kind: "item",
          resourceId: "x",
          amountPerSecond: 2,
        },
      },
      makeNode("cycle-b", "cycle-b-recipe", 240),
    ],
    storages: [],
    edges: [
      {
        id: "x-edge",
        source: "cycle-a",
        target: "cycle-b",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "x" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "x" }, 0),
        resourceKind: "item",
        resourceId: "x",
      },
      {
        id: "y-edge",
        source: "cycle-b",
        target: "cycle-a",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "y" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "y" }, 0),
        resourceKind: "item",
        resourceId: "y",
      },
    ],
    fuelProfiles: [],
  };
}

function createStableDirectCycleOptimizationProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "stable-direct-cycle-optimization",
    name: "Stable direct cycle optimization",
    recipes: [
      {
        id: "ingot-to-nuggets-recipe",
        name: "Ingot to Nuggets",
        machineType: "Alloy Smelter",
        minimumTier: "ULV",
        durationTicks: 100,
        eut: 1,
        inputs: [{ kind: "item", id: "ingot", amount: 1 }],
        outputs: [{ kind: "item", id: "nugget", amount: 9 }],
      },
      {
        id: "nuggets-to-ingot-recipe",
        name: "Nuggets to Ingot",
        machineType: "Alloy Smelter",
        minimumTier: "ULV",
        durationTicks: 200,
        eut: 1,
        inputs: [{ kind: "item", id: "nugget", amount: 9 }],
        outputs: [{ kind: "item", id: "ingot", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("cycle-ingot-to-nuggets", "ingot-to-nuggets-recipe", 0),
      makeNode("cycle-nuggets-to-ingot", "nuggets-to-ingot-recipe", 240),
    ],
    storages: [],
    edges: [
      {
        id: "cycle-nugget-edge",
        source: "cycle-ingot-to-nuggets",
        target: "cycle-nuggets-to-ingot",
        resourceKind: "item",
        resourceId: "nugget",
      },
      {
        id: "cycle-ingot-edge",
        source: "cycle-nuggets-to-ingot",
        target: "cycle-ingot-to-nuggets",
        resourceKind: "item",
        resourceId: "ingot",
      },
    ],
    fuelProfiles: [],
  };
}

function createStorageBusCycleProject(): FactoryProject {
  return {
    ...createCyclicRatioProject(),
    id: "storage-bus-cycle-ratio",
    nodes: [
      {
        ...makeNode("bus-cycle-a", "cycle-a-recipe", 0),
        targetOutput: {
          kind: "item",
          resourceId: "x",
          amountPerSecond: 2,
        },
      },
      makeNode("bus-cycle-b", "cycle-b-recipe", 240),
    ],
    storages: [
      { id: "x-out", kind: "item", resourceId: "x", position: { x: 120, y: 0 } },
      { id: "x-in", kind: "item", resourceId: "x", position: { x: 160, y: 0 } },
      { id: "y-out", kind: "item", resourceId: "y", position: { x: 120, y: 140 } },
      { id: "y-in", kind: "item", resourceId: "y", position: { x: 160, y: 140 } },
    ],
    edges: [
      {
        id: "x-out-edge",
        source: "bus-cycle-a",
        target: "x-out",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "x" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "x" }),
        resourceKind: "item",
        resourceId: "x",
      },
      {
        id: "x-in-edge",
        source: "x-in",
        target: "bus-cycle-b",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "x" }),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "x" }, 0),
        resourceKind: "item",
        resourceId: "x",
      },
      {
        id: "y-out-edge",
        source: "bus-cycle-b",
        target: "y-out",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "y" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "y" }),
        resourceKind: "item",
        resourceId: "y",
      },
      {
        id: "y-in-edge",
        source: "y-in",
        target: "bus-cycle-a",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "y" }),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "y" }, 0),
        resourceKind: "item",
        resourceId: "y",
      },
    ],
  };
}

function createSmallCyclicBottleneckProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "small-cycle-bottleneck",
    name: "Small cycle bottleneck",
    recipes: [
      {
        id: "small-cycle-source-recipe",
        name: "Small Cycle Source",
        machineType: "A",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "seed", amount: 1 }],
        outputs: [{ kind: "item", id: "product", amount: 1 }],
      },
      {
        id: "small-cycle-return-recipe",
        name: "Small Cycle Return",
        machineType: "B",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "product", amount: 1 }],
        outputs: [{ kind: "item", id: "seed", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("small-cycle-source", "small-cycle-source-recipe", 0),
      {
        ...makeNode("small-cycle-return", "small-cycle-return-recipe", 240),
        targetOutput: {
          kind: "item",
          resourceId: "seed",
          amountPerSecond: 50.2,
        },
      },
    ],
    storages: [],
    edges: [
      {
        id: "small-cycle-product-edge",
        source: "small-cycle-source",
        target: "small-cycle-return",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "product" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "product" }, 0),
        resourceKind: "item",
        resourceId: "product",
      },
      {
        id: "small-cycle-seed-edge",
        source: "small-cycle-return",
        target: "small-cycle-source",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "seed" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "seed" }, 0),
        resourceKind: "item",
        resourceId: "seed",
      },
    ],
    fuelProfiles: [],
  };
}

function createCatalystLoopOptimizationProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "catalyst-loop-optimization",
    name: "Catalyst loop optimization",
    recipes: [
      {
        id: "loop-compressor-recipe",
        name: "Loop Compressor",
        machineType: "Compressor",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "empty_cell", amount: 1 }],
        outputs: [{ kind: "item", id: "compressed_air_cell", amount: 1 }],
      },
      {
        id: "loop-centrifuge-recipe",
        name: "Loop Centrifuge",
        machineType: "Centrifuge",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "compressed_air_cell", amount: 5 }],
        outputs: [
          { kind: "fluid", id: "nitrogen", amount: 1_000 },
          { kind: "item", id: "empty_cell", amount: 4 },
          { kind: "item", id: "oxygen_cell", amount: 1 },
        ],
      },
      {
        id: "loop-canner-recipe",
        name: "Loop Canner",
        machineType: "Fluid Canner",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "oxygen_cell", amount: 1 }],
        outputs: [
          { kind: "item", id: "empty_cell", amount: 1 },
          { kind: "fluid", id: "oxygen", amount: 1_000 },
        ],
      },
      {
        id: "loop-terminal-recipe",
        name: "Loop Terminal",
        machineType: "Consumer",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "nitrogen", amount: 1_000 }],
        outputs: [{ kind: "fluid", id: "product", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("loop-compressor", "loop-compressor-recipe", 0),
      makeNode("loop-centrifuge", "loop-centrifuge-recipe", 240),
      makeNode("loop-canner", "loop-canner-recipe", 480),
      makeNode("loop-terminal", "loop-terminal-recipe", 720),
    ],
    storages: [
      {
        id: "loop-empty-cell-buffer",
        kind: "item",
        resourceId: "empty_cell",
        position: { x: 160, y: 120 },
      },
    ],
    edges: [
      {
        id: "loop-compressor-to-centrifuge",
        source: "loop-compressor",
        target: "loop-centrifuge",
        resourceKind: "item",
        resourceId: "compressed_air_cell",
      },
      {
        id: "loop-centrifuge-to-terminal",
        source: "loop-centrifuge",
        target: "loop-terminal",
        resourceKind: "fluid",
        resourceId: "nitrogen",
      },
      {
        id: "loop-centrifuge-to-canner",
        source: "loop-centrifuge",
        target: "loop-canner",
        resourceKind: "item",
        resourceId: "oxygen_cell",
      },
      {
        id: "loop-centrifuge-to-buffer",
        source: "loop-centrifuge",
        target: "loop-empty-cell-buffer",
        resourceKind: "item",
        resourceId: "empty_cell",
      },
      {
        id: "loop-canner-to-buffer",
        source: "loop-canner",
        target: "loop-empty-cell-buffer",
        resourceKind: "item",
        resourceId: "empty_cell",
      },
      {
        id: "loop-buffer-to-compressor",
        source: "loop-empty-cell-buffer",
        target: "loop-compressor",
        resourceKind: "item",
        resourceId: "empty_cell",
      },
    ],
    fuelProfiles: [],
  };
}

function createAmplifyingCycleProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "amplifying-cycle",
    name: "Amplifying cycle",
    recipes: [
      {
        id: "amplifying-a-recipe",
        name: "Amplifying A",
        machineType: "A",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "b", amount: 2 }],
        outputs: [{ kind: "item", id: "a", amount: 1 }],
      },
      {
        id: "amplifying-b-recipe",
        name: "Amplifying B",
        machineType: "B",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "a", amount: 2 }],
        outputs: [{ kind: "item", id: "b", amount: 1 }],
      },
    ],
    nodes: [
      {
        ...makeNode("amplifying-a", "amplifying-a-recipe", 0),
        targetOutput: {
          kind: "item",
          resourceId: "a",
          amountPerSecond: 10,
        },
      },
      makeNode("amplifying-b", "amplifying-b-recipe", 240),
    ],
    storages: [],
    edges: [
      {
        id: "amplifying-a-to-b",
        source: "amplifying-a",
        target: "amplifying-b",
        resourceKind: "item",
        resourceId: "a",
      },
      {
        id: "amplifying-b-to-a",
        source: "amplifying-b",
        target: "amplifying-a",
        resourceKind: "item",
        resourceId: "b",
      },
    ],
    fuelProfiles: [],
  };
}

function createAcyclicStorageBusProject(): FactoryProject {
  return {
    ...createRatioOptimizationProject(),
    id: "acyclic-storage-bus-ratio",
    nodes: [
      makeNode("bus-source", "dust-source-recipe", 0),
      {
        ...makeNode("bus-target", "plate-target-recipe", 240),
        targetOutput: {
          kind: "item",
          resourceId: "plate",
          amountPerSecond: 10,
        },
      },
    ],
    storages: [
      { id: "dust-out", kind: "item", resourceId: "dust", position: { x: 100, y: 0 } },
      { id: "dust-in", kind: "item", resourceId: "dust", position: { x: 140, y: 0 } },
    ],
    edges: [
      {
        id: "dust-out-edge",
        source: "bus-source",
        target: "dust-out",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }),
        resourceKind: "item",
        resourceId: "dust",
      },
      {
        id: "dust-in-edge",
        source: "dust-in",
        target: "bus-target",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
        resourceKind: "item",
        resourceId: "dust",
      },
    ],
  };
}

function createRecipeChainWithStorageSinkProject(): FactoryProject {
  return {
    ...createRatioOptimizationProject(),
    id: "recipe-chain-with-storage-sink",
    nodes: [
      makeNode("sink-source", "dust-source-recipe", 0),
      {
        ...makeNode("sink-target", "plate-target-recipe", 240),
        targetOutput: {
          kind: "item",
          resourceId: "plate",
          amountPerSecond: 10,
        },
      },
    ],
    storages: [{ id: "dust-sink", kind: "item", resourceId: "dust", position: { x: 120, y: 120 } }],
    edges: [
      {
        id: "sink-target-edge",
        source: "sink-source",
        target: "sink-target",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }, 0),
        resourceKind: "item",
        resourceId: "dust",
      },
      {
        id: "sink-storage-edge",
        source: "sink-source",
        target: "dust-sink",
        sourceHandle: makeResourceHandleId("output", { kind: "item", id: "dust" }, 0),
        targetHandle: makeResourceHandleId("input", { kind: "item", id: "dust" }),
        resourceKind: "item",
        resourceId: "dust",
      },
    ],
  };
}

function createSplitStorageInputOptimizationProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "split-storage-input-optimization",
    name: "Split storage input optimization",
    recipes: [
      {
        id: "storage-source-recipe",
        name: "Storage source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "dust", amount: 10 }],
      },
      {
        id: "direct-source-recipe",
        name: "Direct source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "dust", amount: 10 }],
      },
      {
        id: "consumer-recipe",
        name: "Consumer",
        machineType: "Assembler",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "dust", amount: 10 }],
        outputs: [{ kind: "item", id: "plate", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("storage-source", "storage-source-recipe", 0),
      makeNode("direct-source", "direct-source-recipe", 160),
      {
        ...makeNode("consumer", "consumer-recipe", 320),
        targetOutput: {
          kind: "item",
          resourceId: "plate",
          amountPerSecond: 1,
        },
      },
    ],
    storages: [
      { id: "dust-storage", kind: "item", resourceId: "dust", position: { x: 160, y: 120 } },
    ],
    edges: [
      {
        id: "storage-source-to-storage",
        source: "storage-source",
        target: "dust-storage",
        resourceKind: "item",
        resourceId: "dust",
      },
      {
        id: "storage-to-consumer",
        source: "dust-storage",
        target: "consumer",
        resourceKind: "item",
        resourceId: "dust",
      },
      {
        id: "direct-source-to-consumer",
        source: "direct-source",
        target: "consumer",
        resourceKind: "item",
        resourceId: "dust",
      },
    ],
    fuelProfiles: [],
  };
}

function createMultiOutputSplitInputOptimizationProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "multi-output-split-input-optimization",
    name: "Multi output split input optimization",
    recipes: [
      {
        id: "source-recipe",
        name: "Source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [
          { kind: "item", id: "dust", amount: 10 },
          { kind: "fluid", id: "oil", amount: 1000 },
        ],
      },
      {
        id: "item-consumer-recipe",
        name: "Item consumer",
        machineType: "Assembler",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "dust", amount: 10 }],
        outputs: [{ kind: "item", id: "plate", amount: 1 }],
      },
      {
        id: "fluid-consumer-recipe",
        name: "Fluid consumer",
        machineType: "Distillation Tower",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "oil", amount: 1000 }],
        outputs: [{ kind: "fluid", id: "light", amount: 1000 }],
      },
    ],
    nodes: [
      makeNode("source", "source-recipe", 0),
      {
        ...makeNode("item-consumer", "item-consumer-recipe", 220),
        targetOutput: {
          kind: "item",
          resourceId: "plate",
          amountPerSecond: 1,
        },
      },
      {
        ...makeNode("fluid-consumer", "fluid-consumer-recipe", 440),
        targetOutput: {
          kind: "fluid",
          resourceId: "light",
          amountPerSecond: 1000,
        },
      },
    ],
    storages: [{ id: "oil-tank", kind: "fluid", resourceId: "oil", position: { x: 260, y: 120 } }],
    edges: [
      {
        id: "source-to-item-consumer",
        source: "source",
        target: "item-consumer",
        resourceKind: "item",
        resourceId: "dust",
      },
      {
        id: "source-to-fluid-consumer",
        source: "source",
        target: "fluid-consumer",
        resourceKind: "fluid",
        resourceId: "oil",
      },
      {
        id: "source-to-oil-tank",
        source: "source",
        target: "oil-tank",
        resourceKind: "fluid",
        resourceId: "oil",
      },
      {
        id: "oil-tank-to-fluid-consumer",
        source: "oil-tank",
        target: "fluid-consumer",
        resourceKind: "fluid",
        resourceId: "oil",
      },
    ],
    fuelProfiles: [],
  };
}

function createSurplusStorageConsumerInputProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "surplus-storage-consumer-input-optimization",
    name: "Surplus storage consumer input optimization",
    recipes: [
      {
        id: "input-source-recipe",
        name: "Input source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "coal", amount: 1 }],
      },
      {
        id: "storage-producer-recipe",
        name: "Storage producer",
        machineType: "Fluid Extractor",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "coal", amount: 100 }],
        outputs: [{ kind: "fluid", id: "woodtar", amount: 10000 }],
      },
      {
        id: "direct-producer-recipe",
        name: "Direct producer",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "fluid", id: "woodtar", amount: 100 }],
      },
      {
        id: "storage-consumer-recipe",
        name: "Storage consumer",
        machineType: "Distillation Tower",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "woodtar", amount: 100 }],
        outputs: [{ kind: "fluid", id: "benzene", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("input-source", "input-source-recipe", 0),
      makeNode("storage-producer", "storage-producer-recipe", 220),
      makeNode("direct-producer", "direct-producer-recipe", 220, 140),
      makeNode("storage-consumer", "storage-consumer-recipe", 520),
    ],
    storages: [
      { id: "woodtar-tank", kind: "fluid", resourceId: "woodtar", position: { x: 380, y: 80 } },
    ],
    edges: [
      {
        id: "input-source-to-storage-producer",
        source: "input-source",
        target: "storage-producer",
        resourceKind: "item",
        resourceId: "coal",
      },
      {
        id: "storage-producer-to-tank",
        source: "storage-producer",
        target: "woodtar-tank",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
      {
        id: "direct-producer-to-tank",
        source: "direct-producer",
        target: "woodtar-tank",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
      {
        id: "tank-to-storage-consumer",
        source: "woodtar-tank",
        target: "storage-consumer",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
    ],
    fuelProfiles: [],
  };
}

function createImplicitTerminalStorageDemandProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "implicit-terminal-storage-demand",
    name: "Implicit terminal storage demand",
    recipes: [
      {
        id: "implicit-source-recipe",
        name: "Implicit Source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "fluid", id: "oil", amount: 10 }],
      },
      {
        id: "implicit-consumer-recipe",
        name: "Implicit Consumer",
        machineType: "Distillation Tower",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "oil", amount: 1 }],
        outputs: [{ kind: "fluid", id: "fuel", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("implicit-source", "implicit-source-recipe", 0),
      makeNode("implicit-consumer", "implicit-consumer-recipe", 320),
    ],
    storages: [
      { id: "implicit-oil-tank", kind: "fluid", resourceId: "oil", position: { x: 160, y: 0 } },
    ],
    edges: [
      {
        id: "implicit-source-to-tank",
        source: "implicit-source",
        target: "implicit-oil-tank",
        resourceKind: "fluid",
        resourceId: "oil",
      },
      {
        id: "implicit-tank-to-consumer",
        source: "implicit-oil-tank",
        target: "implicit-consumer",
        resourceKind: "fluid",
        resourceId: "oil",
      },
    ],
    fuelProfiles: [],
  };
}

function createImplicitRoundedStorageProducerProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "implicit-rounded-storage-producer",
    name: "Implicit rounded storage producer",
    recipes: [
      {
        id: "storage-producer-recipe",
        name: "Storage Producer",
        machineType: "Chemical Reactor",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "feedstock", amount: 1 }],
        outputs: [{ kind: "fluid", id: "product", amount: 3 }],
      },
      {
        id: "storage-consumer-recipe",
        name: "Storage Consumer",
        machineType: "Assembler",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "product", amount: 1 }],
        outputs: [{ kind: "item", id: "part", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("storage-producer", "storage-producer-recipe", 0),
      makeNode("storage-consumer", "storage-consumer-recipe", 320),
    ],
    storages: [
      { id: "product-tank", kind: "fluid", resourceId: "product", position: { x: 160, y: 0 } },
    ],
    edges: [
      {
        id: "producer-to-tank",
        source: "storage-producer",
        target: "product-tank",
        resourceKind: "fluid",
        resourceId: "product",
      },
      {
        id: "tank-to-consumer",
        source: "product-tank",
        target: "storage-consumer",
        resourceKind: "fluid",
        resourceId: "product",
      },
    ],
    fuelProfiles: [],
  };
}

function createImplicitParallelTerminalStorageDemandProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "implicit-parallel-terminal-storage-demand",
    name: "Implicit parallel terminal storage demand",
    recipes: [
      {
        id: "parallel-source-recipe",
        name: "Parallel Source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "fluid", id: "oil", amount: 1 }],
      },
      {
        id: "parallel-consumer-recipe",
        name: "Parallel Consumer",
        // A made-up machine so the dataset's own parallel control drives this
        // test; a curated-table name would bring that machine's speed with it.
        machineType: "Parallel Test Tower",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "oil", amount: 1 }],
        outputs: [{ kind: "fluid", id: "fuel", amount: 1 }],
        machineConfigControls: [
          {
            id: "machineParallel",
            label: "Parallel",
            minimumKey: "x1",
            tiers: [
              {
                key: "x1",
                label: "1x",
                parallelMultiplier: 1,
                resource: { kind: "item", id: "parallel_1", amount: 1 },
              },
              {
                key: "x256",
                label: "256x",
                parallelMultiplier: 256,
                resource: { kind: "item", id: "parallel_256", amount: 1 },
              },
            ],
          },
        ],
      },
    ],
    nodes: [
      makeNode("parallel-source", "parallel-source-recipe", 0),
      {
        ...makeNode("parallel-consumer", "parallel-consumer-recipe", 320),
        // 256 parallels of a 1 EU/t recipe draw 256 EU/t, so the machine needs
        // an HV hatch to run them all. HV has no headroom left over for an
        // overclock, which keeps the ratio under test at a clean 256:1.
        overclockTier: "HV",
        machineConfigTiers: { machineParallel: "x256" },
      },
    ],
    storages: [
      { id: "parallel-oil-tank", kind: "fluid", resourceId: "oil", position: { x: 160, y: 0 } },
    ],
    edges: [
      {
        id: "parallel-source-to-tank",
        source: "parallel-source",
        target: "parallel-oil-tank",
        resourceKind: "fluid",
        resourceId: "oil",
      },
      {
        id: "parallel-tank-to-consumer",
        source: "parallel-oil-tank",
        target: "parallel-consumer",
        resourceKind: "fluid",
        resourceId: "oil",
      },
    ],
    fuelProfiles: [],
  };
}

function createImplicitRoundedSourceProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "implicit-rounded-source",
    name: "Implicit rounded source",
    recipes: [
      {
        id: "rounded-source-recipe",
        name: "Rounded Source",
        machineType: "Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [{ kind: "item", id: "input", amount: 5 }],
      },
      {
        id: "rounded-producer-recipe",
        name: "Rounded Producer",
        machineType: "Producer",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "input", amount: 1 }],
        outputs: [
          { kind: "fluid", id: "product", amount: 1 },
          { kind: "item", id: "byproduct", amount: 1 },
        ],
      },
      {
        id: "rounded-indirect-recipe",
        name: "Rounded Indirect",
        machineType: "Indirect",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "byproduct", amount: 1 }],
        outputs: [{ kind: "fluid", id: "product", amount: 5 }],
      },
      {
        id: "rounded-terminal-recipe",
        name: "Rounded Terminal",
        machineType: "Terminal",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "product", amount: 100 }],
        outputs: [{ kind: "fluid", id: "done", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("rounded-source", "rounded-source-recipe", 0),
      makeNode("rounded-producer", "rounded-producer-recipe", 180),
      makeNode("rounded-indirect", "rounded-indirect-recipe", 360),
      makeNode("rounded-terminal", "rounded-terminal-recipe", 540),
    ],
    storages: [
      { id: "rounded-tank", kind: "fluid", resourceId: "product", position: { x: 360, y: 160 } },
    ],
    edges: [
      {
        id: "rounded-source-to-producer",
        source: "rounded-source",
        target: "rounded-producer",
        resourceKind: "item",
        resourceId: "input",
      },
      {
        id: "rounded-producer-to-indirect",
        source: "rounded-producer",
        target: "rounded-indirect",
        resourceKind: "item",
        resourceId: "byproduct",
      },
      {
        id: "rounded-producer-to-tank",
        source: "rounded-producer",
        target: "rounded-tank",
        resourceKind: "fluid",
        resourceId: "product",
      },
      {
        id: "rounded-indirect-to-tank",
        source: "rounded-indirect",
        target: "rounded-tank",
        resourceKind: "fluid",
        resourceId: "product",
      },
      {
        id: "rounded-tank-to-terminal",
        source: "rounded-tank",
        target: "rounded-terminal",
        resourceKind: "fluid",
        resourceId: "product",
      },
    ],
    fuelProfiles: [],
  };
}

function createImplicitDirectAndIndirectStorageOutputProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "implicit-direct-indirect-storage-output",
    name: "Implicit direct and indirect storage output",
    recipes: [
      {
        id: "implicit-coke-recipe",
        name: "Implicit Coke",
        // Named a real machine while testing storage ratios that have nothing to do
        // with it. The curated table gives the coke oven a coil EU discount and
        // slice parallels, which moved these counts.
        machineType: "Test Charcoal Source",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [
          { kind: "item", id: "charcoal", amount: 300 },
          { kind: "fluid", id: "woodtar", amount: 2000 },
        ],
      },
      {
        id: "implicit-extractor-recipe",
        name: "Implicit Extractor",
        machineType: "Fluid Extractor",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "charcoal", amount: 100 }],
        outputs: [{ kind: "fluid", id: "woodtar", amount: 1000 }],
      },
      {
        id: "implicit-distillation-recipe",
        name: "Implicit Distillation",
        machineType: "Distillation Tower",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "woodtar", amount: 700 }],
        outputs: [{ kind: "fluid", id: "benzene", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("implicit-coke", "implicit-coke-recipe", 0),
      makeNode("implicit-extractor", "implicit-extractor-recipe", 240),
      makeNode("implicit-distillation", "implicit-distillation-recipe", 520),
    ],
    storages: [
      {
        id: "implicit-woodtar-tank",
        kind: "fluid",
        resourceId: "woodtar",
        position: { x: 380, y: 120 },
      },
    ],
    edges: [
      {
        id: "implicit-coke-to-extractor",
        source: "implicit-coke",
        target: "implicit-extractor",
        resourceKind: "item",
        resourceId: "charcoal",
      },
      {
        id: "implicit-coke-to-tank",
        source: "implicit-coke",
        target: "implicit-woodtar-tank",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
      {
        id: "implicit-extractor-to-tank",
        source: "implicit-extractor",
        target: "implicit-woodtar-tank",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
      {
        id: "implicit-tank-to-distillation",
        source: "implicit-woodtar-tank",
        target: "implicit-distillation",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
    ],
    fuelProfiles: [],
  };
}

function createDirectAndIndirectStorageOutputProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "direct-indirect-storage-output-optimization",
    name: "Direct and indirect storage output optimization",
    recipes: [
      {
        id: "coke-oven-recipe",
        name: "Coke Oven",
        machineType: "Coke Oven",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [],
        outputs: [
          { kind: "item", id: "charcoal", amount: 6.25 },
          { kind: "fluid", id: "woodtar", amount: 468.75 },
        ],
      },
      {
        id: "fluid-extractor-recipe",
        name: "Fluid Extractor",
        machineType: "Fluid Extractor",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "item", id: "charcoal", amount: 100 }],
        outputs: [{ kind: "fluid", id: "woodtar", amount: 10_000 }],
      },
      {
        id: "distillation-tower-recipe",
        name: "Distillation Tower",
        machineType: "Distillation Tower",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 1,
        inputs: [{ kind: "fluid", id: "woodtar", amount: 1_000 }],
        outputs: [{ kind: "fluid", id: "benzene", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("coke-oven", "coke-oven-recipe", 0),
      makeNode("fluid-extractor", "fluid-extractor-recipe", 240),
      {
        ...makeNode("distillation-tower", "distillation-tower-recipe", 520),
        targetOutput: {
          kind: "fluid",
          resourceId: "benzene",
          amountPerSecond: 1,
        },
      },
    ],
    storages: [
      { id: "woodtar-tank", kind: "fluid", resourceId: "woodtar", position: { x: 380, y: 120 } },
    ],
    edges: [
      {
        id: "coke-to-fluid-extractor",
        source: "coke-oven",
        target: "fluid-extractor",
        resourceKind: "item",
        resourceId: "charcoal",
      },
      {
        id: "coke-to-tank",
        source: "coke-oven",
        target: "woodtar-tank",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
      {
        id: "fluid-extractor-to-tank",
        source: "fluid-extractor",
        target: "woodtar-tank",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
      {
        id: "tank-to-distillation-tower",
        source: "woodtar-tank",
        target: "distillation-tower",
        resourceKind: "fluid",
        resourceId: "woodtar",
      },
    ],
    fuelProfiles: [],
  };
}

function makeNode(id: string, recipeId: string, x: number, y = 0) {
  return {
    id,
    recipeId,
    machineCount: 1,
    parallel: 1,
    overclockTier: "LV",
    enabled: true,
    position: { x, y },
  };
}

function createNakCoolantProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "nak-chain",
    name: "NaK chain",
    recipes: [
      {
        id: "fluid-heater-recipe",
        name: "Fluid Heater: Sodium",
        machineType: "Fluid Heater",
        minimumTier: "MV",
        durationTicks: 200,
        eut: 120,
        inputs: [{ kind: "item", id: "sodium_dust", amount: 1 }],
        outputs: [{ kind: "fluid", id: "liquid_sodium", amount: 1000 }],
      },
      {
        id: "distillery-recipe",
        name: "Distillery: Sodium Potassium",
        machineType: "Distillery",
        minimumTier: "LV",
        durationTicks: 400,
        eut: 30,
        inputs: [
          { kind: "item", id: "rock_salt", amount: 1 },
          { kind: "fluid", id: "liquid_sodium", amount: 1000 },
        ],
        outputs: [{ kind: "fluid", id: "sodium_potassium", amount: 1000 }],
      },
      {
        id: "fluid-canner-recipe",
        name: "Fluid Canner: 60k NaK Coolant Cell",
        machineType: "Fluid Canner",
        minimumTier: "LV",
        durationTicks: 200,
        eut: 30,
        inputs: [
          { kind: "item", id: "10k_cell", amount: 1 },
          { kind: "fluid", id: "sodium_potassium", amount: 1000 },
        ],
        outputs: [{ kind: "item", id: "60k_nak_coolant_cell", amount: 1 }],
      },
    ],
    nodes: [
      makeNode("fluid-heater", "fluid-heater-recipe", 0, 0),
      makeNode("distillery", "distillery-recipe", 300, 0),
      makeNode("fluid-canner", "fluid-canner-recipe", 600, 0),
    ],
    storages: [],
    edges: [],
    fuelProfiles: [],
  };
}

describe("board selection editing", () => {
  beforeEach(() => {
    useFactoryStore.getState().setProject(createSelectionEditingProject());
  });

  it("moves a whole dragged selection as one undo entry", () => {
    useFactoryStore.getState().moveBoardItems([
      { id: "alpha", position: { x: 100, y: 100 } },
      { id: "tank", position: { x: 500, y: 100 } },
      { id: "note", position: { x: 900, y: 100 } },
    ]);

    const { project, undoHistory } = useFactoryStore.getState();
    expect(project.nodes.find((node) => node.id === "alpha")?.position).toEqual({
      x: 100,
      y: 100,
    });
    expect(project.storages?.find((storage) => storage.id === "tank")?.position).toEqual({
      x: 500,
      y: 100,
    });
    expect(
      project.annotations?.find((annotation) => annotation.id === "note")?.position,
    ).toEqual({ x: 900, y: 100 });
    expect(undoHistory).toHaveLength(1);

    useFactoryStore.getState().undo();
    const restored = useFactoryStore.getState().project;
    expect(restored.nodes.find((node) => node.id === "alpha")?.position).toEqual({ x: 0, y: 0 });
    expect(restored.storages?.find((storage) => storage.id === "tank")?.position).toEqual({
      x: 400,
      y: 0,
    });
    expect(
      restored.annotations?.find((annotation) => annotation.id === "note")?.position,
    ).toEqual({ x: 800, y: 0 });
  });

  it("records no history for a drop where nothing moved", () => {
    useFactoryStore.getState().moveBoardItems([
      { id: "alpha", position: { x: 0, y: 0 } },
      { id: "missing", position: { x: 60, y: 60 } },
    ]);

    expect(useFactoryStore.getState().undoHistory).toHaveLength(0);
  });

  it("deletes a mixed selection and its wires as one undo entry", () => {
    useFactoryStore.getState().deleteBoardSelection({
      nodeIds: ["alpha", "tank", "note"],
      edgeIds: [],
    });

    const { project, undoHistory } = useFactoryStore.getState();
    expect(project.nodes.map((node) => node.id)).toEqual(["beta"]);
    expect(project.storages ?? []).toHaveLength(0);
    expect(project.annotations ?? []).toHaveLength(0);
    expect(project.edges).toHaveLength(0);
    expect(undoHistory).toHaveLength(1);

    useFactoryStore.getState().undo();
    const restored = useFactoryStore.getState().project;
    expect(restored.nodes).toHaveLength(2);
    expect(restored.storages).toHaveLength(1);
    expect(restored.annotations).toHaveLength(1);
    expect(restored.edges).toHaveLength(2);
  });

  it("pastes copies with fresh ids, remapped wires and shifted positions", () => {
    const source = useFactoryStore.getState().project;
    const payload = structuredClone({
      nodes: source.nodes,
      storages: source.storages ?? [],
      annotations: source.annotations ?? [],
      pockets: [],
      edges: source.edges,
      recipes: source.recipes,
    });

    const pastedIds = useFactoryStore.getState().pasteBoardItems(payload, { x: 40, y: 40 });

    const { project, undoHistory } = useFactoryStore.getState();
    expect(undoHistory).toHaveLength(1);
    expect(pastedIds).toHaveLength(4);
    expect(project.nodes).toHaveLength(4);
    expect(project.storages).toHaveLength(2);
    expect(project.annotations).toHaveLength(2);
    expect(project.edges).toHaveLength(4);

    const pastedNodes = project.nodes.filter((node) => !["alpha", "beta"].includes(node.id));
    expect(pastedNodes.map((node) => node.position)).toEqual([
      { x: 40, y: 40 },
      { x: 340, y: 40 },
    ]);

    const originalIds = new Set(["alpha", "beta", "tank", "note"]);
    const pastedEdges = project.edges.slice(2);
    expect(pastedEdges).toHaveLength(2);
    for (const edge of pastedEdges) {
      expect(originalIds.has(edge.source)).toBe(false);
      expect(originalIds.has(edge.target)).toBe(false);
    }
  });

  it("gives a pasted custom-rate card its own recipe copy", () => {
    const project = useFactoryStore.getState().project;
    const dialRecipe = {
      id: "dial-recipe",
      name: "Custom Rate",
      machineType: "Custom Rate",
      minimumTier: "NONE",
      durationTicks: 20,
      eut: 0,
      inputs: [],
      outputs: [{ kind: "item" as const, id: "dust", amount: 5 }],
    };
    const dialNode = makeNode("dial", "dial-recipe", 600, 0);
    useFactoryStore.getState().setProject({
      ...project,
      recipes: [...project.recipes, dialRecipe],
      nodes: [...project.nodes, dialNode],
    });

    const pastedIds = useFactoryStore.getState().pasteBoardItems(
      structuredClone({
        nodes: [dialNode],
        storages: [],
        annotations: [],
        pockets: [],
        edges: [],
        recipes: [dialRecipe],
      }),
      { x: 40, y: 40 },
    );

    const next = useFactoryStore.getState().project;
    const pastedNode = next.nodes.find((node) => node.id === pastedIds[0]);
    expect(pastedNode?.recipeId).toBeDefined();
    expect(pastedNode?.recipeId).not.toBe("dial-recipe");
    expect(next.recipes.filter((recipe) => recipe.machineType === "Custom Rate")).toHaveLength(2);
  });

  it("carries clipboard recipes into a design that lacks them", () => {
    const source = useFactoryStore.getState().project;
    const payload = structuredClone({
      nodes: source.nodes.filter((node) => node.id === "alpha"),
      storages: [],
      annotations: [],
      pockets: [],
      edges: [],
      recipes: source.recipes.filter((recipe) => recipe.id === "smelt"),
    });

    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "blank",
      name: "Blank",
      recipes: [],
      nodes: [],
      edges: [],
      fuelProfiles: [],
    });
    const pastedIds = useFactoryStore.getState().pasteBoardItems(payload, { x: 0, y: 0 });

    const project = useFactoryStore.getState().project;
    expect(pastedIds).toHaveLength(1);
    expect(project.recipes.map((recipe) => recipe.id)).toEqual(["smelt"]);
    expect(project.nodes[0]?.recipeId).toBe("smelt");
  });
});

function createSelectionEditingProject(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "selection-editing",
    name: "Selection editing",
    recipes: [
      {
        id: "smelt",
        name: "Smelter: Dust",
        machineType: "Smelter",
        minimumTier: "LV",
        durationTicks: 100,
        eut: 32,
        inputs: [{ kind: "item", id: "ore", amount: 1 }],
        outputs: [{ kind: "item", id: "dust", amount: 1 }],
      },
      {
        id: "press",
        name: "Press: Plate",
        machineType: "Press",
        minimumTier: "LV",
        durationTicks: 100,
        eut: 32,
        inputs: [{ kind: "item", id: "dust", amount: 1 }],
        outputs: [{ kind: "item", id: "plate", amount: 1 }],
      },
    ],
    nodes: [makeNode("alpha", "smelt", 0, 0), makeNode("beta", "press", 300, 0)],
    storages: [
      {
        id: "tank",
        kind: "item",
        resourceId: "dust",
        position: { x: 400, y: 0 },
      },
    ],
    annotations: [
      {
        id: "note",
        kind: "text",
        text: "hello",
        position: { x: 800, y: 0 },
        size: { width: 200, height: 100 },
      },
    ],
    edges: [
      {
        id: "a2b",
        source: "alpha",
        target: "beta",
        resourceKind: "item",
        resourceId: "dust",
      },
      {
        id: "a2t",
        source: "alpha",
        target: "tank",
        resourceKind: "item",
        resourceId: "dust",
      },
    ],
    fuelProfiles: [],
  };
}

/**
 * A legacy pocket, the way an old plan carries one: members tagged, no
 * size, never opened — its member coordinates are still their own space.
 */
function seedLegacyPocket(ids: string[], name = "Smeltery"): string {
  const base = createSelectionEditingProject();
  const selected = new Set(ids);
  const tag = <T extends { id: string; pocketId?: string }>(item: T): T =>
    selected.has(item.id) ? { ...item, pocketId: "legacy-pocket" } : item;
  useFactoryStore.getState().setProject({
    ...base,
    nodes: base.nodes.map(tag),
    storages: base.storages?.map(tag),
    annotations: base.annotations?.map(tag),
    pockets: [{ id: "legacy-pocket", name, position: { x: 200, y: 0 } }],
  });
  return "legacy-pocket";
}

describe("minimized boards (the whole pocket story)", () => {
  beforeEach(() => {
    useFactoryStore.getState().setProject(createSelectionEditingProject());
  });

  it("wraps a selection in a board without touching a single wire", () => {
    const before = useFactoryStore.getState().project;
    const boardId = useFactoryStore
      .getState()
      .wrapSelectionInBoard(["alpha", "tank"], "Smeltery");

    const { project, undoHistory } = useFactoryStore.getState();
    expect(boardId).toBeDefined();
    expect(project.pockets).toHaveLength(1);
    const board = project.pockets?.[0];
    expect(board?.name).toBe("Smeltery");
    // The frame appears OPEN around the cards, fitted with a title bar and
    // a cell of air; nothing is collapsed and nothing teleports.
    expect(board?.expanded).toBe(true);
    expect(board?.size).toBeDefined();
    const corner = board?.position as { x: number; y: number };
    const alpha = project.nodes.find((node) => node.id === "alpha");
    expect(alpha?.pocketId).toBe(boardId);
    // Frame-relative position + frame corner = the exact old screen spot.
    expect({ x: corner.x + (alpha?.position.x ?? 0), y: corner.y + (alpha?.position.y ?? 0) }).toEqual(
      { x: 0, y: 0 },
    );
    expect(project.nodes.find((node) => node.id === "beta")?.pocketId).toBeUndefined();
    // Wires have nothing to do with boards: every edge survives verbatim.
    expect(project.edges).toEqual(before.edges);
    expect(undoHistory).toHaveLength(1);
  });

  it("unwrapping a legacy pocket spills members without inventing wires", () => {
    // Assembled outside the store (an import, an old plan): the source
    // feeds only one of two identical consumers. The old convergence rule
    // would have fanned the wire out; boards leave wiring alone.
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "drift",
      name: "Drift",
      recipes: [
        {
          id: "gen",
          name: "Cobble Gen",
          machineType: "Gen",
          minimumTier: "LV",
          durationTicks: 20,
          eut: 8,
          inputs: [],
          outputs: [{ kind: "item", id: "cobblestone", amount: 1 }],
        },
        {
          id: "melt",
          name: "Melter",
          machineType: "Melter",
          minimumTier: "LV",
          durationTicks: 20,
          eut: 8,
          inputs: [{ kind: "item", id: "cobblestone", amount: 20 }],
          outputs: [{ kind: "fluid", id: "lava", amount: 10 }],
        },
      ],
      nodes: [
        makeNode("source", "gen", 0, 0),
        { ...makeNode("melt-a", "melt", 300, 0), pocketId: "pocket-x" },
        { ...makeNode("melt-b", "melt", 300, 300), pocketId: "pocket-x" },
      ],
      pockets: [{ id: "pocket-x", name: "Lava works", position: { x: 300, y: 0 } }],
      edges: [
        { id: "s2a", source: "source", target: "melt-a", resourceKind: "item", resourceId: "cobblestone" },
      ],
      fuelProfiles: [],
    });

    useFactoryStore.getState().dissolvePocket("pocket-x");

    const project = useFactoryStore.getState().project;
    expect(project.pockets ?? []).toHaveLength(0);
    expect(project.edges).toHaveLength(1);
    expect(project.nodes.find((node) => node.id === "melt-a")?.pocketId).toBeUndefined();
    // Legacy coordinates surface verbatim, exactly as unpacking always did.
    expect(project.nodes.find((node) => node.id === "melt-a")?.position).toEqual({ x: 300, y: 0 });
  });

  it("unwrapping a wrapped board leaves everything standing where it was", () => {
    const boardId = useFactoryStore
      .getState()
      .wrapSelectionInBoard(["alpha", "tank"]) as string;
    useFactoryStore.getState().dissolvePocket(boardId);

    const project = useFactoryStore.getState().project;
    expect(project.pockets).toHaveLength(0);
    expect(project.nodes.find((node) => node.id === "alpha")?.pocketId).toBeUndefined();
    expect(project.nodes.find((node) => node.id === "alpha")?.position).toEqual({ x: 0, y: 0 });
    expect(project.storages?.find((storage) => storage.id === "tank")?.position).toEqual({
      x: 400,
      y: 0,
    });
  });

  it("nests boards and re-parents children when the middle one unwraps", () => {
    const inner = useFactoryStore.getState().wrapSelectionInBoard(["alpha"]) as string;
    const outer = useFactoryStore.getState().wrapSelectionInBoard([inner, "beta"]) as string;

    let project = useFactoryStore.getState().project;
    expect(project.pockets?.find((pocket) => pocket.id === inner)?.parentPocketId).toBe(outer);

    useFactoryStore.getState().dissolvePocket(outer);
    project = useFactoryStore.getState().project;
    expect(project.pockets?.find((pocket) => pocket.id === inner)?.parentPocketId).toBeUndefined();
    expect(project.nodes.find((node) => node.id === "beta")?.pocketId).toBeUndefined();
    expect(project.nodes.find((node) => node.id === "alpha")?.pocketId).toBe(inner);
  });

  it("captures a board as its whole contents", () => {
    const boardId = useFactoryStore
      .getState()
      .wrapSelectionInBoard(["alpha", "beta"]) as string;

    const payload = captureBoardSelection(useFactoryStore.getState().project, [boardId]);
    expect(payload).toBeDefined();
    expect(payload?.pockets.map((pocket) => pocket.id)).toEqual([boardId]);
    expect(payload?.nodes.map((node) => node.id).sort()).toEqual(["alpha", "beta"]);
    // alpha→beta runs between two captured cards, so it comes along.
    expect(payload?.edges.map((edge) => edge.id)).toEqual(["a2b"]);
  });

  it("pastes a board as a fresh copy and selects only the board itself", () => {
    const boardId = useFactoryStore
      .getState()
      .wrapSelectionInBoard(["alpha", "beta"]) as string;
    const payload = captureBoardSelection(useFactoryStore.getState().project, [
      boardId,
    ]) as NonNullable<ReturnType<typeof captureBoardSelection>>;

    const pastedIds = useFactoryStore.getState().pasteBoardItems(payload, { x: 40, y: 40 });

    const project = useFactoryStore.getState().project;
    expect(project.pockets).toHaveLength(2);
    const newBoard = project.pockets?.find((pocket) => pocket.id !== boardId);
    // Only the board surfaces at the root; its members ride inside it.
    expect(pastedIds).toEqual([newBoard?.id]);
    const pastedMembers = project.nodes.filter((node) => node.pocketId === newBoard?.id);
    expect(pastedMembers).toHaveLength(2);
    // The interior wire was remapped onto the copies, inside the new board.
    expect(project.edges).toHaveLength(3);
  });

  it("deleting a board deletes everything in it", () => {
    const boardId = useFactoryStore
      .getState()
      .wrapSelectionInBoard(["alpha", "beta"]) as string;
    useFactoryStore.getState().deleteBoardSelection({ nodeIds: [boardId] });

    const { project, undoHistory } = useFactoryStore.getState();
    expect(project.pockets).toHaveLength(0);
    expect(project.nodes).toHaveLength(0);
    expect(project.edges).toHaveLength(0);
    // Wrap + delete = two undo entries.
    expect(undoHistory).toHaveLength(2);
  });

  it("a drawer dragged off a member's port joins the member's board", () => {
    const boardId = useFactoryStore.getState().wrapSelectionInBoard(["beta"]) as string;
    const corner = useFactoryStore
      .getState()
      .project.pockets?.find((pocket) => pocket.id === boardId)?.position as {
      x: number;
      y: number;
    };

    useFactoryStore
      .getState()
      .addStorageForConnection(
        { kind: "item", id: "plate", displayName: "Plate" },
        "beta",
        "output",
        { x: 600, y: 0 },
        makeResourceHandleId("output", { kind: "item", id: "plate" }, 0),
      );

    const project = useFactoryStore.getState().project;
    const plate = project.storages?.find((storage) => storage.resourceId === "plate");
    expect(plate?.pocketId).toBe(boardId);
    // Position converts into the frame's own space, so the drawer stands at
    // the asked-for screen spot.
    expect({ x: corner.x + (plate?.position.x ?? 0), y: corner.y + (plate?.position.y ?? 0) }).toEqual(
      { x: 600, y: 0 },
    );
  });

  it("new drawers, notes and pasted cards land on the canvas", () => {
    useFactoryStore.getState().wrapSelectionInBoard(["alpha"]);
    useFactoryStore.getState().addResourceStorage({
      kind: "item",
      id: "plate",
      displayName: "Plate",
      iconPath: undefined,
      iconAtlas: undefined,
      dominantColor: undefined,
    });
    useFactoryStore.getState().addAnnotation({
      kind: "text",
      text: "outside",
      position: { x: 0, y: 400 },
      size: { width: 200, height: 100 },
    });
    const payload = captureBoardSelection(useFactoryStore.getState().project, [
      "beta",
    ]) as NonNullable<ReturnType<typeof captureBoardSelection>>;
    const pastedIds = useFactoryStore.getState().pasteBoardItems(payload, { x: 40, y: 40 });

    const project = useFactoryStore.getState().project;
    expect(
      project.storages?.find((storage) => storage.resourceId === "plate")?.pocketId,
    ).toBeUndefined();
    expect(project.annotations?.find((note) => note.text === "outside")?.pocketId).toBeUndefined();
    expect(project.nodes.find((node) => node.id === pastedIds[0])?.pocketId).toBeUndefined();
  });
});

describe("boards (pockets standing open)", () => {
  beforeEach(() => {
    useFactoryStore.getState().setProject(createSelectionEditingProject());
  });

  it("draws a board that adopts covered cards without moving them on screen", () => {
    const before = useFactoryStore.getState().project;
    const boardId = useFactoryStore.getState().createBoard({
      position: { x: -40, y: -80 },
      size: { width: 480, height: 320 },
      memberIds: ["alpha", "tank"],
    }) as string;

    const project = useFactoryStore.getState().project;
    const board = project.pockets?.find((pocket) => pocket.id === boardId);
    expect(board?.expanded).toBe(true);
    expect(board?.size).toEqual({ width: 480, height: 320 });
    // Members convert to frame space: same screen spot, measured from the
    // frame corner. alpha stood at (0,0), the corner at (-40,-80).
    expect(project.nodes.find((node) => node.id === "alpha")?.pocketId).toBe(boardId);
    expect(project.nodes.find((node) => node.id === "alpha")?.position).toEqual({ x: 40, y: 80 });
    expect(project.storages?.find((storage) => storage.id === "tank")?.position).toEqual({
      x: 440,
      y: 80,
    });
    expect(project.nodes.find((node) => node.id === "beta")?.pocketId).toBeUndefined();
    // A board says nothing about wiring: every edge survives verbatim, and
    // no convergence fan-out is added.
    expect(project.edges).toEqual(before.edges);
  });

  it("opens a legacy pocket as a board, fitting the frame around its members", () => {
    const pocketId = seedLegacyPocket(["alpha", "tank"]);
    useFactoryStore.getState().expandPocket(pocketId);

    const project = useFactoryStore.getState().project;
    const board = project.pockets?.find((pocket) => pocket.id === pocketId);
    expect(board?.expanded).toBe(true);
    // Members rebase to sit under the title bar (40) with one cell of air:
    // the bbox corner (0,0) lands at (20, 60), everything shifting together.
    expect(project.nodes.find((node) => node.id === "alpha")?.position).toEqual({ x: 20, y: 60 });
    expect(project.storages?.find((storage) => storage.id === "tank")?.position).toEqual({
      x: 420,
      y: 60,
    });
    // The frame fits the estimated footprints, in whole cells.
    expect(board?.size).toBeDefined();
    expect((board?.size?.width ?? 0) % 20).toBe(0);
    expect((board?.size?.height ?? 0) % 20).toBe(0);
    expect(board?.size?.width ?? 0).toBeGreaterThanOrEqual(500);
  });

  it("drops hand-pinned waypoints on wires touching members when a board opens", () => {
    const base = createSelectionEditingProject();
    base.edges = base.edges.map((edge) =>
      edge.id === "a2b" ? { ...edge, waypoints: [{ x: 200, y: 100 }] } : edge,
    );
    base.nodes = base.nodes.map((node) =>
      node.id === "alpha" ? { ...node, pocketId: "legacy-pocket" } : node,
    );
    base.pockets = [{ id: "legacy-pocket", name: "Smeltery", position: { x: 200, y: 0 } }];
    useFactoryStore.getState().setProject(base);
    useFactoryStore.getState().expandPocket("legacy-pocket");

    const edge = useFactoryStore.getState().project.edges.find((entry) => entry.id === "a2b");
    expect(edge?.waypoints).toBeUndefined();
  });

  it("folds a board down to its minimized card and reopens it in place", () => {
    const pocketId = seedLegacyPocket(["alpha", "tank"]);
    useFactoryStore.getState().expandPocket(pocketId);
    const opened = useFactoryStore.getState().project;
    const openedAlpha = opened.nodes.find((node) => node.id === "alpha")?.position;
    const openedSize = opened.pockets?.find((pocket) => pocket.id === pocketId)?.size;

    useFactoryStore.getState().minimizePocket(pocketId);
    const folded = useFactoryStore.getState().project;
    expect(folded.pockets?.find((pocket) => pocket.id === pocketId)?.expanded).toBe(false);
    // Members keep their frame-space coordinates while hidden...
    expect(folded.nodes.find((node) => node.id === "alpha")?.position).toEqual(openedAlpha);

    // ...so reopening is stable: no drift, same frame.
    useFactoryStore.getState().expandPocket(pocketId);
    const reopened = useFactoryStore.getState().project;
    expect(reopened.nodes.find((node) => node.id === "alpha")?.position).toEqual(openedAlpha);
    expect(reopened.pockets?.find((pocket) => pocket.id === pocketId)?.size).toEqual(openedSize);
  });

  it("opens a collapsed group with a frame as it closed: members stay where they were", () => {
    const base = createSelectionEditingProject();
    base.nodes = base.nodes.map((node) =>
      node.id === "alpha" ? { ...node, pocketId: "game-group", position: { x: 40, y: 100 } } : node,
    );
    base.pockets = [
      { id: "game-group", name: "Group 1", position: { x: 120, y: 60 }, size: { width: 500, height: 400 } },
    ];
    useFactoryStore.getState().setProject(base);
    useFactoryStore.getState().expandPocket("game-group");

    const project = useFactoryStore.getState().project;
    const group = project.pockets?.find((pocket) => pocket.id === "game-group");
    expect(group?.expanded).toBe(true);
    expect(group?.position).toEqual({ x: 120, y: 60 });
    expect(group?.size).toEqual({ width: 500, height: 400 });
    expect(project.nodes.find((node) => node.id === "alpha")?.position).toEqual({ x: 40, y: 100 });
  });

  it("re-homes a dropped card through moveBoardItems and never resizes the board", () => {
    const boardId = useFactoryStore.getState().createBoard({
      position: { x: 600, y: 200 },
      size: { width: 480, height: 320 },
    }) as string;

    useFactoryStore
      .getState()
      .moveBoardItems([{ id: "beta", position: { x: 40, y: 60 }, owner: { pocketId: boardId } }]);
    let project = useFactoryStore.getState().project;
    expect(project.nodes.find((node) => node.id === "beta")?.pocketId).toBe(boardId);
    expect(project.nodes.find((node) => node.id === "beta")?.position).toEqual({ x: 40, y: 60 });
    // A board's walls are the player's to set: a drop never moves them.
    expect(project.pockets?.find((pocket) => pocket.id === boardId)?.size).toEqual({
      width: 480,
      height: 320,
    });

    // Dragging it back out surfaces it on the canvas.
    useFactoryStore
      .getState()
      .moveBoardItems([
        { id: "beta", position: { x: 300, y: 0 }, owner: { pocketId: undefined } },
      ]);
    project = useFactoryStore.getState().project;
    expect(project.nodes.find((node) => node.id === "beta")?.pocketId).toBeUndefined();
    expect(project.nodes.find((node) => node.id === "beta")?.position).toEqual({ x: 300, y: 0 });
  });

  it("refuses to make a board its own descendant", () => {
    const outerId = useFactoryStore.getState().createBoard({ position: { x: 0, y: 0 } }) as string;
    const innerId = useFactoryStore
      .getState()
      .createBoard({ position: { x: 1000, y: 0 } }) as string;
    useFactoryStore
      .getState()
      .moveBoardItems([
        { id: innerId, position: { x: 40, y: 60 }, owner: { pocketId: outerId } },
      ]);
    expect(
      useFactoryStore.getState().project.pockets?.find((pocket) => pocket.id === innerId)
        ?.parentPocketId,
    ).toBe(outerId);

    // The loop: dropping the outer board into its own child keeps its home.
    useFactoryStore
      .getState()
      .moveBoardItems([
        { id: outerId, position: { x: 20, y: 80 }, owner: { pocketId: innerId } },
      ]);
    const outer = useFactoryStore
      .getState()
      .project.pockets?.find((pocket) => pocket.id === outerId);
    expect(outer?.parentPocketId).toBeUndefined();
    // The position still lands; only the impossible re-homing is refused.
    expect(outer?.position).toEqual({ x: 20, y: 80 });
  });

  it("dissolving an open board leaves members standing where they were on screen", () => {
    const boardId = useFactoryStore.getState().createBoard({
      position: { x: -40, y: -80 },
      memberIds: ["alpha", "tank"],
    }) as string;
    const before = useFactoryStore.getState().project.edges;

    useFactoryStore.getState().dissolvePocket(boardId);
    const project = useFactoryStore.getState().project;
    expect(project.pockets ?? []).toHaveLength(0);
    expect(project.nodes.find((node) => node.id === "alpha")?.pocketId).toBeUndefined();
    expect(project.nodes.find((node) => node.id === "alpha")?.position).toEqual({ x: 0, y: 0 });
    expect(project.storages?.find((storage) => storage.id === "tank")?.position).toEqual({
      x: 400,
      y: 0,
    });
    // No convergence on the way out either: an open board's wires were
    // always the real member wires.
    expect(project.edges).toEqual(before);
  });

  it("pastes an open board without shifting its members twice", () => {
    const boardId = useFactoryStore.getState().createBoard({
      position: { x: -40, y: -80 },
      memberIds: ["alpha"],
    }) as string;
    const payload = captureBoardSelection(useFactoryStore.getState().project, [
      boardId,
    ]) as NonNullable<ReturnType<typeof captureBoardSelection>>;

    const pastedIds = useFactoryStore.getState().pasteBoardItems(payload, { x: 200, y: 0 });
    const project = useFactoryStore.getState().project;
    const pastedBoard = project.pockets?.find((pocket) => pocket.id === pastedIds[0]);
    expect(pastedBoard?.expanded).toBe(true);
    // The frame moved by the offset; the member kept its frame-relative spot.
    expect(pastedBoard?.position).toEqual({ x: 160, y: -80 });
    const pastedMember = project.nodes.find(
      (node) => node.pocketId === pastedBoard?.id,
    );
    expect(pastedMember?.position).toEqual({ x: 40, y: 80 });
  });
});

describe("cycled input picks", () => {
  const CIRCUIT_RECIPE = {
    id: "assembler-lv-machine",
    name: "Assembler: LV Machine Hull",
    machineType: "Assembler",
    minimumTier: "LV",
    durationTicks: 200,
    eut: 30,
    inputs: [
      {
        kind: "item" as const,
        id: "oredict:circuitBasic",
        amount: 2,
        displayName: "Ore Dictionary: circuitBasic",
        alternatives: [
          { kind: "item" as const, id: "gregtech:circuit@1", displayName: "Electronic Circuit" },
          {
            kind: "item" as const,
            id: "gregtech:circuit@2",
            displayName: "Integrated Logic Circuit",
          },
        ],
      },
      { kind: "item" as const, id: "gregtech:plate@steel", amount: 4, displayName: "Steel Plate" },
    ],
    outputs: [{ kind: "item" as const, id: "gregtech:hull@lv", amount: 1 }],
  };

  beforeEach(() => {
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "input-picks-test",
      name: "Input picks test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });
  });

  it("pins the slot to the face that was showing when the node was added", () => {
    useFactoryStore.getState().addNodeForRecipeObject(CIRCUIT_RECIPE, undefined, {
      inputPicks: {
        0: {
          kind: "item",
          id: "gregtech:circuit@2",
          displayName: "Integrated Logic Circuit",
          amount: 1,
        },
      },
    });

    const node = useFactoryStore.getState().project.nodes[0];
    expect(node?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({
        id: "gregtech:circuit@2",
        displayName: "Integrated Logic Circuit",
        alternatives: undefined,
      }),
    );
    // The recipe still asks for two of them: a face carries a per-unit ratio,
    // not a stack size.
    expect(node?.recipeInputOverrides?.["0"]?.amount).toBe(2);
  });

  it("leaves the shared recipe generic so other nodes are unaffected", () => {
    useFactoryStore.getState().addNodeForRecipeObject(CIRCUIT_RECIPE, undefined, {
      inputPicks: {
        0: { kind: "item", id: "gregtech:circuit@2", displayName: "Integrated Logic Circuit" },
      },
    });

    expect(useFactoryStore.getState().project.recipes[0]?.inputs[0]).toEqual(
      expect.objectContaining({ id: "oredict:circuitBasic" }),
    );
  });

  it("does not touch slots that were never cycled", () => {
    useFactoryStore.getState().addNodeForRecipeObject(CIRCUIT_RECIPE, undefined, {
      inputPicks: {
        0: { kind: "item", id: "gregtech:circuit@1", displayName: "Electronic Circuit" },
      },
    });

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["1"]).toBeUndefined();
  });

  it("writes no overrides at all when nothing cycled", () => {
    useFactoryStore.getState().addNodeForRecipeObject(CIRCUIT_RECIPE, undefined, {
      inputPicks: {},
    });

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides).toBeUndefined();
  });

  it("lets a scrolled slot outrank the resource the browser was opened from", () => {
    useFactoryStore.getState().addNodeForRecipeObject(
      CIRCUIT_RECIPE,
      { kind: "item", id: "gregtech:circuit@1", displayName: "Electronic Circuit", mode: "uses" },
      {
        inputPicks: {
          0: { kind: "item", id: "gregtech:circuit@2", displayName: "Integrated Logic Circuit" },
        },
      },
    );

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides?.["0"]).toEqual(
      expect.objectContaining({ id: "gregtech:circuit@2" }),
    );
  });

  it("ignores a pick for a slot the recipe does not have", () => {
    useFactoryStore.getState().addNodeForRecipeObject(CIRCUIT_RECIPE, undefined, {
      inputPicks: { 7: { kind: "item", id: "gregtech:circuit@2" } },
    });

    expect(useFactoryStore.getState().project.nodes[0]?.recipeInputOverrides).toBeUndefined();
  });
});

describe("swapping the mob in an Extreme Entity Crusher", () => {
  const eecMeta = (mob: string) => ({
    eec: { mob, maxHealth: 20, baseEut: 1920, outputs: [] as unknown[] },
  });
  const mob = (id: string, outputs: Array<{ kind: "item" | "fluid"; id: string; amount: number }>) => ({
    id,
    name: `Extreme Entity Crusher: ${id}`,
    machineType: "Extreme Entity Crusher",
    minimumTier: "EV" as const,
    durationTicks: 55,
    eut: 1920,
    inputs: [{ kind: "item" as const, id: `factoryflow:eec_mob:${id}`, amount: 1, consumed: false }],
    outputs,
    metadata: eecMeta(id),
  });
  const ZOMBIE = mob("zombie", [
    { kind: "item", id: "minecraft:rotten_flesh", amount: 1 },
    { kind: "fluid", id: "xpjuice", amount: 120 },
  ]);
  const SKELETON = mob("skeleton", [
    { kind: "item", id: "minecraft:arrow", amount: 1 },
    { kind: "item", id: "minecraft:bone", amount: 1 },
    { kind: "fluid", id: "xpjuice", amount: 120 },
  ]);
  const taker = (id: string, resource: { kind: "item" | "fluid"; id: string }) => ({
    id,
    name: id,
    machineType: "Taker",
    minimumTier: "LV" as const,
    durationTicks: 20,
    eut: 8,
    inputs: [{ ...resource, amount: 1 }],
    outputs: [{ kind: "item" as const, id: `${id}-out`, amount: 1 }],
  });
  const card = (id: string, recipeId: string, x: number, extra: object = {}) => ({
    id,
    recipeId,
    machineCount: 1,
    parallel: 1,
    overclockTier: "LV" as const,
    enabled: true,
    position: { x, y: 0 },
    ...extra,
  });
  const PROJECT = (): FactoryProject => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "eec-swap",
    name: "EEC swap",
    fuelProfiles: [],
    recipes: [
      ZOMBIE,
      taker("flesh-eater", { kind: "item", id: "minecraft:rotten_flesh" }),
      taker("xp-user", { kind: "fluid", id: "xpjuice" }),
    ],
    nodes: [
      card("eec", "zombie", 0, {
        machineCount: 3,
        overclockTier: "IV",
        hatchVoltageTier: "IV",
        hatchAmps: 4,
        machineConfigTiers: { eecLooting: "3", eecWeaponDamage: "13.25", eecInfernal: "off" },
      }),
      card("eater", "flesh-eater", 440),
      card("xp", "xp-user", 440),
    ],
    edges: [
      { id: "e-flesh", source: "eec", target: "eater", resourceKind: "item", resourceId: "minecraft:rotten_flesh" },
      { id: "e-xp", source: "eec", target: "xp", resourceKind: "fluid", resourceId: "xpjuice" },
    ],
    storages: [],
    metadata: { createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" },
  });

  it("changes the mob in place and keeps the machine exactly as built", () => {
    useFactoryStore.getState().setProject(PROJECT());
    const before = useFactoryStore.getState().project.nodes.find((entry) => entry.id === "eec")!;

    useFactoryStore.getState().swapMachineRecipe("eec", SKELETON);

    const state = useFactoryStore.getState();
    const eec = state.project.nodes.find((entry) => entry.id === "eec")!;
    expect(state.project.nodes).toHaveLength(3);
    expect(eec.recipeId).toBe("skeleton");
    expect({ ...eec, recipeId: before.recipeId }).toEqual(before);
    // The XP wire still has a port; rotten flesh does not.
    expect(state.project.edges.map((edge) => edge.id)).toEqual(["e-xp"]);
    expect(state.project.edges[0].sourceHandle).toBe(
      makeResourceHandleId("output", SKELETON.outputs[2], 2),
    );
  });

  it("swaps even when no wire survives, and undoes in one step", () => {
    const project = PROJECT();
    project.edges = project.edges.filter((edge) => edge.id === "e-flesh");
    useFactoryStore.getState().setProject(project);

    useFactoryStore.getState().swapMachineRecipe("eec", SKELETON);
    expect(useFactoryStore.getState().project.nodes.map((entry) => entry.recipeId)).toEqual([
      "skeleton",
      "flesh-eater",
      "xp-user",
    ]);
    expect(useFactoryStore.getState().project.edges).toEqual([]);

    useFactoryStore.getState().undo();
    const restored = useFactoryStore.getState().project;
    expect(restored.nodes.find((entry) => entry.id === "eec")?.recipeId).toBe("zombie");
    expect(restored.edges.map((edge) => edge.id)).toEqual(["e-flesh"]);
  });

  it("never takes a second recipe: the controller holds one spawner", () => {
    useFactoryStore.getState().setProject(PROJECT());
    expect(useFactoryStore.getState().addRecipeToNode("eec", SKELETON)).toBe(false);
  });
});

describe("the active dataset follows the open plan", () => {
  const manifest = {
    schemaVersion: 1,
    latestStableVersion: "local-2.9.0-rc-2",
    versions: [
      { id: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2", publishedAt: "2026-10-23T00:00:00.000Z" },
      { id: "local-2.8.1", gtnhVersion: "2.8.1", publishedAt: "2026-10-23T00:00:00.000Z" },
    ],
  } as unknown as DatasetManifest;
  const catalog = (id: string, gtnhVersion: string): RecipeDataset =>
    ({
      schemaVersion: 1,
      datasetVersionId: id,
      gtnhVersion,
      resources: [{ id: "dust", kind: "item", displayName: "Dust", iconPath: `/${id}/dust.png` }],
      recipes: [],
      oreDictionary: {},
      recipeMaps: [],
    }) as unknown as RecipeDataset;
  const dataset29 = catalog("local-2.9.0-rc-2", "2.9.0-RC-2");
  const dataset281 = catalog("local-2.8.1", "2.8.1");
  const datasetRecipe = (id: string, datasetVersionId: string): Recipe => ({
    id,
    name: id,
    machineType: "Macerator",
    minimumTier: "LV",
    durationTicks: 20,
    eut: 2,
    inputs: [{ kind: "item", id: "ore", amount: 1 }],
    outputs: [{ kind: "item", id: "dust", amount: 1 }],
    source: { datasetVersionId },
  });
  const plan = (id: string, gameVersion?: string): FactoryProject => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    name: id,
    ...(gameVersion ? { gameVersion } : {}),
    planMode: true,
    fuelProfiles: [],
    recipes: [datasetRecipe("on-board", gameVersion === "2.8.1" ? "local-2.8.1" : "local-2.9.0-rc-2")],
    nodes: [{ id: "n1", recipeId: "on-board", position: { x: 0, y: 0 }, machineCount: 1, parallel: 1, overclockTier: "LV", enabled: true }],
    edges: [],
  });

  /** Loads that resolve only when the test says so. */
  let pending: Map<string, (dataset: RecipeDataset) => void>;
  let loads: string[];

  beforeEach(async () => {
    pending = new Map();
    loads = [];
    replaceDatasetCacheForTests(
      new DatasetCache(
        (_url: string, version: DatasetVersion) =>
          new Promise<RecipeDataset>((resolve) => {
            loads.push(version.id);
            pending.set(version.id, resolve);
          }),
      ),
    );
    useFactoryStore.setState({ dataset: undefined, selectedDatasetVersionId: undefined, isDatasetLoading: false });
    useFactoryStore.getState().setDatasetManifest(manifest, "/m.json");
    useFactoryStore.getState().setProject(plan("plan-29"));
    const boot = useFactoryStore.getState().ensureDatasetFor("2.9");
    pending.get("local-2.9.0-rc-2")!(dataset29);
    await boot;
  });

  it("switching tabs mid-load lands the right dataset", async () => {
    expect(useFactoryStore.getState().dataset).toBe(dataset29);
    const plan281 = plan("plan-281", "2.8.1");
    const before281 = JSON.stringify(plan281);

    // To a 2.8.1 tab: its dataset starts loading, the 2.9 one stays until it lands.
    useFactoryStore.getState().setProject(plan281);
    const load281 = useFactoryStore.getState().ensureDatasetFor("2.8.1");
    expect(useFactoryStore.getState().isDatasetLoading).toBe(true);
    expect(useFactoryStore.getState().dataset).toBe(dataset29);

    // Back to a 2.9 tab before the load resolves: the cached 2.9 dataset, at once.
    useFactoryStore.getState().setProject(plan("plan-29b"));
    const project29 = useFactoryStore.getState().project;
    await useFactoryStore.getState().ensureDatasetFor("2.9");
    expect(useFactoryStore.getState().isDatasetLoading).toBe(false);

    // The 2.8.1 load lands late: it only fills the cache.
    pending.get("local-2.8.1")!(dataset281);
    expect(await load281).toBe(dataset281);
    expect(useFactoryStore.getState().dataset).toBe(dataset29);
    expect(useFactoryStore.getState().selectedDatasetVersionId).toBe("local-2.9.0-rc-2");
    expect(useFactoryStore.getState().project).toBe(project29);
    expect(JSON.stringify(plan281)).toBe(before281);

    // The 2.8.1 tab again: no second load, its dataset becomes the active one.
    useFactoryStore.getState().setProject(plan281);
    await useFactoryStore.getState().ensureDatasetFor("2.8.1");
    expect(loads).toEqual(["local-2.9.0-rc-2", "local-2.8.1"]);
    expect(useFactoryStore.getState().dataset).toBe(dataset281);
    expect(useFactoryStore.getState().selectedDatasetVersionId).toBe("local-2.8.1");
  });

  it("recipe add is refused while the plan's dataset loads", async () => {
    useFactoryStore.getState().setProject(plan("plan-281", "2.8.1"));
    const load281 = useFactoryStore.getState().ensureDatasetFor("2.8.1");
    const store = () => useFactoryStore.getState();
    const before = store().project;
    const recipe29 = datasetRecipe("from-2.9", "local-2.9.0-rc-2");

    store().addNodeForRecipeObject(recipe29);
    store().addConnectedNodeForRecipeObject(recipe29, "n1", { kind: "item", id: "dust", mode: "uses" });
    store().refactorNodeWithRecipe("n1", recipe29);
    store().swapMachineRecipe("n1", recipe29);
    store().setNodeRecipe("n1", recipe29);
    expect(store().addRecipeToNode("n1", recipe29)).toBe(false);
    // A body from a dataset the manifest does not list waits for the plan's own version.
    store().addNodeForRecipeObject(datasetRecipe("old-build", "local-2.9.0-rc-1"));
    expect(store().project).toBe(before);

    // Its own dataset lands: adds go through.
    pending.get("local-2.8.1")!(dataset281);
    await load281;
    store().addNodeForRecipeObject(datasetRecipe("from-2.8.1", "local-2.8.1"));
    expect(store().project.nodes).toHaveLength(2);
  });

  it("a pick fetched on one version is refused on a tab of the other, both cached", async () => {
    // Both catalogs cached and the 2.8.1 tab open: switching is instant, so a 2.9 body
    // fetched before the switch arrives while the 2.8.1 dataset is already the active one.
    useFactoryStore.getState().setProject(plan("plan-281", "2.8.1"));
    const load281 = useFactoryStore.getState().ensureDatasetFor("2.8.1");
    pending.get("local-2.8.1")!(dataset281);
    await load281;
    expect(useFactoryStore.getState().dataset).toBe(dataset281);
    const before = useFactoryStore.getState().project;
    const recipe29 = datasetRecipe("from-2.9", "local-2.9.0-rc-2");
    useFactoryStore.getState().addNodeForRecipeObject(recipe29);
    useFactoryStore.getState().refactorNodeWithRecipe("n1", recipe29);
    expect(useFactoryStore.getState().addRecipeToNode("n1", recipe29)).toBe(false);
    expect(useFactoryStore.getState().project).toBe(before);
  });

  it("a 2.9 plan takes picks as soon as the manifest names its version, before the catalog", () => {
    useFactoryStore.setState({ dataset: undefined, selectedDatasetVersionId: undefined });
    useFactoryStore.getState().setDatasetManifest(manifest, "/m.json");
    useFactoryStore.getState().setProject(plan("plan-29"));
    useFactoryStore.getState().addNodeForRecipeObject(datasetRecipe("from-2.9", "local-2.9.0-rc-2"));
    expect(useFactoryStore.getState().project.nodes).toHaveLength(2);
  });

  it("setDataset for another family does not touch the open project", () => {
    useFactoryStore.getState().setProject(plan("plan-281", "2.8.1"));
    const project = useFactoryStore.getState().project;
    useFactoryStore.getState().setDataset(dataset29);
    expect(useFactoryStore.getState().project).toBe(project);
    // The plan's own family does refresh its icons.
    useFactoryStore.getState().setDataset(dataset281);
    expect(useFactoryStore.getState().project.recipes[0]?.outputs[0]?.iconPath).toBe("/local-2.8.1/dust.png");
  });

  // The plan's output slot with another face, then the 2.8.1 catalog (its "Dust" draws /local-2.8.1/dust.png).
  const outputAfterLoad = (face: { displayName: string; iconPath: string }) => {
    const variant = plan("plan-281-variant", "2.8.1");
    variant.recipes[0]!.outputs[0] = { ...variant.recipes[0]!.outputs[0]!, ...face };
    useFactoryStore.getState().setProject(variant);
    useFactoryStore.getState().setDataset(dataset281);
    return useFactoryStore.getState().project.recipes[0]?.outputs[0];
  };

  it("a dataset load keeps the picture of a variant drawn by that dataset", () => {
    const own = { displayName: "Fine Dust", iconPath: "/datasets/gtnh/local-2.8.1/textures/rendered/fine_dust-0123456789ab.png" };
    expect(outputAfterLoad(own)).toMatchObject(own);
  });

  it("a dataset load refreshes a renamed slot whose icon is another version's", () => {
    const other = { displayName: "Fine Dust", iconPath: "/datasets/gtnh/local-2.9.0-rc-2/textures/rendered/fine_dust-0123456789ab.png" };
    expect(outputAfterLoad(other)).toMatchObject({ displayName: "Fine Dust", iconPath: "/local-2.8.1/dust.png" });
  });

  it("a dataset load refreshes a power fuel slot named by the power maps", () => {
    // The power maps name fuels their own way and point at the published beta-2 icons.
    const fuel = { displayName: "Bio Ethanol", iconPath: "/datasets/gtnh/local-2.9.0-beta-2/textures/rendered/bio_ethanol-0123456789ab.png" };
    expect(outputAfterLoad(fuel)).toMatchObject({ displayName: "Bio Ethanol", iconPath: "/local-2.8.1/dust.png" });
  });

  it("a dataset switch does not re-solve the open plan against the other version", async () => {
    useFactoryStore.getState().setProject(plan("plan-281", "2.8.1"));
    const solved = useFactoryStore.getState().lastResult;
    useFactoryStore.getState().setDataset(dataset29);
    expect(useFactoryStore.getState().lastResult).toBe(solved);
    const load281 = useFactoryStore.getState().ensureDatasetFor("2.8.1");
    pending.get("local-2.8.1")!(dataset281);
    await load281;
    expect(useFactoryStore.getState().dataset).toBe(dataset281);
    expect(useFactoryStore.getState().lastResult).toBe(solved);
  });

  it("a version this site does not serve loads nothing and waits for nothing", async () => {
    useFactoryStore.getState().setProject(plan("plan-210", "2.10"));
    useFactoryStore.setState({ isDatasetLoading: true });
    expect(await useFactoryStore.getState().ensureDatasetFor("2.10")).toBeUndefined();
    expect(useFactoryStore.getState().isDatasetLoading).toBe(false);
    expect(useFactoryStore.getState().dataset).toBe(dataset29);
    expect(loads).toEqual(["local-2.9.0-rc-2"]);
  });

  it("the manifest's selection never names a hidden version", () => {
    useFactoryStore.setState({ selectedDatasetVersionId: undefined });
    useFactoryStore.getState().setDatasetManifest(
      {
        schemaVersion: 1,
        latestStableVersion: "local-2.8.4",
        versions: [
          { id: "local-2.8.4", gtnhVersion: "2.8.4", publishedAt: "2026-01-01T00:00:00.000Z" },
          { id: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2", publishedAt: "2026-10-23T00:00:00.000Z" },
        ],
      } as unknown as DatasetManifest,
      "/m.json",
    );
    expect(useFactoryStore.getState().selectedDatasetVersionId).toBe("local-2.9.0-rc-2");
  });
});

describe("pasting across game versions", () => {
  const recipe = (datasetVersionId: string): Recipe => ({
    id: "oracle:gregtech:gt-recipe-macerator:aaaa000011112222",
    name: "Macerator: Silicon Dust",
    machineType: "Macerator",
    minimumTier: "LV",
    durationTicks: 100,
    eut: 2,
    inputs: [{ kind: "item", id: "ore", amount: 1 }],
    outputs: [{ kind: "item", id: "dust", amount: 2 }],
    source: { datasetVersionId, recipeMap: "Macerator" },
  });
  const plan = (gameVersion: string | undefined, datasetVersionId: string): FactoryProject => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `plan-${gameVersion ?? "old"}`,
    name: "plan",
    ...(gameVersion ? { gameVersion } : {}),
    planMode: true,
    fuelProfiles: [],
    recipes: [recipe(datasetVersionId)],
    nodes: [{ id: "n1", recipeId: recipe(datasetVersionId).id, position: { x: 0, y: 0 }, machineCount: 1, parallel: 1, overclockTier: "LV", enabled: true }],
    edges: [],
  });

  beforeEach(() => {
    useFactoryStore.setState({ planNotice: null });
  });

  it("captures the plan's version with the cards", () => {
    expect(captureBoardSelection(plan(undefined, "local-2.9.0-rc-2"), ["n1"])?.gameVersion).toBe("2.9");
    expect(captureBoardSelection(plan("2.8.1", "local-2.8.1"), ["n1"])?.gameVersion).toBe("2.8.1");
  });

  it("pasteBoardItems refuses an unprepared payload from another family", () => {
    const copied = captureBoardSelection(plan("2.9", "local-2.9.0-rc-2"), ["n1"])!;
    const { gameVersion: _stamp, ...old } = copied;
    const target = { ...plan("2.8.1", "local-2.8.1"), recipes: [], nodes: [] };
    useFactoryStore.getState().setProject(target);
    const before = useFactoryStore.getState().project;
    expect(useFactoryStore.getState().pasteBoardItems(copied, { x: 40, y: 40 })).toEqual([]);
    // A payload with no field reads 2.9 and is refused the same way.
    expect(useFactoryStore.getState().pasteBoardItems(old, { x: 40, y: 40 })).toEqual([]);
    expect(useFactoryStore.getState().project).toBe(before);
    expect(useFactoryStore.getState().undoHistory).toHaveLength(0);
  });

  it("the safety-net refusal shows its notice", () => {
    const copied = captureBoardSelection(plan("2.9", "local-2.9.0-rc-2"), ["n1"])!;
    useFactoryStore.getState().setProject({ ...plan("2.8.1", "local-2.8.1"), recipes: [], nodes: [] });
    useFactoryStore.getState().pasteBoardItems(copied, { x: 0, y: 0 });
    expect(useFactoryStore.getState().planNotice?.text).toBe("Those cards are from GTNH 2.9 and could not be pasted.");
  });

  it("a shared card pasted into another plan brings every section's recipe", () => {
    const second = { ...recipe("local-2.8.1"), id: "second-recipe", name: "Macerator: Other" };
    const board = plan("2.8.1", "local-2.8.1");
    board.recipes.push(second);
    board.nodes[0]!.extraRecipes = [{ recipeId: second.id }];
    const copied = captureBoardSelection(board, ["n1"])!;
    useFactoryStore.getState().setProject({ ...plan("2.8.1", "local-2.8.1"), id: "other", recipes: [], nodes: [] });
    expect(useFactoryStore.getState().pasteBoardItems(copied, { x: 0, y: 0 })).toHaveLength(1);
    expect(useFactoryStore.getState().project.recipes.map((entry) => entry.id).sort()).toEqual(
      [recipe("local-2.8.1").id, second.id].sort(),
    );
  });

  it("a paste of the plan's own version lands, an unstamped one on an unstamped plan too", () => {
    useFactoryStore.getState().setProject(plan(undefined, "local-2.9.0-rc-2"));
    const { gameVersion: _stamp, ...old } = captureBoardSelection(plan("2.9", "local-2.9.0-rc-2"), ["n1"])!;
    expect(useFactoryStore.getState().pasteBoardItems(old, { x: 40, y: 40 })).toHaveLength(1);
    expect(useFactoryStore.getState().planNotice).toBeNull();
  });
});
