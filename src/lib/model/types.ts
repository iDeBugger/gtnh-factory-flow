import type { PlanSolveExtras } from "@/lib/solver/plan/types";

export const PROJECT_SCHEMA_VERSION = 1;
export const TICKS_PER_SECOND = 20;

export type ItemId = string;
export type FluidId = string;
export type AspectId = string;
export type ResourceId = ItemId | FluidId | AspectId;
/**
 * `power` is EU as a resource: one canonical id (`eu`), produced by
 * generator cards' synthesized recipes and consumed by nothing - drawers
 * only. Its flows are per-second like every flow; display is always EU/t.
 */
export type ResourceKind = "item" | "fluid" | "aspect" | "power";
export type ResourceKey = `${ResourceKind}:${string}`;

export interface ResourceIconAtlasRef {
  imagePath: string;
  atlasWidth: number;
  atlasHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dominantColor?: string;
}

/**
 * One item or fluid picked as the face of a whole entry: a plan, a shared
 * setup, a blueprint. Same icon plumbing as a resource slot, minus the rate.
 * Lives in the model because a plan carries its own face and the model cannot
 * import community code.
 */
export interface EntryIcon {
  kind: ResourceKind;
  resourceId: string;
  displayName?: string;
  iconPath?: string;
  iconAtlas?: ResourceIconAtlasRef;
  dominantColor?: string;
}

export type MachineTier =
  | "ULV"
  | "LV"
  | "MV"
  | "HV"
  | "EV"
  | "IV"
  | "LuV"
  | "ZPM"
  | "UV"
  | "UHV"
  | "UEV"
  | "UIV"
  | "UMV"
  | "UXV"
  | "MAX"
  | "DEMO";

export type FactoryNodeColorTag =
  | "white"
  | "orange"
  | "magenta"
  | "light_blue"
  | "yellow"
  | "lime"
  | "pink"
  | "gray"
  | "light_gray"
  | "cyan"
  | "purple"
  | "blue"
  | "brown"
  | "green"
  | "red"
  | "black"
  // The app's own ink, offered as paint: the alarm red, the warning amber,
  // the output emerald, the product blue, and the two card greys.
  | "scarlet"
  | "amber"
  | "emerald"
  | "azure"
  | "steel"
  | "onyx";

/**
 * The in-game planner's own data for one thing (or the whole plan), opaque to
 * the website and carried through every edit unchanged. At most
 * GTNHPLANNER_DATA_MAX_BYTES serialized (schemas.ts).
 */
export type GtnhPlannerData = Record<string, unknown>;

/** Which view a plan opens on: the board, or its task board. */
export type PlanPrimaryView = "plan" | "tasks";

export type PlanTaskStatus = "todo" | "doing" | "blocked" | "done";

/**
 * A task on the plan's task board. `order` is a fractional index: tasks sort
 * by it inside a column, and a move writes one new key between two others.
 */
export interface PlanTask {
  id: string;
  title: string;
  text?: string;
  status: PlanTaskStatus;
  order: string;
  /** Account ids of the plan's members working on it. */
  assignees?: string[];
  /**
   * Cards of other plans the task is about (a task board is a plan of its own kind: it holds no cards).
   * Older boards wrote `nodeIds`, cards of the plan holding the task; they are still read.
   */
  links?: PlanTaskLink[];
  /** Older spelling of `links`: cards of the plan that holds the task. Read, no longer written. */
  nodeIds?: string[];
  createdBy?: string;
  createdAt?: string;
  doneAt?: string;
  /** How pressing it is; none is Medium (the game writes none for Medium). */
  priority?: PlanTaskPriority;
  /** When it last moved to another column (a move within a column leaves it); without one it counts from `createdAt`. */
  movedAt?: string;
  /**
   * Tasks of the same board it waits on, by id: each once, never itself, never a loop (the adding side refuses one).
   * An id naming no task on the board is ignored.
   */
  blockedBy?: string[];
}

export type PlanTaskPriority = "high" | "medium" | "low";

/**
 * A card on a plan. `plan` is the plan's id as the library knows it: `<ownerId>:<designId>` for a plan in the
 * account, the local design id for one on this device only; `node` is the card's id in that plan.
 */
export interface PlanTaskLink {
  plan: string;
  node: string;
}

/** What a task's thing is: a card on a plan, a spot in a game world, a screenshot. Older checklist lines have none. */
export type PlanTaskItemKind = "machine" | "location" | "picture";

/**
 * A spot in a game world: the block `x y z` in dimension `dim` (named `dimName` as the game names it: "Overworld"),
 * in the world `world` (as placed machines key worlds: `server:<16 hex>` or `world:<uuid>`), with an optional label.
 */
