/**
 * Large and XL Turbo turbines, each following its fluidIntoPower in GT5U
 * (MTELargeTurbine* and MTEXLTurbine*): the fuel EU of the flow, scaled by
 *
 *   1 - |flow - opt| / (opt x penalty)
 *
 * (penalty 1 below optimal, per-class above it), then by the rotor
 * efficiency, truncating after each step in float like the Java. Per-class
 * caps, weak-rotor branches and lifespans are in docs/power-planner-math.md.
 * Steam and gas flows are litres per TICK (the game's own tooltip unit);
 * plasma flows are litres per second.
 */
import {
  findFuel,
  findRotor,
  fuelOptions,
  resolvePowerResource,
  ROTOR_SIZE_NAMES,
  rotorDurability,
  type RotorClassData,
  type PowerTables,
  type RotorEntry,
} from "../planner-data";
import type { GameVersion } from "@/lib/model/game-version";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";
import type { PowerFlowLine, PowerModel, PowerSourceDefinition, PowerSetting } from "../types";
import {
  formatAmount,
  lifespanHours,
  liters,
  percent,
  stat,
  type PowerSourceBuilder,
} from "./helpers";

type TurbineClass = "steam" | "gas" | "plasma";

interface TurbineSpec {
  id: string;
  name: string;
  unlock: string;
  blurb: string;
  turbineClass: TurbineClass;
  xl: boolean;
  /** Steam machines: the grade burned, or "select" for the XL's grade knob. */
  steamGrade?: string | "select";
  /** For "select": which grades this XL machine accepts (plain + dense). */
  steamGradeOptions?: string[];
}

const STEAM_EXHAUST: Record<string, string | undefined> = {
  "SC Steam": "SH Steam",
  "SH Steam": "Steam",
  "Dense SC Steam": "Dense SH Steam",
  "Dense SH Steam": "Dense Steam",
};

/**
 * The de-powered fluid a plasma turbine returns, 1 L per 1 L of plasma.
 * MTELargeTurbinePlasma strips the "plasma." fluid-name prefix and takes
 * the plain fluid if the registry has one, else the molten form - so every
 * plasma exhausts, not only the fusion-made ones. The fusion table's decay
 * column wins where it exists (same rule, already spelled out); the rest
 * mirror the registry fallback against our own resource map.
 */
function plasmaExhaust(plasmaName: string, tables: PowerTables, gameVersion: GameVersion): string | undefined {
  const recipe = tables.fusionRecipes.find((entry) => entry.name === plasmaName);
  if (recipe?.decayOutput) {
    return recipe.decayOutput !== "None" ? recipe.decayOutput : undefined;
  }
  const base = plasmaName.replace(/ Plasma$/, "");
  if (base === plasmaName) {
    return undefined;
  }
  if (resolvePowerResource(base, gameVersion)) {
    return base;
  }
  const molten = `Molten ${base}`;
  if (resolvePowerResource(molten, gameVersion)) {
    return molten;
  }
  // Neither form is a registered fluid: the game consumes the plasma and
  // outputs nothing (the null-check around addOutputPartial).
  return undefined;
}

function classData(rotor: RotorEntry, turbineClass: TurbineClass): RotorClassData {
  return rotor[turbineClass];
}

function pickLadder(values: Array<number | null>, sizeIndex: number): number {
  const value = values[sizeIndex];
  return typeof value === "number" ? value : 0;
}

/** The turbines compute in Java float; every step below rounds like it. */
const f32 = Math.fround;

/** getBaseDamage of ToolTurbineSmall, Normal, Large and Huge. */
const ROTOR_BASE_DAMAGE = [0, 2.5, 5, 7.5];

/**
 * TurbineStatCalculator.getBaseEfficiency in float, 0.5 + (0.5 + base damage
 * + tool quality) x 0.1, rebuilt from the ladder's decimal value so products
 * and the SC's int cast see the game's exact float.
 */
function javaBaseEfficiency(tightEfficiency: number, sizeIndex: number): number {
  const baseDamage = ROTOR_BASE_DAMAGE[sizeIndex] ?? 0;
  const quality = Math.round((tightEfficiency - 0.5) / 0.1 - 0.5 - baseDamage);
  return f32(0.5 + f32(f32(0.5 + f32(baseDamage + quality)) * f32(0.1)));
}

/** GTUtility/MathUtils.safeInt clamp outputs and flows at the top voltage. */
const INT_CAP = 2_147_483_640;

/** An integer amount times a float factor, truncated: `tEU *= efficiency` in the Java. */
function scale(amount: number, factor: number): number {
  return Math.min(INT_CAP, Math.trunc(f32(f32(amount) * f32(factor))));
}

