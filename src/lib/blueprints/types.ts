import type { BoardClipboardPayload } from "@/store/factory-store";
import type { EntryIcon, PlanResourceStat } from "@/lib/community/types";
import type { MachineTier } from "@/lib/model/types";

/** One line of a blueprint's stat card — same shape community plans use. */
export type BlueprintResourceStat = PlanResourceStat;

/** Stat lines kept per side; matches the community plan cap. */
export const BLUEPRINT_RESOURCE_STAT_LIMIT = 64;

export const BLUEPRINT_TAG_MAX_COUNT = 12;
export const BLUEPRINT_TAG_MAX_LENGTH = 24;

/**
 * One identity per tag: lowercase, single-spaced, no leading #, deduped,
 * capped. Capitalization is the only "similar spelling" folded together —
 * beyond that, a tag is exactly what its author typed.
 */
export function normalizeBlueprintTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const tag = entry
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, BLUEPRINT_TAG_MAX_LENGTH);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
    if (tags.length >= BLUEPRINT_TAG_MAX_COUNT) {
      break;
    }
  }
  return tags;
}

export const BLUEPRINT_NAME_MAX_LENGTH = 60;
/** A blueprint is a fragment, not a whole plan; half the community cap. */
export const BLUEPRINT_PAYLOAD_MAX_BYTES = 1_500_000;
/** The whole save body on the wire: the payload plus a name, tags, two stat lists and an icon. */
export const BLUEPRINT_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** Per user. Generous — the list UI stays honest well past this. */
export const BLUEPRINT_MAX_PER_USER = 200;

export interface BlueprintSummary {
  id: string;
  name: string;
  createdAt: string;
  nodeCount: number;
  storageCount: number;
  edgeCount: number;
  pocketCount: number;
  machineCount: number;
  /**
   * The row's publish flag and the public standing below (description,
   * author, votes, downloads) stay in the answer as the table keeps them;
   * nothing publishes, votes or downloads a blueprint now.
   */
  isPublic: boolean;
  description: string;
  authorName?: string;
  publishedAt?: string;
  upvotes: number;
  downvotes: number;
  score: number;
  downloads: number;
  /** This row belongs to the session user. */
  isMine?: boolean;
  /** The vote this browser has cast, if any. */
  myVote?: 1 | -1;
  /** The stat card: external needs and unconsumed outputs at save time. */
  needs: BlueprintResourceStat[];
  outputs: BlueprintResourceStat[];
  /** Author-curated tags, normalized lowercase. */
  tags: string[];
  /** The item face the author picked for list rows, if any. */
  icon?: EntryIcon;
  /** Top voltage tier inside, derived at save time like the stat card. */
  highestTier?: Exclude<MachineTier, "DEMO">;
  highestTierIndex?: number;
}

export interface BlueprintDetail extends BlueprintSummary {
  payload: BoardClipboardPayload;
}

export interface BlueprintListResponse {
  blueprints: BlueprintSummary[];
}

export type BlueprintSort = "newest" | "oldest" | "name" | "largest";