export interface PlanPlace {
  x: number;
  y: number;
  z: number;
  dim: number;
  dimName: string;
  world: string;
  label?: string;
}

/**
 * A screenshot taken in the game: `thumb` a small JPEG as a data URL (all that syncs), the full shot `w` by `h`,
 * when it was taken, and the full shot's file name in the screenshots folder of the game that took it.
 */
export interface PlanPicture {
  thumb: string;
  w: number;
  h: number;
  takenAt: string;
  file?: string;
}

/**
 * A quest in the game's quest book (the game's only, as the screenshot is): its id there, with its name, icon (an
 * item key) and quest line, to read where the book is not. Kept as it came; the website shows the thing's words.
 */
export interface PlanQuest {
  id: string;
  name: string;
  icon?: string;
  line?: string;
}

/**
 * One thing on a task, its own thing so two people can tick two at once: a machine (`link`), a location (`place`)
 * or a screenshot (`picture`). An item with no `kind` is an older checklist line: a machine when it has a link, else
 * words. `text` is always written, the thing in words, so a reader that knows only lines shows something true.
 */
export interface PlanTaskItem {
  id: string;
  taskId: string;
  /** A quest (`quest`) is the game's only: the website shows it as its words. */
  kind?: PlanTaskItemKind | "quest";
  text: string;
  done: boolean;
  order: string;
  /** The card this thing is about. */
  link?: PlanTaskLink;
  /** Older spelling of `link`: a card of the plan that holds the task. Read, no longer written. */
  nodeId?: string;
  place?: PlanPlace;
  picture?: PlanPicture;
  quest?: PlanQuest;
}

/** A comment on a task. `at` is stamped by the server. */
export interface PlanTaskComment {
  id: string;
  taskId: string;
  by: string;
  byName: string;
  at: string;
  text: string;
}

export interface ResourceAmount {
  kind: ResourceKind;
  id: ResourceId;
  amount: number;
  displayName?: string;
  iconPath?: string;
  iconAtlas?: ResourceIconAtlasRef;
  dominantColor?: string;
  modId?: string;
  tooltip?: string[];
  neiSlot?: {
    x: number;
    y: number;
  };
  alternatives?: ResourceAlternative[];
}

export type ResourceAlternative = Pick<
  ResourceAmount,
  "kind" | "id" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor" | "tooltip" | "modId"
> &
  Partial<Pick<ResourceAmount, "amount">>;

export interface RecipeInput extends ResourceAmount {
  optional?: boolean;
  consumed?: boolean;
}

export interface RecipeOutput extends ResourceAmount {
  chance?: number;
  byproduct?: boolean;
}

export interface RuntimeCalculationResource {
  kind: ResourceKind;
  id: ResourceId;
  amount: number;
  chance?: number;
}

export interface RuntimeCalculationVariant {
  id: string;
  label?: string;
  machineHandlerId?: string;
  overclockTier?: MachineTier | string;
  coilTier?: string;
  machineConfigTiers?: Record<string, string>;
  durationTicks: number;
  eut: number;
  parallel?: number;
  inputs?: RuntimeCalculationResource[];
  outputs?: RuntimeCalculationResource[];
  notes?: string;
}

export interface RuntimeCalculation {
  sourceKind:
    | "gregtech-processing-logic"
    | "gregtech-overclock-calculator"
    | "gregtech-recipe-baseline"
    | "thaumcraft-runtime"
    | "passive-bee"
    | "passive-crop"
    | "synthetic-passive-bootstrap";
  sourceClass?: string;
  sourceVersion?: string;
  recipeMap?: string;
  status: "computed" | "partial" | "missing";
  oracleEligible: boolean;
  strict?: boolean;
  generatedAt?: string;
  variants: RuntimeCalculationVariant[];
  warnings?: string[];
}

export interface MachineProfile {
  machineType: string;
  minimumTier: MachineTier | string;
  /**
   * The highest real machine in a singleblock family. A tier above it is
   * not a block, so the tier chip stops here and the run tier clamps to it.
   * Absent on multiblocks, whose tier is their hatches.
   */
  maximumTier?: MachineTier | string;
  /** Registered singleblock tiers; some families skip intermediate voltages. */
  availableTiers?: string[];
  durationTicks?: number;
  eut?: number;
  maxParallel?: number;
  eutLimit?: number;
  /** True when the machine performs 4x speed / 4x power overclocks. */
  perfectOverclock?: boolean;
  /**
   * Carried through from the selected handler. Multiblocks turn speed they
   * cannot spend below one tick into extra parallels; singleblocks cannot,
   * and waste it. See `overclock.ts`.
   */
  kind?: "single" | "multiblock" | "crafting" | "automation";
  notes?: string;
}

