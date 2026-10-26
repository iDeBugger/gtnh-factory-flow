"use client";

import type { BoardClipboardPayload } from "@/store/factory-store";
import type { EntryIcon } from "@/lib/community/types";
import type {
  BlueprintDetail,
  BlueprintListResponse,
  BlueprintResourceStat,
  BlueprintSummary,
} from "./types";

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as
    | (T & { error?: string })
    | undefined;
  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }

  return body;
}

export async function listBlueprints(): Promise<BlueprintSummary[]> {
  const response = await fetch("/api/blueprints");
  const body = await parseJsonOrThrow<BlueprintListResponse>(response);
  return body.blueprints;
}

export async function saveBlueprint(
  name: string,
  payload: BoardClipboardPayload,
  io?: {
    needs: BlueprintResourceStat[];
    outputs: BlueprintResourceStat[];
    highestTier?: string;
    highestTierIndex?: number;
  },
  icon?: EntryIcon,
  tags?: string[],
): Promise<BlueprintSummary> {
  const response = await fetch("/api/blueprints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      payload,
      needs: io?.needs ?? [],
      outputs: io?.outputs ?? [],
      highestTier: io?.highestTier,
      highestTierIndex: io?.highestTierIndex,
      icon,
      tags,
    }),
  });
  const body = await parseJsonOrThrow<{ blueprint: BlueprintSummary }>(response);
  return body.blueprint;
}

export async function getBlueprint(blueprintId: string): Promise<BlueprintDetail> {
  const response = await fetch(`/api/blueprints/${encodeURIComponent(blueprintId)}`);
  const body = await parseJsonOrThrow<{ blueprint: BlueprintDetail }>(response);
  return body.blueprint;
}

/**
 * Edits a blueprint in place — rename, overwrite the payload from a board
 * pocket, or both. The id survives.
 */
export async function updateBlueprint(
  blueprintId: string,
  patch: {
    name?: string;
    payload?: BoardClipboardPayload;
    io?: {
      needs: BlueprintResourceStat[];
      outputs: BlueprintResourceStat[];
      highestTier?: string;
      highestTierIndex?: number;
    };
    tags?: string[];
    icon?: EntryIcon | null;
  },
): Promise<BlueprintSummary> {
  const response = await fetch(`/api/blueprints/${encodeURIComponent(blueprintId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: patch.name,
      payload: patch.payload,
      needs: patch.io?.needs,
      outputs: patch.io?.outputs,
      highestTier: patch.io?.highestTier,
      highestTierIndex: patch.io?.highestTierIndex,
      tags: patch.tags,
      icon: patch.icon,
    }),
  });
  const body = await parseJsonOrThrow<{ blueprint: BlueprintSummary }>(response);
  return body.blueprint;
}

export async function deleteBlueprint(blueprintId: string): Promise<void> {
  const response = await fetch(`/api/blueprints/${encodeURIComponent(blueprintId)}`, {
    method: "DELETE",
  });
  await parseJsonOrThrow<{ ok: boolean }>(response);
}