/**
 * How the Java subtracts the optimum from the flow, which decides the loss's rounding once
 * flows pass 2^24 L/t, where a float no longer holds every integer:
 * - "int": two ints (getOverflowEfficiency(int, int, int), the XL gas and plasma), an exact
 *   difference then cast to float;
 * - "float": `totalFlow - (float) realOptFlow`, both cast to float first (2.9's Large SC,
 *   every XL steam turbine);
 * - "double": `totalFlow - realOptFlow` on the double field (2.8.1's Large SC), exact.
 */
type FlowDifference = "int" | "float" | "double";

function flowDifference(flow: number, optimal: number, difference: FlowDifference): number {
  if (difference === "float") {
    return f32(f32(flow) - f32(optimal));
  }
  return difference === "int" ? f32(flow - optimal) : flow - optimal;
}

/**
 * getOverflowEfficiency: the linear loss off optimal. Below optimal every
 * class loses 1:1; above it the loss divides by the class's overflow divisor
 * (1 for SC steam and every XL, so both sides cost the same).
 */
function flowEfficiency(
  flow: number,
  optimal: number,
  overDivisor: number,
  difference: FlowDifference,
): number {
  const delta = flowDifference(flow, optimal, difference);
  if (flow > optimal) {
    return f32(1 - f32(Math.abs(delta) / f32(f32(optimal) * overDivisor)));
  }
  return f32(1 - Math.abs(f32(delta / f32(optimal))));
}

/**
 * Rotor wear per damage roll (getDamageToComponent), averaged over its dice.
 * Steam and HP: a loose rotor skips 1 roll in 4. SC (MTELargeTurbineSCSteam):
 * 2 tight, a coin flip of 0 or 1 loose. MTEXLTurbineGas skips 1 in 4 in
 * either fitting. Gas and plasma otherwise take 1.
 */
function damagePerRoll(spec: TurbineSpec, fuelName: string, tight: boolean): number {
  if (spec.turbineClass === "gas") {
    return spec.xl ? 0.75 : 1;
  }
  if (spec.turbineClass === "plasma") {
    return 1;
  }
  if (!spec.xl && fuelName === "SC Steam") {
    return tight ? 2 : 0.5;
  }
  return tight ? 1 : 0.75;
}

/**
 * Seconds until one rotor breaks. A damage roll comes every 1002 ticks
 * (mRuntime++ > 1000) and lands half the time, for min(EU/5, EU^0.6)
 * truncated (MTEMultiBlockBase.doRandomMaintenanceDamage; the exponent is the
 * float damageFactorHigh, so exact powers like 243^0.6 land on 27). The XL
 * rolls each of its rotors on a fifth of its output (MTEXLTurbineBase.damageTurbine).
 */
function rotorLifespanSeconds(
  xl: boolean,
  euPerTick: number,
  durability: number,
  perRoll: number,
): number {
  const eu = xl ? Math.floor(euPerTick / 5) : euPerTick;
  const linear = xl ? eu / 5 : Math.floor(eu / 5);
  const damage = Math.floor(Math.min(linear, Math.pow(eu, f32(0.6)))) * perRoll;
  return damage > 0 ? ((durability / damage) * 2 * 1002) / 20 : Infinity;
}

/** One turbine's operating point, flows in the card's own unit. */
interface TurbineRun {
  optimal: number;
  flow: number;
  maxFlow: number;
  euPerTick: number;
  /** XL dense steam: the steam-equivalent litres per tick actually used. */
  steamPerTick?: number;
  /** XL dense steam: the steam litres per tick the water return divides, when not steamPerTick. */
  waterSteamPerTick?: number;
  efficiency: number;
  warning?: string;
  /** The gas turbine's weak-rotor branch returns before the dynamo clamp. */
  skipsDynamoClamp?: boolean;
}

const idle = (optimal: number, efficiency: number, warning: string): TurbineRun => ({
  optimal,
  flow: 0,
  maxFlow: 0,
  euPerTick: 0,
  efficiency,
  warning,
});

/**
 * MTELargeTurbineSteam / HPSteam / SCSteam. `realOpt` is the rotor's steam
 * flow (tight or loose) in L/t. Steam pays 0.5 EU/L, SH and SC 1 EU/L.
 */