export interface MachineHandler extends MachineProfile {
  id: string;
  label: string;
  kind?: "single" | "multiblock" | "crafting" | "automation";
  machineConfigControls?: MachineConfigControl[];
}

export interface MachineConfigTierOption {
  key: string;
  label: string;
  heat?: number;
  durationMultiplier?: number;
  eutMultiplier?: number;
  outputMultiplier?: number;
  parallelMultiplier?: number;
  /** Parallels that scale with the machine's voltage tier (GT++ "Voltage Tier * n Parallels"). */
  parallelPerVoltageTier?: number;
  /** Additive base for voltage-scaled parallels: floor(base + n * tier), e.g. Zhuhai 2 * (tier + 1). */
  parallelVoltageBase?: number;
  resource: ResourceAmount;
}

export interface MachineConfigControl {
  id: string;
  label: string;
  minimumKey: string;
  defaultKey?: string;
  /**
   * Typed-number entry; an omitted maximum means there is no machine limit.
   * Values snap to `step` (default: whole numbers).
   */
  numeric?: { min: number; max?: number; step?: number };
  /**
   * The recipe's own special value is a 1-based minimum tier on this ladder
   * (the Naquadah Fuel Refinery's field restriction coils), so `minimumKey`
   * is overridden per recipe to `tiers[specialValue - 1]`. Declared by
   * curated machine-table controls only; the dataset never emits it.
   */
  minimumFromSpecialValue?: boolean;
  /** Special value is required heat in K; offer only coils that meet it. */
  minimumHeatFromSpecialValue?: boolean;
  tiers: MachineConfigTierOption[];
}

export interface Recipe {
  id: string;
  name: string;
  kind?:
    | "gregtech_machine"
    | "bee_produce"
    | "crop_produce"
    | "ore_vein"
    | "small_ore"
    | "underground_fluid"
    | "essentia_smelting"
    | "custom"
    | "unknown";
  category?: string;
  machineType: string;
  minimumTier: MachineTier | string;
  /** The family's highest real machine, carried from the selected handler; see MachineProfile. */
  maximumTier?: MachineTier | string;
  /** Actual registered tiers carried from the selected singleblock handler. */
  availableTiers?: string[];
  /**
   * The recipe map's amperage when a singleblock runs it (above 1 only), set by
   * `applyMachineHandlerToRecipe`: the minimum tier is the one whose voltage
   * times this covers the EU/t. Never stored in a dataset.
   */
  recipeMapAmperage?: number;
  durationTicks: number;
  eut: number;
  inputs: RecipeInput[];
  outputs: RecipeOutput[];
  programmedCircuit?: string;
  specialValue?: number;
  notes?: string;
  machineProfile?: MachineProfile;
  machineHandlers?: MachineHandler[];
  machineConfigControls?: MachineConfigControl[];
  /**
   * Power cards only (src/lib/power): the generator this synthesized recipe
   * was built from and its net EU/t at the baked settings. Presence of this
   * field is what marks a recipe as a power card.
   */
  power?: {
    sourceId: string;
    euPerTick: number;
    stats: Array<{ label: string; value: string }>;
    warnings?: string[];
  };
  runtimeCalculation?: RuntimeCalculation;
  isDemo?: boolean;
  source?: {
    datasetVersionId?: string;
    recipeMap?: string;
    sourceMod?: string;
    exporter?: "nesql" | "recex" | "nerd" | "gtnh-oracle" | "unknown";
    rawRecipeId?: string;
    sourceIdentifier?: string;
  };
  metadata?: Record<string, unknown>;
  nei?: {
    iconPath?: string;
    source?: string;
    handlerClass?: string;
    canvas?: { width: number; height: number };
    backgroundImage?: string;
    itemInputGrid?: { width: number; height: number };
    itemOutputGrid?: { width: number; height: number };
    fluidInputGrid?: { width: number; height: number };
    fluidOutputGrid?: { width: number; height: number };
    slotCapacity?: {
      maxItemInputs?: number;
      maxItemOutputs?: number;
      maxFluidInputs?: number;
      maxFluidOutputs?: number;
    };
    slots?: Array<{
      side: "input" | "output";
      kind: ResourceKind;
      slotIndex: number;
      x: number;
      y: number;
    }>;
    progressBars?: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      direction: "right" | "up" | "circular";
      texture?: string;
    }>;
    additionalInfo?: string[];
    requiresCleanroom?: boolean;
    requiresLowGravity?: boolean;
  };
}

/** Which way a custom rate card faces: it makes the resource, or it drinks it. */
export type CustomRateMode = "supply" | "request";

