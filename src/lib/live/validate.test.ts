import { describe, expect, it } from "vitest";
import { prepareBatch } from "@/live/batch";
import { LiveDoc } from "@/live/doc";
import { applyOps, plansEqual, type LiveOp, type LivePlan } from "./ops";
import { colorFor, LIVE_COLORS, liveSocketUrl, parseDocKey } from "./protocol";

const plan: LivePlan = {
  schemaVersion: 1,
  id: "p",
  name: "Plan",
  recipes: [],
  nodes: [],
  edges: [],
  fuelProfiles: [{ id: "f1", name: "Fuel", fuelFluidId: "water", euPerLiter: 2 }],
  annotations: [
    { id: "a1", kind: "box", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
  ],
  tasks: [{ id: "t1", title: "Task", status: "todo", order: "a0" }],
};

/** The batch made ready for a room on `plan`: its error, or the ops it is applied as. */
const prepare = (ops: LiveOp[]) => prepareBatch(new LiveDoc(plan), ops);
const check = (ops: LiveOp[]) => {
  const prepared = prepare(ops);
  return "error" in prepared ? prepared.error : null;
};
/** What is stored after the batch: the plan with the prepared ops applied. */
const stored = (ops: LiveOp[]) => {
  const prepared = prepare(ops);
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }
  return applyOps(plan, prepared.ops);
};

describe("live batch checks", () => {
  it("pass a sound batch", () => {
    expect(
      check([
        { o: "patch", c: "tasks", id: "t1", f: { status: "done" } },
        {
          o: "put",
          c: "taskItems",
          id: "i1",
          v: { id: "i1", taskId: "t1", text: "Do", done: false, order: "a0" },
        },
        { o: "meta", f: { primaryView: "tasks", notes: "n" } },
      ]),
    ).toBeNull();
  });

  it("keep every task field the game writes: priority, the column stamp, what it waits on, spots and screenshots", () => {
    const fields = { priority: "high", movedAt: "2026-10-15T09:00:00.000Z", blockedBy: ["t2"] };
    const place = {
      x: 120,
      y: 64,
      z: -30,
      dim: 0,
      dimName: "Overworld",
      world: "server:0123456789abcdef",
      label: "Ore",
    };
    const picture = {
      thumb: "data:image/jpeg;base64,/9j/4AAQ",
      w: 1920,
      h: 1080,
      takenAt: "2026-10-15T09:00:00.000Z",
      file: "a.png",
    };
    const spot: LiveOp = {
      o: "put",
      c: "taskItems",
      id: "i1",
      v: {
        id: "i1",
        taskId: "t1",
        kind: "location",
        text: "Ore at 120 64 -30 in Overworld",
        done: false,
        order: "a0",
        place,
      },
    };
    const shot: LiveOp = {
      o: "put",
      c: "taskItems",
      id: "i2",
      v: {
        id: "i2",
        taskId: "t1",
        kind: "picture",
        text: "Screenshot",
        done: false,
        order: "a1",
        picture,
      },
    };
    const after = stored([{ o: "patch", c: "tasks", id: "t1", f: fields }, spot, shot]);
    expect((after.tasks as Array<Record<string, unknown>>)[0]).toMatchObject(fields);
    const items = after.taskItems as Array<Record<string, unknown>>;
    expect(items[0]!.place).toEqual(place);
    expect(items[1]!.picture).toEqual(picture);
    // A picture is only ever an image data URL, never a link to another site.
    const link: LiveOp = {
      o: "patch",
      c: "taskItems",
      id: "i2",
      f: { picture: { ...picture, thumb: "https://x/y.png" } },
    };
    expect(check([shot, link])).toMatch(/^taskItems i2: picture/);
  });

  it("refuse a thing its collection's schema refuses", () => {
    expect(check([{ o: "patch", c: "tasks", id: "t1", f: { status: "later" } }])).toMatch(
      /^tasks t1: status/,
    );
    expect(check([{ o: "patch", c: "tasks", id: "t1", f: {}, d: ["title"] }])).toMatch(
      /^tasks t1: title/,
    );
    expect(
      check([
        { o: "put", c: "tasks", id: "t9", v: { id: "t9", title: "T", status: "x", order: "a" } },
      ]),
    ).toMatch(/^tasks t9: status/);
  });

  it("let a patch on nothing and a thing put then deleted pass", () => {
    expect(check([{ o: "patch", c: "tasks", id: "gone", f: { status: "later" } }])).toBeNull();
    expect(
      check([
        { o: "put", c: "tasks", id: "t2", v: { id: "t2", title: "", status: "x", order: "" } },
        { o: "del", c: "tasks", id: "t2" },
      ]),
    ).toBeNull();
  });

  it("refuse deleting a required plan field, setting an unknown one, or a bad value", () => {
    expect(check([{ o: "meta", f: {}, d: ["name"] }])).toMatch(/^plan field name/);
    expect(check([{ o: "meta", f: { bogus: true } }])).toMatch(/not part of a plan/);
    expect(check([{ o: "meta", f: { primaryView: "kanban" } }])).toMatch(/^plan field primaryView/);
  });

  it("refuse setting or deleting the plan's game version: it is never a live edit", () => {
    expect(check([{ o: "meta", f: { gameVersion: "2.9" } }])).toMatch(/^plan field gameVersion/);
    expect(check([{ o: "meta", f: { gameVersion: "2.8.1" } }])).toMatch(/^plan field gameVersion/);
    expect(check([{ o: "meta", f: {}, d: ["gameVersion"] }])).toMatch(/^plan field gameVersion/);
    expect(check([{ o: "meta", f: { notes: "n", gameVersion: "2.9" } }])).toMatch(/^plan field gameVersion/);
  });

  it("refuse deleting a required field, whatever else the patch carries", () => {
    // A field named __proto__ never gets this far (readOps refuses it); were it
    // to, the position it names is still required of the annotation itself.
    const ops = JSON.parse(
      '[{"o":"patch","c":"annotations","id":"a1","f":{"__proto__":{"position":{"x":1,"y":2}}},"d":["position"]}]',
    ) as LiveOp[];
    expect(check(ops)).toMatch(/^annotations a1: position/);
  });

  it("store what the schema keeps: unknown fields dropped, values normalised, for everyone", () => {
    const put: LiveOp = {
      o: "put",
      c: "tasks",
      id: "t2",
      v: { id: "t2", title: "New", status: "todo", order: "a1", junk: { a: 1 } },
    };
    const prepared = prepare([put]);
    expect(prepared).toMatchObject({
      ops: [put, { o: "put", c: "tasks", id: "t2", v: { id: "t2", title: "New" } }],
    });
    const task = (stored([put]).tasks as Array<Record<string, unknown>>)[1]!;
    expect(task).toEqual({ id: "t2", title: "New", status: "todo", order: "a1" });

    const patch: LiveOp = { o: "patch", c: "tasks", id: "t1", f: { text: "x", extra: 1 } };
    expect(prepare([patch])).toEqual({
      ops: [patch, { o: "patch", c: "tasks", id: "t1", f: {}, d: ["extra"] }],
      sizeChange: expect.any(Number),
    });
    expect((stored([patch]).tasks as unknown[])[0]).toEqual({
      ...(plan.tasks as object[])[0],
      text: "x",
    });

    const fuel: LiveOp = { o: "patch", c: "fuelProfiles", id: "f1", f: { stray: true } };
    expect((stored([fuel]).fuelProfiles as unknown[])[0]).toEqual(
      (plan.fuelProfiles as unknown[])[0],
    );
    // A sound batch needs nothing added.
    const sound: LiveOp = { o: "patch", c: "tasks", id: "t1", f: { status: "done" } };
    expect(prepare([sound])).toMatchObject({ ops: [sound] });
  });

  it("check a thing whose schema checks it whole as a whole", () => {
    expect(check([{ o: "patch", c: "fuelProfiles", id: "f1", f: {}, d: ["euPerLiter"] }])).toMatch(
      /^fuelProfiles f1: euPerLiter/,
    );
  });

  it("measure what the batch changes, as the plan's JSON grows", () => {
    const length = (value: LivePlan) => JSON.stringify(value).length;
    const batches: LiveOp[][] = [
      [{ o: "patch", c: "tasks", id: "t1", f: { text: "a longer text" } }],
      [{ o: "patch", c: "tasks", id: "t1", f: { title: "T" } }],
      [{ o: "del", c: "tasks", id: "t1" }],
      [
        {
          o: "put",
          c: "taskItems",
          id: "i1",
          v: { id: "i1", taskId: "t1", text: "Do", done: false, order: "a0" },
        },
      ],
      [{ o: "meta", f: { notes: "hello" } }],
    ];
    for (const ops of batches) {
      const prepared = prepare(ops);
      if ("error" in prepared) {
        throw new Error(prepared.error);
      }
      const after = applyOps(plan, prepared.ops);
      expect(Math.abs(length(plan) + prepared.sizeChange - length(after))).toBeLessThanOrEqual(2);
    }
    expect(plansEqual(stored([]), plan)).toBe(true);
  });
});