function largeSteamRun(
  grade: string,
  realOpt: number,
  overflowTier: number,
  eff: number,
  baseEfficiency: number,
  wanted: number | undefined,
  gameVersion: GameVersion,
): TurbineRun {
  const opt = f32(realOpt);
  if (grade === "SC Steam") {
    // useLegacyEfficiencyScaling: the base efficiency is cast to int, and 0
    // stops the machine, so rotors under 100% never run here.
    if (Math.trunc(f32(baseEfficiency)) <= 0) {
      return idle(
        Math.floor(opt),
        eff,
        "Rotor base efficiency is under 100%, so the SC turbine will not run it.",
      );
    }
    const maxFlow = Math.min(INT_CAP, Math.floor(opt * 1.25));
    const optimal = Math.min(Math.floor(opt), maxFlow);
    const flow = Math.min(wanted ?? optimal, maxFlow);
    // Off optimal, 2.8.1's MTESupercriticalFluidTurbine (5.09.51.476 :76-82) subtracts on the
    // double realOptFlow and runs `tEU *= efficiency` on its int tEU, truncating before the
    // rotor efficiency; 2.9's MTELargeTurbineSCSteam (5.09.54.205 :108-109) subtracts in float,
    // multiplies both in float and truncates once.
    const old = gameVersion === "2.8.1";
    const offOptimal = (loss: number) =>
      old ? scale(scale(flow, loss), eff) : scale(f32(f32(flow) * loss), eff);
    const loss = flowEfficiency(flow, opt, 1, old ? "double" : "float");
    const euPerTick = flow === opt ? scale(flow, eff) : Math.max(1, offOptimal(loss));
    return { optimal, flow, maxFlow, euPerTick, efficiency: eff };
  }
  const sh = grade === "SH Steam";
  const optimal = Math.floor(opt);
  const maxFlow = Math.min(INT_CAP, Math.floor(opt * (f32(0.5 * overflowTier) + (sh ? 1.5 : 1))));
  const flow = Math.min(wanted ?? optimal, maxFlow);
  const euFrom = (steam: number) =>
    sh ? scale(steam, eff) : Math.trunc(f32(f32(f32(steam) * f32(eff)) * 0.5));
  const euPerTick =
    flow === optimal
      ? euFrom(flow)
      : Math.max(
          1,
          euFrom(scale(flow, flowEfficiency(flow, optimal, overflowTier + (sh ? 2 : 1), "int"))),
        );
  return { optimal, flow, maxFlow, euPerTick, efficiency: eff };
}

/**
 * MTEXLTurbineSteam / HPSteam / SCSteam: sixteen rotors' flow, a 1.25x cap
 * and the same loss either side of optimal, measured on the unrounded
 * optimum. Dense steam is 1000 steam-equivalent litres per litre. On 2.9 the
 * turbine takes whole dense litres (up to ceil(cap / 1000)) but uses only up
 * to the cap. On 2.8.1 (GT++ MTELargeTurbineSteam / SHSteam / SCSteam at
 * 5.09.51.476) it takes the float share min(offered, cap / 1000), drains only
 * its whole litres and credits the share x 1000 truncated, fraction included.
 */
function xlSteamRun(
  grade: string,
  rotorFlow: number,
  eff: number,
  wanted: number | undefined,
  gameVersion: GameVersion,
): TurbineRun {
  const dense = grade.startsWith("Dense");
  const plain = grade === "Steam" || grade === "Dense Steam";
  const steamOpt = f32(16 * f32(rotorFlow));
  const steamCap = Math.min(INT_CAP, Math.floor(steamOpt * 1.25));
  const euFor = (steam: number): number => {
    const raw = plain ? Math.trunc(f32(f32(steam) * 0.5)) : steam;
    if (steam === steamOpt) {
      return scale(raw, eff);
    }
    return Math.max(1, scale(scale(raw, flowEfficiency(steam, steamOpt, 1, "float")), eff));
  };
  if (!dense) {
    const optimal = Math.min(Math.floor(steamOpt), steamCap);
    const flow = Math.min(wanted ?? optimal, steamCap);
    return { optimal, flow, maxFlow: steamCap, euPerTick: euFor(flow), efficiency: eff };
  }
  const below = Math.floor(steamOpt / 1000);
  const above = Math.ceil(steamOpt / 1000);
  if (gameVersion === "2.8.1") {
    // MTELargeTurbineSteam.java:124-131: remainingDenseFlow = (float) remainingFlow / 1000,
    // denseFlow = min(hatch, it) in float, (int) denseFlow drained, and totalFlow +=
    // denseFlow * 1000 on the int total; the water return reads the float sum.
    const denseCap = f32(f32(steamCap) / 1000);
    const share = (offered: number) => Math.min(f32(offered), denseCap);
    const credit = (offered: number) => Math.min(INT_CAP, Math.trunc(f32(share(offered) * 1000)));
    // The feed that makes the most EU, scored on what it credits.
    const optimal = below >= 1 && euFor(credit(below)) >= euFor(credit(above)) ? below : above;
    // Offering more than ceil(cap / 1000) changes nothing.
    const offered = Math.min(wanted ?? optimal, Math.ceil(denseCap));
    const steamPerTick = credit(offered);
    return {
      optimal,
      flow: Math.trunc(share(offered)),
      maxFlow: Math.trunc(denseCap),
      euPerTick: euFor(steamPerTick),
      steamPerTick,
      waterSteamPerTick: f32(share(offered) * 1000),
      efficiency: eff,
    };
  }
  const steamFor = (litres: number) => Math.min(litres * 1000, steamCap);
  // The whole-litre feed that makes the most EU: usually the one above, since
  // overshooting the optimum costs far less than falling short.
  const optimal = below >= 1 && euFor(steamFor(below)) >= euFor(steamFor(above)) ? below : above;
  const maxFlow = Math.ceil(steamCap / 1000);
  const flow = Math.min(wanted ?? optimal, maxFlow);
  const steamPerTick = steamFor(flow);
  return { optimal, flow, maxFlow, euPerTick: euFor(steamPerTick), steamPerTick, efficiency: eff };
}