/**
 * A recipe a plan conversion to another game version could not find there
 * (`convert-plan-version.ts`). Its body is gone from the plan; the card keeps
 * its id, count, pins, tier, config and wires, and this says what it was. The
 * id is the source plan's, shown to the player and never looked up.
 */
export interface UnconvertedRecipe {
  fromGameVersion: string;
  recipeId: string;
  recipeName: string;
  machineType: string;
  /** Why, when it is more than "no match": the machine is not in that version. */
  reason?: string;
}

/** One more recipe on a card's machine; see `FactoryNode.extraRecipes`. */
export interface FactoryNodeRecipeSection {
  recipeId: string;
  recipeInputOverrides?: Record<string, RecipeInput>;
  /** This section's recipe was not found when the plan was converted to another version. */
  unconverted?: UnconvertedRecipe;
}

export interface FactoryNode {
  id: string;
  recipeId: string;
  colorTag?: FactoryNodeColorTag;
  /**
   * Custom rate cards only: the dial. Kept on the card because the synthetic
   * recipe's slot (the live value the solver reads) is emptied whenever the
   * card lets go of its resource; this keeps the number across a rewire.
   */
  customRate?: { perSecond: number; mode: CustomRateMode };
  /** When set, Industrial Farm planting follows this many full seed beds. */
  cropFullFarmCount?: number;
  machineCount: number;
  parallel: number;
  overclockTier: MachineTier | string;
  /**
   * Energy hatches built into a multiblock, 1 by default. One hatch works at
   * 1 amp of its tier; two or more work at 2 amps each, so 2 hatches carry
   * four times the power of one. Ignored on singleblocks, which have no
   * hatches.
   */
  energyHatches?: number;
  /**
   * Which energy hatch family feeds the machine (`energy-hatches.ts`).
   * Absent means the regular 2 A hatches above; the exotic families
   * (multi-amp, laser) carry their whole rating through ONE hatch, so
   * `energyHatches` is clamped to 1 while one of them is selected.
   */
  energyHatchType?: string;
  /** Derived hatchVoltageTier voltage × hatchAmps, persisted for old readers. */
  powerEuT?: number;
  /** Average input voltage, independent of the total power pool. */
  hatchVoltageTier?: Exclude<MachineTier, "DEMO">;
  /** Working input amps. One regular hatch supplies one amp. */
  hatchAmps?: number;
  /** Raw EU/t assumes a suitable voltage; explicit amps use the selected hatch tier. */
  powerInputMode?: "amps" | "eut";
  machineHandlerId?: string;
  coilTier?: string;
  machineConfigTiers?: Record<string, string>;
  /** Settings panel folded shut. A view choice, kept so it survives a reload. */
  settingsCollapsed?: boolean;
  /** Fluids fully supplied by an installed hatch; shared by all recipes on this card. */
  hatchSupplies?: Array<"water" | "air">;
  recipeInputOverrides?: Record<string, RecipeInput>;
  /**
   * More recipes the SAME machine runs (`shared-machine.ts`): a Large
   * Chemical Reactor fed for two reactions is one card with two sections.
   * Each section keeps its own slots, wires and oredict picks; the machine
   * count, tier and every config knob are the card's and shared. Section 0
   * is `recipeId` above; these are sections 1..n, and their port handles
   * wear an `r<n>:` prefix. Absent or empty means an ordinary one-recipe card.
   */
  extraRecipes?: FactoryNodeRecipeSection[];
  /** Section 0's recipe was not found when the plan was converted to another version. */
  unconverted?: UnconvertedRecipe;
  /**
   * The machine count the player set. By default it is an Up to count
   * (docs/up-to.md): the machines run as hard as the plan lets them, never
   * above it, and say why when they run less. With `solvePinExact` it is an
   * Exactly count: run this many flat out and solve the rest around it, gaps
   * shown as forced flows. Absent means the solver chooses the count; the
   * card then reads Any. A custom rate card's pin is always exact.
   */
  solvePin?: number;
  /** `solvePin` is Exactly, not Up to. Absent or false: Up to. Meaningless without `solvePin`. */
  solvePinExact?: boolean;
  /**
   * An older plan's Any mark: read by nothing (no count is Any) and dropped by
   * the next count write. Kept in the type so plans that carry it still load.
   */
  solvePinAny?: boolean;
  /**
   * Plan mode's port-rate pins, units per second by canonical handle id
   * (`output:item:foo`, `r2:input:fluid:bar` for a shared machine's section).
   * A rate pins the card's extent exactly. Absent or empty means no pin;
   * nothing reads it outside plan mode.
   */
  portRates?: Record<string, number>;
  enabled: boolean;
  /** The board (pocket) this card lives in; absent = the root board. */
  pocketId?: string;
  position: {
    x: number;
    y: number;
  };
  /** The in-game planner's data for this thing; see GtnhPlannerData. */
  gtnhplanner?: GtnhPlannerData;
}