describe("live protocol helpers", () => {
  it("read doc keys and nothing else", () => {
    expect(parseDocKey("11111111-1111-4111-8111-111111111111:design-abc1")).toEqual({
      ownerId: "11111111-1111-4111-8111-111111111111",
      designId: "design-abc1",
    });
    expect(parseDocKey("nope:design-abc1")).toBeUndefined();
    expect(parseDocKey("11111111-1111-4111-8111-111111111111:x")).toBeUndefined();
    expect(parseDocKey(42)).toBeUndefined();
  });

  it("give each account one colour from the palette", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(colorFor(id)).toBe(colorFor(id));
    expect(LIVE_COLORS).toContain(colorFor(id));
  });
});

describe("the live socket address", () => {
  it("is the configured one, or a path on the page's own host", () => {
    const page = { protocol: "https:", host: "new.gtnhplanner.com" };
    expect(liveSocketUrl(undefined, page)).toBeUndefined();
    expect(liveSocketUrl("", page)).toBeUndefined();
    expect(liveSocketUrl("/live", page)).toBe("wss://new.gtnhplanner.com/live");
    expect(liveSocketUrl("/live", { protocol: "http:", host: "localhost:3000" })).toBe(
      "ws://localhost:3000/live",
    );
    expect(liveSocketUrl("ws://localhost:3001/live", page)).toBe("ws://localhost:3001/live");
  });
});