/**
 * MTELargeTurbineGas and MTEXLTurbineGas. A rotor whose tight optimal EU/t
 * is under one litre of the fuel burns 1 L/t and makes exactly that, in
 * either fitting; the XL makes one rotor's worth, not sixteen. On the Large,
 * an optimum that truncates to 0 L/t makes nothing.
 */
function gasRun(
  xl: boolean,
  fuelEu: number,
  rotorFlow: number,
  tightRotorFlow: number,
  eff: number,
  baseEfficiency: number,
  overflowTier: number,
  wanted: number | undefined,
): TurbineRun {
  const rotorEuPerTick = f32(f32(tightRotorFlow) * f32(baseEfficiency));
  if (rotorEuPerTick < fuelEu) {
    const euPerTick = Math.trunc(rotorEuPerTick);
    return {
      optimal: 1,
      flow: 1,
      maxFlow: 1,
      euPerTick,
      efficiency: baseEfficiency,
      skipsDynamoClamp: true,
      warning: `Rotor too weak for this fuel: it burns 1 L/t for ${xl ? "one rotor's " : ""}${formatAmount(euPerTick)} EU/t.`,
    };
  }
  const perRotor = f32(f32(rotorFlow) / fuelEu);
  const optimal = Math.min(INT_CAP, Math.trunc(xl ? f32(16 * perRotor) : perRotor));
  if (optimal <= 0) {
    return idle(
      0,
      eff,
      "Optimal flow rounds down to 0 L/t on this fuel, so the turbine makes no power.",
    );
  }
  const maxFlow = Math.min(
    INT_CAP,
    Math.trunc(f32(f32(optimal) * f32(xl ? 1.25 : 1.5 * overflowTier))),
  );
  const flow = Math.min(wanted ?? optimal, maxFlow);
  let raw = Math.min(INT_CAP, flow * fuelEu);
  if (flow !== optimal) {
    raw = scale(raw, flowEfficiency(flow, optimal, xl ? 1 : overflowTier * 3 - 1, "int"));
  }
  return { optimal, flow, maxFlow, euPerTick: scale(raw, eff), efficiency: eff };
}

/**
 * MTELargeTurbinePlasma rounds its optimum up (Math.ceil); MTEXLTurbinePlasma
 * truncates it, so a weak rotor on a dense plasma can take nothing. The XL
 * also derates plasmas weaker than one rotor's optimal EU/t:
 * min(1, (fuelEU x 0.005)^2 / euAtOptimal).
 */