/**
 * What a drawer at the END of the plan does about the machine feeding it.
 *
 * `product` (the default) pulls: it asks its feeder for everything the
 * machine can make, so the machine runs flat out.
 *
 * `byproduct` only catches what is left: it asks for nothing, so the pace is
 * set by whoever really wants the output (or the plan's target rate), and the
 * leftover lands here instead of clogging the machine.
 *
 * `trash` asks for nothing and un-clogs like a byproduct, but what it eats is
 * dropped from the books instead of counted as surplus. Legacy trash can
 * nodes are converted to trash drawers on load.
 */
export type StorageDrainMode = "product" | "byproduct" | "trash";

export interface FactoryStorage {
  id: string;
  kind: ResourceKind;
  resourceId: ResourceId;
  /** Drains only; absent means `product`. See StorageDrainMode. */
  drainMode?: StorageDrainMode;
  /**
   * The drawer's rate: negative for fresh input, positive for output. The board shows the magnitude. Ignored on
   * buffer, byproduct and trash drawers; a product with no number is unconstrained (byproduct-shaped).
   */
  targetPerSecond?: number;
  /** The drawer's rate rule. */
  targetMode?: "at-least" | "at-most" | "exact" | "ignore";
  /**
   * Which side a loose drawer (no wires of its own, `addPoolStorage`) sits on: a `source` feeds the plan, a `drain`
   * takes from it (its `drainMode` still says product, byproduct or trash). Ignored while the drawer has wires.
   */
  poolSide?: "source" | "drain";
  colorTag?: FactoryNodeColorTag;
  displayName?: string;
  iconPath?: string;
  iconAtlas?: ResourceIconAtlasRef;
  dominantColor?: string;
  capacity?: number;
  /** The board (pocket) this drawer lives in; absent = the root board. */
  pocketId?: string;
  position: {
    x: number;
    y: number;
  };
  /** The in-game planner's data for this thing; see GtnhPlannerData. */
  gtnhplanner?: GtnhPlannerData;
}

export type FactoryAnnotationKind = "box" | "arrow" | "text" | "zone" | "image";

export type FactoryAnnotationArrowDirection = "down-right" | "down-left" | "up-right" | "up-left";

export type FactoryAnnotationBorderStyle = "solid" | "dashed" | "none";

/**
 * How strongly a box/zone paints its surface: a faint wash, opaque, or not at
 * all. The surface COLOUR is separate (`fillColor` for a dye, `fillTheme` for
 * a textured paper), and the marks drawn over it are separate again
 * (`marks`) - three orthogonal choices.
 *
 * The extra tokens are legacy spellings still accepted on read: a mark token
 * here means a tint surface wearing that mark.
 */
export type FactoryAnnotationFillStyle =
  | "tint"
  | "solid"
  | "none"
  | "paper"
  | "dots"
  | "grid"
  | "graph"
  | "ruled"
  | "hatch";

/** The marks a box/zone draws over its surface: the board's own vocabulary. */
export type FactoryAnnotationMarks = "none" | "dots" | "grid" | "graph" | "ruled" | "hatch";

/**
 * How a box, zone or image is dressed. Every field optional: absent means the
 * classic look (solid border and faint tint, both in `colorTag`). Border and
 * fill colours fall back to `colorTag`, which keeps the paint tool working on
 * styled shapes.
 */
export interface FactoryAnnotationStyle {
  border?: FactoryAnnotationBorderStyle;
  borderColor?: FactoryNodeColorTag;
  fill?: FactoryAnnotationFillStyle;
  fillColor?: FactoryNodeColorTag;
  /**
   * A textured paper as the surface instead of a dye: one of the canvas
   * theme ids. Set from the fill colour popover alongside the dyes; wins
   * over `fillColor` while present.
   */
  fillTheme?: string;
  /** Marks drawn over the surface; absent = none. */
  marks?: FactoryAnnotationMarks;
}

