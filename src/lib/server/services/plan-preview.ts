import type { PlanResourceStat } from "@/lib/community/types";
import { isDatabaseConfigured } from "./config";
import type { PlanRow } from "../community-rows";
import * as plans from "../repos/plans";
import { getFileStore, isFileStoreConfigured, type FileBucket } from "../file-store";

/**
 * What a shared link is allowed to tell a stranger's chat window.
 *
 * A crawler carries no session, so only PUBLIC plans get a face: an unlisted
 * post must not leak its name, numbers or resources into an embed. Everything
 * here reads the summary row alone - never the plan JSON - because unfurling
 * a link must stay cheap enough to happen on every paste.
 */

/**
 * Where the share flow puts each post's board photograph (a file store
 * bucket), one object per plan named `<planId>.png`. Deliberately not a table column: the object
 * name is derived from the plan id, so an old row simply has no object.
 */
export const PLAN_PREVIEW_BUCKET: FileBucket = "plan-previews";

/**
 * The largest side a stored preview may claim. The client captures at most
 * 1600 by 1000, so the bound costs nothing legitimate, and it keeps a decode
 * of a stored picture at most 64 MiB with the 8-bit bound below.
 */
export const PLAN_PREVIEW_MAX_SIDE = 4096;

/**
 * The width and height a PNG's IHDR declares, or undefined when the bytes
 * are not a PNG whose first chunk is an IHDR with both sides in
 * 1..`PLAN_PREVIEW_MAX_SIDE` and at most 8 bits a channel. The signature and the chunk tag are checked
 * because the numbers at offsets 16 and 20 mean nothing otherwise.
 */
export function readPngHeader(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 33) {
    return undefined;
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => bytes[index] === byte)) {
    return undefined;
  }
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > PLAN_PREVIEW_MAX_SIDE || height > PLAN_PREVIEW_MAX_SIDE) {
    return undefined;
  }
  // At most 8 bits a channel (the browser's canvas never writes more): 16 would double the decode.
  if (bytes[24]! > 8) {
    return undefined;
  }
  return { width, height };
}

/** The plan's stored board photograph, or undefined when none was uploaded. */
export async function getPlanPreviewPng(planId: string): Promise<Buffer | undefined> {
  if (!isDatabaseConfigured() || !isFileStoreConfigured()) {
    return undefined;
  }
  try {
    return await getFileStore().get(PLAN_PREVIEW_BUCKET, `${planId}.png`);
  } catch {
    return undefined;
  }
}
export async function getPublicPlanRow(planId: string): Promise<PlanRow | undefined> {
  if (!planId || !isDatabaseConfigured()) {
    return undefined;
  }

  try {
    const row = await plans.readSummary(planId);
    if (!row || row.is_public === false) {
      return undefined;
    }
    return row;
  } catch {
    return undefined;
  }
}

function nameList(stats: PlanResourceStat[], limit = 3): string {
  const names = stats.map((stat) => stat.displayName ?? stat.resourceId);
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * Player text made safe for one line of a markdown link list: whitespace
 * collapses to one space (an item cannot span lines) and the characters that
 * open or close a link, an autolink or code are backslash-escaped, so a plan
 * name cannot end its own link text and carry a link of its own.
 */
export function quietMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\[\]()<>`]/g, (character) => `\\${character}`);
}

/**
 * The embed's one paragraph: the author's own words when they wrote any,
 * otherwise the plan's numbers as a sentence.
 */
export function describePlanRow(row: PlanRow): string {
  const description = row.description?.trim();
  if (description) {
    return description.length > 200 ? `${description.slice(0, 199).trimEnd()}...` : description;
  }

  const parts: string[] = [
    `${row.machine_count} machines${row.highest_tier ? ` up to ${row.highest_tier}` : ""}${
      row.author_name ? `, by ${row.author_name}` : ""
    }.`,
  ];
  if (row.needs?.length) {
    parts.push(`Needs ${nameList(row.needs)}.`);
  }
  if (row.outputs?.length) {
    parts.push(`Makes ${nameList(row.outputs)}.`);
  }
  if (row.game_version) {
    parts.push(`GTNH ${row.game_version}.`);
  }
  return parts.join(" ");
}