function plasmaRun(
  xl: boolean,
  fuelEu: number,
  rotorFlow: number,
  eff: number,
  euAtOptimal: number,
  overflowTier: number,
  wanted: number | undefined,
): TurbineRun {
  const flowF = f32(rotorFlow);
  const optimal = Math.min(
    INT_CAP,
    xl ? Math.trunc(f32(f32(16 * flowF) * 20) / fuelEu) : Math.ceil((flowF * 20) / fuelEu),
  );
  // euPerTurbine is MathUtils.roundToClosestInt of one rotor's tight optimal EU/t.
  const euPerTurbine = Math.trunc(Math.round(euAtOptimal * 2) / 2);
  const derated = xl && euPerTurbine > 0;
  let derate = 1;
  if (derated) {
    const magic = f32(fuelEu * f32(0.005));
    derate = Math.min(1, f32(f32(magic * magic) / euPerTurbine));
  }
  if (optimal <= 0) {
    return idle(
      0,
      eff * derate,
      "Optimal flow rounds down to 0 L/s on this plasma, so the turbine makes no power.",
    );
  }
  const maxFlow = Math.min(
    INT_CAP,
    Math.trunc(f32(f32(optimal) * (xl ? f32(1.25) : f32(f32(1.5 * overflowTier) + 1)))),
  );
  const flow = Math.min(wanted ?? optimal, maxFlow);
  let raw = Math.min(INT_CAP, Math.trunc((fuelEu / 20) * flow));
  if (flow !== optimal) {
    raw = xl
      ? Math.trunc(raw * (1 - Math.abs(f32(f32(flow - optimal) / f32(optimal)))))
      : scale(raw, flowEfficiency(flow, optimal, overflowTier * 3 + 1, "int"));
  }
  // The derate multiplies in float even at 1, so large outputs round like the Java's.
  const euPerTick = derated ? scale(scale(raw, eff), derate) : scale(raw, eff);
  return { optimal, flow, maxFlow, euPerTick, efficiency: eff * derate };
}

/**
 * The dynamo hatch a Large turbine clamps fluidIntoPower at: `tEU > getMaximumOutput()`, or
 * `tEU > maxPower` cached from it (GT5U@5.09.54.205 turbines/MTELargeTurbineSteam.java:167,
 * HPSteam :161, SCSteam :112, Gas :188, Plasma :182; GT5U@5.09.51.476 MTELargeTurbineSteam.java:175,
 * HPSteam :166, Gas :197, Plasma :195, goodgenerator MTESupercriticalFluidTurbine.java:84).
 * getMaximumOutput is one hatch's V x amps (MTELargeTurbineBase.java:263-270). The fuel is drained
 * before the clamp, so a small hatch wastes EU, not fuel. The XL turbines have no clamp. Rotor wear
 * reads the clamped output: lEUt on 2.9 (GT5U@5.09.54.205 MTEExtendedPowerMultiBlockBase.java:67),
 * mEUt on 2.8.1 (GT5U@5.09.51.476 MTEMultiBlockBase.java:1344).
 *
 * addDynamoToMachineList takes any MTEHatchDynamo (GT5U@5.09.51.476 MTEMultiBlockBase.java:2038-2046),
 * of up to 4A on 2.9 (GT5U@5.09.54.205 MTEMultiBlockBase.java:2284). The hatches that fit:
 * - GT's dynamo hatches, ULV to UXV at 1A (Hatch_Dynamo_ULV..UXV, LoaderMetaTileEntities registerDynamoHatch;
 *   MetaTileEntity.maxAmperesOut is 1), on both versions. No 1A MAX dynamo exists.
 * - GT++'s buffered dynamos, ULV to UHV at 4A (MTEHatchDynamoBuffer.maxAmperesOut, GregtechBufferDynamos
 *   tiers 00-09), on both versions.
 * - 2.8.1's wireless dynamos, ULV to MAX at 2A (GT5U@5.09.51.476 MTEWirelessDynamo.java:24, :75-77;
 *   LoaderMetaTileEntities wireless transmitter tiers 00-14).
 * - 2.9's TecTech 4A dynamos, HV to UXV (GT5U@5.09.54.205 MTEHatchDynamoMulti.java:32 extends
 *   MTEHatchDynamo; MachineLoader.java:1049-1148). In 2.8.1 MTEHatchDynamoMulti extends MTEHatch
 *   (GT5U@5.09.51.476 MTEHatchDynamoMulti.java:29) and does not fit.
 * A 4A hatch's cap equals the 1A hatch one tier up; each is listed as the hatch the player builds.
 */
interface DynamoOption {
  key: string;
  label: string;
  maxEuT: number;
}

const DYNAMO_TIERS = GT_VOLTAGE_TIERS.filter(({ tier }) => tier !== "MAX");

function dynamoRange(first: string, last: string): typeof GT_VOLTAGE_TIERS {
  const from = GT_VOLTAGE_TIERS.findIndex(({ tier }) => tier === first);
  const to = GT_VOLTAGE_TIERS.findIndex(({ tier }) => tier === last);
  return GT_VOLTAGE_TIERS.slice(from, to + 1);
}