export interface FactoryAnnotation {
  id: string;
  kind: FactoryAnnotationKind;
  colorTag?: FactoryNodeColorTag;
  text?: string;
  position: {
    x: number;
    y: number;
  };
  size: {
    width: number;
    height: number;
  };
  /** Arrow only: which corners of the bounding box the arrow connects (tail → head). */
  arrowDirection?: FactoryAnnotationArrowDirection;
  /** Arrow only: a head at the end only (default) or at both ends. */
  arrowHeads?: "end" | "both";
  /** Arrow only: the line's thickness in the mod's board px (1 thin, 2 normal and default, 4 thick). */
  arrowWidth?: number;
  /**
   * Zone only: the outline's vertices, in order, relative to `position`.
   * Drawn as a closed loop; `position`/`size` stay the bounding box so the
   * board can frame and drag it like any other annotation.
   */
  points?: Array<{ x: number; y: number }>;
  /** Text only: font size in px. Resizing the box changes only the wrap width. */
  fontSize?: number;
  /** Image only: where the picture lives (an uploaded, hosted URL). */
  imageUrl?: string;
  /** Box/zone/image: border and fill dressing. Absent = the classic look. */
  style?: FactoryAnnotationStyle;
  /** The board (pocket) this ink lives in; absent = the root board. */
  pocketId?: string;
  /** The in-game planner's data for this thing; see GtnhPlannerData. */
  gtnhplanner?: GtnhPlannerData;
}

/**
 * A board (the type keeps its older name, "pocket"): a named container.
 * Members are ordinary project nodes/storages/annotations tagged with
 * `pocketId`; the graph the solver sees is flat, and boards only decide what
 * the canvas SHOWS. Boards nest through `parentPocketId` (absent = root).
 *
 * Open (`expanded`) it is a window frame whose members render inside it and
 * move with it; minimized it is a summary card. A plan with no `expanded`
 * flag loads its boards minimized.
 */
export interface FactoryPocket {
  id: string;
  name: string;
  colorTag?: FactoryNodeColorTag;
  /** Which board the collapsed card sits on; absent = the root board. */
  parentPocketId?: string;
  /**
   * Where the card — or, standing open, the window frame's top-left corner —
   * sits on that board.
   */
  position: {
    x: number;
    y: number;
  };
  /**
   * Standing open. While open, member positions are relative to the frame's
   * top-left corner; a legacy pocket's members (positions in their own
   * separate space, signalled by an absent `size`) are rebased to fit the
   * frame the first time it opens. Absent/false = minimized summary card.
   */
  expanded?: boolean;
  /** The window frame, whole cells; absent = fitted when it first opens. */
  size?: {
    width: number;
    height: number;
  };
  /**
   * The paper this board is drawn on: a canvas theme id (see
   * `canvas-themes.ts`), giving the floor its base colour, its grain and its
   * own grid ink. Absent = a paper derived from the board's id
   * (`paperForBoardId` in board-paper.ts).
   */
  theme?: string;
  /**
   * The ruling on that paper: a canvas pattern id ("dots", "lines",
   * "cross", "ruled", "graph", "none"). Absent = dots, the canvas default.
   */
  pattern?: string;
  /** The in-game planner's data for this group; see GtnhPlannerData. */
  gtnhplanner?: GtnhPlannerData;
}

export interface FactoryEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  resourceKind: ResourceKind;
  resourceId: ResourceId;
  label?: string;
  ratePerSecond?: number;
  /**
   * A loose cell wire from an older build: the edge's own resource is what
   * leaves the source (the filled CELL or the FLUID), its target handle names
   * the other form's input, and this is the Canner's litres per cell. Only
   * ever read on the way in: where a plan lands, each becomes a fluid tank
   * card between its two ends (`model/cell-wires.ts`). No wire crosses kinds.
   */
  crossForm?: {
    litresPerCell: number;
  };
  /**
   * User-pinned stops, in order: the wire must pass through each on its way
   * from source to target. Placed by double-clicking the wire, dragged to
   * steer it, removed by double-clicking the dot. Always on grid corners.
   */
  waypoints?: Array<{
    x: number;
    y: number;
  }>;
  /** The in-game planner's data for this thing; see GtnhPlannerData. */
  gtnhplanner?: GtnhPlannerData;
}

export interface FuelProfile {
  id: string;
  name: string;
  fuelFluidId: FluidId;
  euPerLiter?: number;
  euPerBucket?: number;
  isDemo?: boolean;
  notes?: string;
}

/**
 * How the author had the workspace set up when they shared a plan.
 *
 * View settings and resource marks are normally personal, kept in
 * localStorage outside the project (see `board-view.ts`). A shared setup
 * carries the author's arrangement in the plan, but it is only APPLIED when a
 * shared setup is opened; switching between your own designs never touches
 * your live settings. Every field is optional; absent leaves the viewer's own.
 */
export interface PlanViewState {
  canvasPattern?: string;
  canvasTheme?: string;
  rateUnit?: "tick" | "second" | "minute" | "hour" | "eu";
  leftPanelOpen?: boolean;
  rightPanelOpen?: boolean;
}

