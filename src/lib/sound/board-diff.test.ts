import { describe, expect, it } from "vitest";
import type { FactoryProject } from "@/lib/model/types";
import { snapshotBoard, soundForDiff, tierPitch } from "./board-diff";

/** What plays for which edit, read off the plan before and after, as the mod's BoardSession plays it. */

function project(overrides: Partial<FactoryProject>): FactoryProject {
  return {
    schemaVersion: 1,
    id: "p",
    name: "Test",
    recipes: [],
    nodes: [],
    edges: [],
    fuelProfiles: [],
    ...overrides,
  } as FactoryProject;
}

const node = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    recipeId: "r",
    machineCount: 1,
    overclockTier: "LV",
    position: { x: 0, y: 0 },
    ...extra,
  }) as FactoryProject["nodes"][number];

const edge = (id: string, kind = "item") =>
  ({
    id,
    source: "a",
    target: "b",
    resourceKind: kind,
    resourceId: "x",
  }) as FactoryProject["edges"][number];

const drawer = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "item", resourceId: "x", position: { x: 0, y: 0 }, ...extra }) as NonNullable<
    FactoryProject["storages"]
  >[number];

function sound(before: FactoryProject, after: FactoryProject) {
  return soundForDiff(snapshotBoard(before), snapshotBoard(after));
}
const name = (before: FactoryProject, after: FactoryProject) => sound(before, after)?.name;

describe("soundForDiff", () => {
  it("places a card, even with its wire; sweeps several", () => {
    expect(
      name(
        project({ nodes: [node("a")] }),
        project({ nodes: [node("a"), node("b")], edges: [edge("e1")] }),
      ),
    ).toBe("board.place");
    expect(name(project({}), project({ nodes: [node("a"), node("b")] }))).toBe("board.sweep");
  });

  it("latches a wire as what it carries and cuts it the same way", () => {
    const bare = project({ nodes: [node("a"), node("b")] });
    for (const [kind, on, off] of [
      ["item", "wire.item", "wire.cut"],
      ["fluid", "wire.fluid", "wire.fluid_cut"],
      ["power", "wire.power", "wire.power_cut"],
    ] as const) {
      const wired = project({ nodes: [node("a"), node("b")], edges: [edge("e", kind)] });
      expect(name(bare, wired)).toBe(on);
      expect(name(wired, bare)).toBe(off);
    }
  });

  it("makes a drawer for a port with the wire sound of what it holds", () => {
    const machine = project({ nodes: [node("m")] });
    const withTank = project({
      nodes: [node("m")],
      storages: [drawer("s", { kind: "fluid" })],
      edges: [edge("e", "fluid")],
    });
    expect(name(machine, withTank)).toBe("wire.fluid");
    expect(name(withTank, machine)).toBe("board.remove");
  });

  it("removes cards, and sticks and crumples notes", () => {
    expect(
      name(
        project({ nodes: [node("a"), node("b")], edges: [edge("e")] }),
        project({ nodes: [node("b")] }),
      ),
    ).toBe("board.remove");
    const note = { id: "n", kind: "text", position: { x: 0, y: 0 } } as unknown as NonNullable<
      FactoryProject["annotations"]
    >[number];
    expect(name(project({}), project({ annotations: [note] }))).toBe("note.stick");
    expect(name(project({ annotations: [note] }), project({}))).toBe("note.crumple");
  });

  it("merges when cards fold into one machine", () => {
    const before = project({ nodes: [node("a"), node("b")] });
    const after = project({ nodes: [node("a", { extraRecipes: [{ recipeId: "r2" }] })] });
    expect(name(before, after)).toBe("board.merge");
  });

  it("pins and unpins a count, a port rate and a drawer rate, settling under the wheel", () => {
    const loose = project({ nodes: [node("a")] });
    const pinned = project({ nodes: [node("a", { solvePin: 3 })] });
    expect(sound(loose, pinned)).toEqual({ name: "board.pin", settles: true });
    expect(name(pinned, loose)).toBe("board.unpin");
    expect(name(loose, project({ nodes: [node("a", { portRates: { "o:x": 2 } })] }))).toBe(
      "board.pin",
    );
    const free = project({ storages: [drawer("s", { targetMode: "at-least" })] });
    expect(
      name(
        free,
        project({ storages: [drawer("s", { targetMode: "at-least", targetPerSecond: 4 })] }),
      ),
    ).toBe("board.pin");
  });

  it("sounds a change of the count rule as a pin", () => {
    const upTo = project({ nodes: [node("a", { solvePin: 3 })] });
    const exact = project({ nodes: [node("a", { solvePin: 3, solvePinExact: true })] });
    expect(sound(upTo, exact)).toEqual({ name: "board.pin", settles: true });
    expect(name(exact, upTo)).toBe("board.pin");
    expect(name(upTo, upTo)).toBeUndefined();
  });

  it("steps the tier dial up its ladder", () => {
    const lv = project({ nodes: [node("a")] });
    const hv = project({ nodes: [node("a", { overclockTier: "HV" })] });
    expect(sound(lv, hv)).toEqual({ name: "dial.tier", pitch: tierPitch(3) });
  });

  it("adjusts a setting, pitching a drawer's rule by its rung", () => {
    expect(
      name(
        project({ nodes: [node("a")] }),
        project({ nodes: [node("a", { machineHandlerId: "x" })] }),
      ),
    ).toBe("board.adjust");
    const any = project({ storages: [drawer("s", { targetMode: "ignore" })] });
    const exact = project({ storages: [drawer("s", { targetMode: "exact" })] });
    expect(sound(any, exact)?.pitch).toBeCloseTo(0.9 * 1.12 * 1.12, 9);
  });

  it("opens and closes a board", () => {
    const folded = project({ pockets: [{ id: "p", name: "Zone" }] } as Partial<FactoryProject>);
    const open = project({
      pockets: [{ id: "p", name: "Zone", expanded: true }],
    } as Partial<FactoryProject>);
    expect(name(folded, open)).toBe("ui.open");
    expect(name(open, folded)).toBe("ui.close");
  });

  it("is silent for a move, a repaint, or another plan", () => {
    const before = project({ nodes: [node("a")] });
    expect(
      name(
        before,
        project({ nodes: [node("a", { position: { x: 100, y: 100 }, iconPath: "x" })] }),
      ),
    ).toBeUndefined();
    expect(name(before, { ...project({ nodes: [] }), id: "other" })).toBeUndefined();
  });
});