function dynamoOptions(gameVersion: GameVersion): DynamoOption[] {
  // A multi-amp option names the hatch that gives it: "LV 2A wireless" (2.8.1's Wireless Energy Dynamo),
  // "EV 4A buffered" (GT++'s Buffered Dynamo Hatch), "UEV 4A TecTech" (TecTech's 4A Dynamo Hatch); on 2.9 either
  // 4A hatch fits from HV to UHV.
  const at = (amps: number, kind: (tier: string) => string = () => "") => (tiers: typeof GT_VOLTAGE_TIERS) =>
    tiers.map(({ tier, maxEuT }) => {
      const name = amps === 1 ? tier : `${tier} ${amps}A`;
      const hatch = kind(tier);
      return {
        key: name,
        label: `${name}${hatch ? ` ${hatch}` : ""}, ${formatAmount(maxEuT * amps)} EU/t`,
        maxEuT: maxEuT * amps,
      };
    });
  const buffered = new Set<string>(dynamoRange("ULV", "UHV").map(({ tier }) => tier));
  const tectech = new Set<string>(dynamoRange("HV", "UXV").map(({ tier }) => tier));
  if (gameVersion === "2.8.1") {
    return [
      ...at(1)(DYNAMO_TIERS),
      ...at(2, () => "wireless")(GT_VOLTAGE_TIERS),
      ...at(4, () => "buffered")(dynamoRange("ULV", "UHV")),
    ];
  }
  // Buffered 4A (ULV to UHV) and TecTech 4A (HV to UXV) together cover ULV to UXV.
  const kind4 = (tier: string) => (!tectech.has(tier) ? "buffered" : buffered.has(tier) ? "TecTech or buffered" : "TecTech");
  return [...at(1)(DYNAMO_TIERS), ...at(4, kind4)(DYNAMO_TIERS)];
}

/** The default: a hatch that holds whatever the rotor makes. */
const DYNAMO_LARGE_ENOUGH = "auto";

const SPECS: TurbineSpec[] = [
  {
    id: "large-steam-turbine",
    name: "Large Steam Turbine",
    unlock: "HV",
    blurb: "Steam in, EU out; the rotor decides.",
    turbineClass: "steam",
    xl: false,
    steamGrade: "Steam",
  },
  {
    id: "large-hp-steam-turbine",
    name: "Large HP Steam Turbine",
    unlock: "EV",
    blurb: "SH steam in; exhausts plain steam.",
    turbineClass: "steam",
    xl: false,
    steamGrade: "SH Steam",
  },
  {
    id: "large-sc-steam-turbine",
    name: "Large SC Steam Turbine",
    // GoodGenerator's assembler recipe: IV hull, LuV circuits.
    unlock: "LuV",
    blurb: "SC steam in; exhausts SH steam.",
    turbineClass: "steam",
    xl: false,
    steamGrade: "SC Steam",
  },
  {
    id: "xl-turbo-steam-turbine",
    name: "XL Turbo Steam Turbine",
    // The XL unlocks follow their controller's assembler recipe
    // (RecipesMachinesCustom): EV, IV, LuV, ZPM and ZPM circuits and power.
    unlock: "EV",
    blurb: "Sixteen steam turbines; dense too.",
    turbineClass: "steam",
    xl: true,
    steamGrade: "select",
    steamGradeOptions: ["Steam", "Dense Steam"],
  },
  {
    id: "xl-turbo-hp-steam-turbine",
    name: "XL Turbo HP Steam Turbine",
    unlock: "IV",
    blurb: "Sixteen HP turbines; exhausts steam.",
    turbineClass: "steam",
    xl: true,
    steamGrade: "select",
    steamGradeOptions: ["SH Steam", "Dense SH Steam"],
  },
  {
    id: "xl-turbo-sc-steam-turbine",
    name: "XL Turbo SC Steam Turbine",
    unlock: "ZPM",
    blurb: "Sixteen SC turbines; exhausts SH.",
    turbineClass: "steam",
    xl: true,
    steamGrade: "select",
    steamGradeOptions: ["SC Steam", "Dense SC Steam"],
  },
  {
    id: "large-gas-turbine",
    name: "Large Gas Turbine",
    unlock: "EV",
    blurb: "Gas fuels at rotor efficiency.",
    turbineClass: "gas",
    xl: false,
  },
  {
    id: "xl-turbo-gas-turbine",
    name: "XL Turbo Gas Turbine",
    unlock: "LuV",
    blurb: "Sixteen gas turbines in one.",
    turbineClass: "gas",
    xl: true,
  },
  {
    id: "large-plasma-generator",
    name: "Large Plasma Generator",
    unlock: "LuV",
    blurb: "Plasma to EU and its cooled gas.",
    turbineClass: "plasma",
    xl: false,
  },
  {
    id: "xl-turbo-plasma-turbine",
    name: "XL Turbo Plasma Turbine",
    unlock: "ZPM",
    blurb: "Sixteen plasma turbines in one.",
    turbineClass: "plasma",
    xl: true,
  },
];

