/* Tests only: this file imports values from ../machine-table, so an override file must never import it. */
import type { GameVersion } from "@/lib/model/game-version";
import { getMachineBehaviour, resolveCoefficient, type MachineContext } from "../machine-table";

/** A machine context for tests: no knobs set, IV power, in `gameVersion`. */
export function ctx(gameVersion: GameVersion, p: Partial<MachineContext> = {}): MachineContext {
  return { tier: () => 0, value: () => 0, voltageTier: 5, ...p, gameVersion };
}

/** A machine's table coefficients in `gameVersion`; an unstated coefficient reads 1. */
export function coefficients(
  name: string,
  gameVersion: GameVersion,
  p?: Partial<MachineContext>,
): { speed: number; power: number; parallels: number; durationMultiplier: number } {
  const behaviour = getMachineBehaviour(name, gameVersion);
  const c = ctx(gameVersion, p);
  // A stated duration multiplier wins over speed, as getMachineDurationMultiplier reads it.
  const stated = behaviour?.durationMultiplier;
  const speed = stated !== undefined ? 1 / resolveCoefficient(stated, c, 1) : resolveCoefficient(behaviour?.speed, c, 1);
  const durationMultiplier = stated !== undefined ? resolveCoefficient(stated, c, 1) : 1 / speed;
  return {
    speed,
    power: resolveCoefficient(behaviour?.power, c, 1),
    parallels: resolveCoefficient(behaviour?.parallels, c, 1),
    durationMultiplier,
  };
}
