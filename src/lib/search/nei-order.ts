import type { DatasetResourceIndexEntry } from "@/lib/datasets/types";

/**
 * NEI's item list order, for the "As in NEI" sorts.
 *
 * The pipeline writes `resourceOrder` beside a dataset's `resourceIndex`: one number per
 * record, its place in the list NEI shows in the game (sorted by the pack's
 * `inventory.itemsort`), or null for a record NEI does not list
 * (`tools/dataset-pipeline/scripts/nei-item-order.mjs`). A dataset exported before the oracle
 * read NEI's list has none, and the order is approximated instead.
 */

/** A record's place in NEI's list, null where NEI does not list it. */
export type ResourceOrder = ReadonlyArray<number | null>;

/** The order when it fits the list it is for (one whole-number place or null per record), else undefined. */
export function usableResourceOrder(
  resourceIndex: readonly unknown[],
  order: unknown,
): ResourceOrder | undefined {
  if (!Array.isArray(order) || order.length !== resourceIndex.length) {
    return undefined;
  }
  for (const place of order) {
    if (place !== null && !Number.isInteger(place)) {
      return undefined;
    }
  }
  return order as ResourceOrder;
}

/**
 * Each record's rank (0 first) in NEI's order. Records NEI places come first, in its order;
 * every other record follows them in the approximation's order, and so does every record of a
 * dataset with no order. Ties fall to the record's index, so the ranks never change between
 * two runs over the same list.
 *
 * The approximation is NEI's default sort (minecraft, mod, id, default) from what a record
 * carries: vanilla items first, then items by the mod in their id, their registry name and
 * their meta (GT's meta items list in meta order, so their dusts, ingots and plates come out as
 * NEI shows them), then fluids, then aspects. Between items of one mod it is alphabetical where
 * NEI uses the numeric id, and it lower-cases mods NEI compares with their case.
 */
export function neiOrderRanks(
  resourceIndex: readonly DatasetResourceIndexEntry[],
  order?: ResourceOrder,
): Int32Array {
  const keys = resourceIndex.map(approximateNeiKey);
  const byRank = resourceIndex.map((_, index) => index);
  byRank.sort((left, right) => {
    const leftPlace = order?.[left] ?? null;
    const rightPlace = order?.[right] ?? null;
    if (leftPlace !== null || rightPlace !== null) {
      if (leftPlace === null) {
        return 1;
      }
      if (rightPlace === null) {
        return -1;
      }
      return leftPlace - rightPlace || left - right;
    }
    return compareApproximateNeiKeys(keys[left]!, keys[right]!) || left - right;
  });
  const ranks = new Int32Array(resourceIndex.length);
  byRank.forEach((index, rank) => {
    ranks[index] = rank;
  });
  return ranks;
}

interface ApproximateNeiKey {
  /** 0 vanilla item, 1 other item, 2 fluid, 3 aspect, 4 anything else. */
  group: number;
  mod: string;
  name: string;
  meta: number;
}

function approximateNeiKey(resource: DatasetResourceIndexEntry): ApproximateNeiKey {
  const id = resource.id ?? "";
  if (resource.kind === "fluid") {
    return { group: 2, mod: "", name: id, meta: 0 };
  }
  if (resource.kind === "aspect") {
    return { group: 3, mod: "", name: id, meta: 0 };
  }
  if (resource.kind !== "item") {
    return { group: 4, mod: "", name: id, meta: 0 };
  }
  const colon = id.indexOf(":");
  const at = id.lastIndexOf("@");
  const mod = colon > 0 ? id.slice(0, colon) : "";
  const name = id.slice(colon + 1, at > colon ? at : undefined);
  const meta = at > colon ? Number.parseInt(id.slice(at + 1), 10) : 0;
  return { group: mod === "minecraft" ? 0 : 1, mod, name, meta: Number.isFinite(meta) ? meta : 0 };
}

/** Code-unit order, as Java's String.compareTo: the same on every server and browser, unlike localeCompare. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareApproximateNeiKeys(left: ApproximateNeiKey, right: ApproximateNeiKey): number {
  return (
    left.group - right.group ||
    compareText(left.mod, right.mod) ||
    compareText(left.name, right.name) ||
    left.meta - right.meta
  );
}
