import { expect, test, vi } from "vitest";

/*
 * machine-table.ts loads the override files through version-overrides.ts, so
 * a value an override file imports from machine-table.ts is uninitialised
 * when it runs. Each module is loaded first into a fresh registry; a break
 * throws on import.
 */
const ENTRIES: Record<string, () => Promise<unknown>> = {
  "machine-table": () => import("../machine-table"),
  "version-overrides": () => import("../version-overrides"),
  index: () => import("./index"),
  "float-coefficients": () => import("./float-coefficients"),
  mega: () => import("./mega"),
  "gtpp-flat": () => import("./gtpp-flat"),
  "gtpp-knobs": () => import("./gtpp-knobs"),
  absent: () => import("./absent"),
  "table-builders": () => import("../table-builders"),
};

test.each(Object.keys(ENTRIES))("machine-table.ts 2.8.1 overrides load when %s loads first", async (entry) => {
  vi.resetModules();
  await ENTRIES[entry]();
  const { MACHINE_OVERRIDES } = await import("../version-overrides");
  const { MACHINE_OVERRIDES_2_8_1 } = await import("./index");
  const { getMachineBehaviour } = await import("../machine-table");
  expect(MACHINE_OVERRIDES["2.8.1"]).toBe(MACHINE_OVERRIDES_2_8_1);
  expect(getMachineBehaviour("Volcanus", "2.9")?.parallels).toBe(8);
});