export interface FactoryProject {
  /** Construction progress; never changes production. */
  checklist?: { cards: string[]; edges: string[] };
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  /**
   * The game version family this plan is for ("2.9", "2.8.1"). Set when the
   * plan is made and never edited; absent reads as 2.9 (`planGameVersion`).
   */
  gameVersion?: string;
  id: string;
  name: string;
  /**
   * The face this plan wears: its blurb and its one-item icon, edited on the
   * board's plan card and used as the post's face when shared. Part of the
   * plan JSON, so they travel through export, import and sharing.
   */
  description?: string;
  icon?: EntryIcon;
  /** Only shared setups carry this; see PlanViewState. */
  view?: PlanViewState;
  /**
   * Plan mode's stored leftover splits: leftover key -> bearer key -> share
   * (0..1, summing to 1 per leftover). Unitless, so a split survives the plan
   * changing size.
   */
  spareShares?: Record<string, Record<string, number>>;
  /**
   * Plan mode's setting pins (the mod's `Graph.settingPins`): machine name -> the setting keys its cards show as
   * strip chips. A machine absent here shows its defaults (the coil on a heat recipe).
   */
  settingPins?: Record<string, string[]>;
  recipes: Recipe[];
  nodes: FactoryNode[];
  storages?: FactoryStorage[];
  annotations?: FactoryAnnotation[];
  pockets?: FactoryPocket[];
  edges: FactoryEdge[];
  fuelProfiles: FuelProfile[];
  selectedFuelProfileId?: string;
  notes?: string;
  /** The in-game planner's data for the whole plan; see GtnhPlannerData. */
  gtnhplanner?: GtnhPlannerData;
  /** Which view the plan opens on; absent = the board. A task board is a plan with "tasks". */
  primaryView?: PlanPrimaryView;
  /** The task board: tasks, their checklist lines and their comments. */
  tasks?: PlanTask[];
  taskItems?: PlanTaskItem[];
  taskComments?: PlanTaskComment[];
  metadata?: {
    isDemo?: boolean;
    source?: string;
    createdAt?: string;
    updatedAt?: string;
    /**
     * The community post this design went up as. Only the owner's design
     * carries it, and Share's Update in library updates that post. A copy of
     * someone else's post has none.
     */
    communityPlanId?: string;
  };
}

export interface ResourceFlow {
  key: ResourceKey;
  kind: ResourceKind;
  resourceId: ResourceId;
  displayName?: string;
  alternatives?: ResourceAlternative[];
  amountPerSecond: number;
}

export interface EdgeThroughput {
  edgeId: string;
  resource: ResourceFlow;
  demandPerSecond: number;
  transferredPerSecond: number;
  isLimited: boolean;
  /**
   * What the consumer would draw at 100% utilisation, before the solver scales
   * it down to match available supply. `demandPerSecond` converges to
   * `transferredPerSecond`, so this is the only value that still shows how much
   * the machine actually wants.
   */
  nameplateDemandPerSecond: number;
  /** What the producer could emit at 100% utilisation. */
  sourceCapacityPerSecond: number;
  /**
   * This line's share of what the consumer COULD be supplied (capability
   * allocation, ignoring demand throttles). Solver-internal: consumer
   * capability derives from this rather than from `transferredPerSecond`,
   * which is demand-scaled and would ratchet capability downward.
   */
  availablePerSecond?: number;
  /**
   * Which end is holding the flow back:
   * - `supply`  producer is maxed out and the consumer is starved
   * - `demand`  both ends have slack; the plan just doesn't need more
   * - `full`    consumer is getting everything it asked for
   */
  constraint: "supply" | "demand" | "full";
}

