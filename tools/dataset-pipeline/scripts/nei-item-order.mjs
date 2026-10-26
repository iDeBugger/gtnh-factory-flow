/**
 * NEI's item list order, from the oracle's `neiItemList` (every stack NEI lists, sorted by the
 * pack's `inventory.itemsort`, one resource key per stack) to the dataset:
 *
 * - `neiItemOrder` (recipes.json, from the normalizer): each key once, at its first place. A
 *   resource NEI lists as several stacks (NBT variants: a charged and an empty battery, an
 *   item per enchantment) takes the smallest index.
 * - `resourceOrder` (recipes.json and resource-index.json.gz, from build-resource-index): one
 *   number per `resourceIndex` record, its place in `neiItemOrder`, or null for a resource NEI
 *   does not list (ore dictionary entries, fluids on 2.8.1, items only recipes name). A separate
 *   array, not a field per record: a field would change every byte of every `/resources`
 *   answer and grow the browser's items file. The search places the nulls after every ordered
 *   resource, in its own stable order (`src/lib/search/resource-search.ts`).
 *
 * An export without the list (older exports, a failed NEI boot) writes neither, and the search
 * sorts by its approximation.
 */

/** The dataset's `neiItemOrder` from an oracle export's `neiItemList`, or undefined without one. */
export function neiItemOrderFromExport(neiItemList) {
  if (neiItemList?.status !== "exported" || !Array.isArray(neiItemList.stacks)) {
    return undefined;
  }
  const seen = new Set();
  const order = [];
  for (const key of neiItemList.stacks) {
    if (typeof key !== "string" || key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    order.push(key);
  }
  return order.length > 0 ? order : undefined;
}

/** `resourceOrder` for a `resourceIndex`, or undefined when the dataset has no `neiItemOrder`. */
export function resourceOrderFor(resourceIndex, neiItemOrder) {
  if (!Array.isArray(neiItemOrder) || neiItemOrder.length === 0) {
    return undefined;
  }
  const place = new Map(neiItemOrder.map((key, index) => [key, index]));
  return resourceIndex.map((resource) => place.get(`${resource.kind}:${resource.id}`) ?? null);
}