function buildTurbine(
  tables: PowerTables,
  spec: TurbineSpec,
  gameVersion: GameVersion,
): PowerSourceDefinition {
  const settings: PowerSetting[] = [
    {
      type: "select",
      id: "rotor",
      label: "Rotor",
      options: tables.rotors.map((rotor) => ({
        key: rotor.name,
        label: `${rotor.name} (${rotor.unlock})`,
      })),
      defaultKey: spec.xl ? "HSS-E" : "Carbon",
    },
    {
      type: "select",
      id: "size",
      label: "Rotor size",
      options: ROTOR_SIZE_NAMES.map((name) => ({ key: name, label: name })),
      defaultKey: spec.xl ? "Huge" : "Normal",
    },
    {
      type: "select",
      id: "fitting",
      label: "Fitting",
      options: [
        { key: "tight", label: "Tight" },
        { key: "loose", label: "Loose" },
      ],
      defaultKey: "tight",
    },
  ];
  if (spec.steamGrade === "select") {
    const grades = fuelOptions(tables.steamGrades).filter(
      (option) => spec.steamGradeOptions?.includes(option.key) ?? true,
    );
    settings.push({
      type: "select",
      id: "grade",
      label: "Steam type",
      options: grades,
      defaultKey: grades[0]?.key ?? "Steam",
    });
  } else if (spec.turbineClass === "gas") {
    settings.push({
      type: "select",
      id: "fuel",
      label: "Fuel",
      options: fuelOptions(spec.xl ? tables.gasFuelsXl : tables.gasFuels),
      // The XL hard-refuses benzene in the game (and Fox's XL fuel table
      // matches), so its default is the sheet's own pick.
      defaultKey: spec.xl ? "Nitrobenzene" : "Benzene",
    });
  } else if (spec.turbineClass === "plasma") {
    settings.push({
      type: "select",
      id: "fuel",
      label: "Plasma",
      options: fuelOptions(tables.plasmas),
      defaultKey: "Helium Plasma",
    });
  }
  const dynamos = spec.xl ? [] : dynamoOptions(gameVersion);
  if (!spec.xl) {
    settings.push({
      type: "select",
      id: "dynamo",
      label: "Dynamo hatch",
      options: [
        { key: DYNAMO_LARGE_ENOUGH, label: "Large enough" },
        ...dynamos.map(({ key, label }) => ({ key, label })),
      ],
      defaultKey: DYNAMO_LARGE_ENOUGH,
    });
  }
  settings.push(
    {
      type: "select",
      id: "flowMode",
      label: "Flow",
      options: [
        { key: "optimal", label: "Optimal" },
        { key: "custom", label: "Custom" },
      ],
      defaultKey: "optimal",
    },
    {
      type: "number",
      id: "customFlow",
      label: "Custom flow",
      min: 1,
      max: 100_000_000,
      step: 1,
      defaultValue: 100,
      unit: spec.turbineClass === "plasma" ? "L/s" : "L/t",
      enabledWhen: { settingId: "flowMode", equals: "custom" },
    },
  );

  return {
    id: spec.id,
    name: spec.name,
    group: "turbines",
    unlock: spec.unlock,
    blurb: spec.blurb,
    settings,
    compute(read): PowerModel {
      const rotor = findRotor(read.select("rotor"), tables);
      const sizeIndex = Math.max(0, ROTOR_SIZE_NAMES.indexOf(read.select("size") as never));
      const tight = read.select("fitting") !== "loose";
      const data = classData(rotor, spec.turbineClass);
      const overflowTier = rotor.overflowTier;

      let fuelName: string;
      let fuelEu: number;
      if (spec.turbineClass === "steam") {
        fuelName =
          spec.steamGrade === "select" ? read.select("grade") : (spec.steamGrade as string);
        fuelEu = findFuel(tables.steamGrades, fuelName).euPerLiter ?? 0.5;
      } else {
        fuelName = read.select("fuel");
        const table =
          spec.turbineClass === "gas"
            ? spec.xl
              ? tables.gasFuelsXl
              : tables.gasFuels
            : tables.plasmas;
        fuelEu = findFuel(table, fuelName).euPerLiter ?? 0;
      }

      // The tight value is getBaseEfficiency, which the SC and gas checks read in either fitting.
      const baseEfficiency = javaBaseEfficiency(
        pickLadder(data.efficiencyTight, sizeIndex),
        sizeIndex,
      );
      const efficiency = tight ? baseEfficiency : pickLadder(data.efficiencyLoose, sizeIndex);
      const rotorFlow = pickLadder(tight ? data.optimalTight : data.optimalLoose, sizeIndex);
      const dense = fuelName.startsWith("Dense");
      const wanted = read.select("flowMode") === "custom" ? read.number("customFlow") : undefined;

      let run: TurbineRun;
      if (spec.turbineClass === "steam") {
        // Every steam grade runs the rotor's steam flow (SC included: MTELargeTurbineSCSteam
        // uses getOptimalSteamFlow like HP); the XL is x16.
        run = spec.xl
          ? xlSteamRun(fuelName, rotorFlow, efficiency, wanted, gameVersion)
          : largeSteamRun(
              fuelName,
              rotorFlow,
              overflowTier,
              efficiency,
              baseEfficiency,
              wanted,
              gameVersion,
            );
      } else if (spec.turbineClass === "gas") {
        run = gasRun(
          spec.xl,
          fuelEu,
          rotorFlow,
          pickLadder(data.optimalTight, sizeIndex),
          efficiency,
          baseEfficiency,
          overflowTier,
          wanted,
        );
      } else {
        run = plasmaRun(
          spec.xl,
          fuelEu,
          rotorFlow,
          efficiency,
          pickLadder(data.euAtOptimalTight ?? [], sizeIndex),
          overflowTier,
          wanted,
        );
      }
      const dynamo = dynamos.find((option) => option.key === read.select("dynamo"));
      let dynamoWarning: string | undefined;
      if (dynamo && !run.skipsDynamoClamp && run.euPerTick > dynamo.maxEuT) {
        dynamoWarning = `The ${dynamo.key} dynamo hatch caps output at ${formatAmount(dynamo.maxEuT)} EU/t; the rotor makes ${formatAmount(run.euPerTick)} EU/t.`;
        run = { ...run, euPerTick: dynamo.maxEuT };
      }
      const { euPerTick, flow, maxFlow } = run;

      const lifespanSeconds = rotorLifespanSeconds(
        spec.xl,
        euPerTick,
        rotorDurability(rotor, sizeIndex, tables),
        damagePerRoll(spec, fuelName, tight),
      );

      const flowPerSecond = spec.turbineClass === "plasma" ? flow : flow * 20;
      const inputs: PowerFlowLine[] = [liters(fuelName, flowPerSecond)];
      const outputs: PowerFlowLine[] = [];
      // 2.8.1's XL can credit dense steam while draining none (a cap under 1,000 L/t).
      const ran = flow > 0 || (run.steamPerTick ?? 0) > 0;
      if (ran && spec.turbineClass === "steam") {
        const exhaust = STEAM_EXHAUST[fuelName];
        if (exhaust) {
          // HP and SC return one litre of the next grade down per litre taken
          // (dense litres for dense steam, even past the cap).
          outputs.push(liters(exhaust, flowPerSecond));
        } else {
          // Plain steam condenses: MTELargeTurbineSteam returns distilled
          // water at 1 L per 160 L of steam. The XL's dense-steam path uses
          // its own 160.1 divisor on the steam-equivalent litres it used -
          // the game's constant, not a typo.
          const steamEquivalent = dense
            ? (run.waterSteamPerTick ?? run.steamPerTick ?? 0) * 20
            : flowPerSecond;
          outputs.push(liters("Distilled Water", steamEquivalent / (dense ? 160.1 : 160)));
        }
      } else if (flow > 0 && spec.turbineClass === "plasma") {
        const exhaust = plasmaExhaust(fuelName, tables, gameVersion);
        if (exhaust) {
          outputs.push(liters(exhaust, flowPerSecond));
        }
      }

      const warnings: string[] = dynamoWarning ? [dynamoWarning] : [];
      if (run.warning) {
        warnings.push(run.warning);
      } else if (wanted !== undefined && wanted > maxFlow) {
        warnings.push(
          `Flow is capped at ${formatAmount(maxFlow)}; the turbine will not take more.`,
        );
      }

      return {
        euPerTick,
        inputs,
        outputs,
        stats: [
          stat("Efficiency", percent(run.efficiency)),
          stat(
            "Optimal flow",
            `${formatAmount(run.optimal)} ${spec.turbineClass === "plasma" ? "L/s" : "L/t"}`,
          ),
          stat("Rotor lifespan", lifespanHours(lifespanSeconds)),
        ],
        warnings: warnings.length ? warnings : undefined,
      };
    },
  };
}

export const buildTurbineSources: PowerSourceBuilder = (tables, gameVersion) => {
  return SPECS.map((spec) => buildTurbine(tables, spec, gameVersion));
};