export interface NodeThroughputResult {
  nodeId: string;
  recipeId: string;
  recipeName: string;
  enabled: boolean;
  operationRatePerSecond: number;
  inputs: Record<ResourceKey, ResourceFlow>;
  outputs: Record<ResourceKey, ResourceFlow>;
  euT: number;
  requiredRatePerSecond: number;
  maxRatePerSecond: number;
  utilization: number;
  /**
   * The build cannot start: underpowered or over-tier hatches. Rates above
   * stay nameplate - the card keeps its shape - and the equilibrium pins the
   * node at 0%, exactly like a machine stopped by a bare slot.
   */
  powerStalled?: boolean;
  /**
   * The card (or section) holds a recipe that was not converted to the plan's version (`FactoryNode.unconverted`).
   * It is out of the solve (`status: "missing-recipe"`), and its wires are outside inputs and outputs of the plan.
   */
  unconverted?: true;
  /**
   * How hard this node COULD run given only its own input supply (1 when
   * nothing upstream limits it). Solver-internal: `utilization` is demand-
   * throttled, but supply allocation must offer consumers what a producer
   * could ramp up to if asked, or an initially low ask locks in forever.
   */
  capableUtilization?: number;
  /**
   * How hard this node WANTS to run from demand alone (targets and consumer
   * asks), before any input-supply clamp. Solver-internal: a consumer's ask
   * for an ingredient must not shrink just because that same ingredient is
   * currently short - allocation is capped by asks, so utilization could
   * ratchet down through any transient but never climb back up.
   */
  demandUtilization?: number;
  /**
   * How hard this node could run before a wired output it cannot get rid of
   * backs up on it (1 when nothing binds). Only a trash can, a DRAIN drawer
   * or a port with no wire on it can absorb a surplus nobody asked for; a
   * buffer passes on what its consumers pull and no more. A node whose speed
   * is set by this rather than by supply or demand is CLOGGED.
   */
  disposalUtilization?: number;
  /** The output whose surplus sets `disposalUtilization`, when one does. */
  clogOutputKey?: ResourceKey;
  theoreticalMachinesRequired: number;
  limitingResource?: ResourceFlow;
  /**
   * THE bottleneck, by the solver's own arithmetic: the connected input whose
   * supply ratio was the minimum taken when computing `capableUtilization`.
   * The UI must display this rather than re-derive a pick from per-edge
   * figures — the damped asks make those incomparable across inputs.
   */
  limitingInputKey?: ResourceKey;
  /**
   * Inputs whose supply ratio sits within the tie window of the minimum:
   * as far as the figures can tell they are the SAME wall, and raising any
   * one of them may just hand the limit to the next. Order-independent.
   */
  limitingInputTiedKeys?: ResourceKey[];
  status: "disabled" | "balanced" | "underutilized" | "bottleneck" | "missing-recipe";
  warnings: string[];
}

export interface StorageThroughputResult {
  storageId: string;
  kind: ResourceKind;
  resourceId: ResourceId;
  displayName?: string;
  storedAmount: number;
  capacity: number;
  producedPerSecond: number;
  consumedPerSecond: number;
  netPerSecond: number;
  status: "filling" | "draining" | "balanced" | "empty";
  /** Solve mode: the typed requirement this drawer carried into the solve. */
  targetPerSecond?: number;
  /** Solve mode: no chain can reach the typed amount at any machine scale. */
  targetUnreachable?: boolean;
}

export interface ResourceBalance {
  key: ResourceKey;
  kind: ResourceKind;
  resourceId: ResourceId;
  displayName?: string;
  producedPerSecond: number;
  consumedPerSecond: number;
  netPerSecond: number;
  surplusPerSecond: number;
  deficitPerSecond: number;
  /**
   * The BOUNDARY figures, read off the drawers rather than off the books. A
   * resource can carry several at once (imported at one drawer, spare at
   * another). They are never netted: that would claim a wire nobody drew.
   */
  importedPerSecond: number;
  productPerSecond: number;
  byproductPerSecond: number;
  /**
   * Spillover piling up in overflow BUFFERS: each buffer's inflow minus its
   * outflow, floored at zero, summed per resource. Surfaced as a positive
   * beside products and byproducts so a tank never quietly swallows it.
   * Sources and drains keep their own columns.
   */
  bufferFillPerSecond: number;
}

export interface BottleneckReport {
  id: string;
  kind: "resource-deficit" | "node-capacity" | "missing-recipe";
  severity: "warning" | "critical";
  message: string;
  nodeId?: string;
  resource?: ResourceFlow;
  requiredPerSecond?: number;
  capacityPerSecond?: number;
}

export interface FuelEstimate {
  fuelProfile: FuelProfile;
  totalEuPerSecond: number;
  fuelPerSecond: number;
  unit: "L/s" | "buckets/s";
}

export interface ThroughputResult {
  nodes: Record<string, NodeThroughputResult>;
  storages: Record<string, StorageThroughputResult>;
  resources: Record<ResourceKey, ResourceBalance>;
  edges: Record<string, EdgeThroughput>;
  totalEuT: number;
  totalEuPerSecond: number;
  fuelEstimate?: FuelEstimate;
  bottlenecks: BottleneckReport[];
  externalInputs: ResourceBalance[];
  unconsumedOutputs: ResourceBalance[];
  generatedAt: string;
  /**
   * These books do not describe the current plan yet: a big board's solve
   * runs off the main thread and the real result replaces them when it
   * lands. See `src/store/solve-books.ts`.
   */
  stale?: boolean;
  /** Plan mode only: forced flows, leftovers, unneeded and unanchored parts. */
  plan?: PlanSolveExtras;
}

