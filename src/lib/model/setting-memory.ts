import type { FactoryNode, Recipe } from "./types";
import { applyRecipeInputOverrides } from "./recipe-input-overrides";
import {
  applyMachineHandlerToRecipe,
  getRecipeCoilTierControl,
  getRecipeMachineConfigTierControls,
  getSelectedMachineHandler,
} from "./recipe-rules";
import type { GameVersion } from "@/lib/model/game-version";

/**
 * The settings last changed on each machine, so the next card for it starts with them (the mod's `SettingMemory`):
 * change an Electric Blast Furnace's coil, and the next one added comes the same way. Cards already on the board keep
 * their own, and an imported plan keeps its. Kept in the browser, so it carries across plans and visits.
 */
const STORAGE_KEY = "gtnh-factory-flow.setting-memory.v1";
/** Set by the recipe or the machine, never by the player. */
const NOT_KEPT = new Set(["machineParallel", "voltageParallel"]);

type Memory = Record<string, string>;

function read(): Memory {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Memory) : {};
  } catch {
    return {};
  }
}

function write(memory: Memory): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // A private window: the memory just does not stick.
  }
}

/** The machine a card's settings are remembered under: its selected handler. */
export function settingMemoryMachine(recipe: Recipe, node: Pick<FactoryNode, "machineHandlerId">): string {
  return getSelectedMachineHandler(recipe, node).id;
}

/** Remembers a setting just changed on a card (`controlId` is `heatingCoil` for the coil). */
export function rememberSetting(machine: string, controlId: string, optionKey: string): void {
  if (NOT_KEPT.has(controlId)) return;
  const memory = read();
  memory[`${machine}|${controlId}`] = optionKey;
  write(memory);
}

/**
 * The patch that gives a new card the settings last changed on its machine, those its machine has; a remembered
 * option only when the machine still offers it (a coil only when it is hot enough for the recipe).
 */
export function applySettingMemory(recipe: Recipe, node: FactoryNode, gameVersion: GameVersion): Partial<FactoryNode> | undefined {
  const memory = read();
  const prefix = `${settingMemoryMachine(recipe, node)}|`;
  const kept = Object.entries(memory).filter(([name]) => name.startsWith(prefix));
  if (kept.length === 0) return undefined;
  const effective = applyMachineHandlerToRecipe(applyRecipeInputOverrides(recipe, node, gameVersion), node, gameVersion);
  const patch: Partial<FactoryNode> = {};
  const tiers: Record<string, string> = {};
  const coil = getRecipeCoilTierControl(effective, node, gameVersion);
  const controls = getRecipeMachineConfigTierControls(effective, node, gameVersion);
  for (const [name, optionKey] of kept) {
    const id = name.slice(prefix.length);
    if (id === "heatingCoil") {
      if (coil?.tiers.some((tier) => tier.key === optionKey)) patch.coilTier = optionKey;
      continue;
    }
    const control = controls.find((entry) => entry.id === id);
    if (control?.tiers.some((tier) => tier.key === optionKey)) tiers[id] = optionKey;
  }
  if (Object.keys(tiers).length > 0) patch.machineConfigTiers = { ...(node.machineConfigTiers ?? {}), ...tiers };
  return Object.keys(patch).length > 0 ? patch : undefined;
}
