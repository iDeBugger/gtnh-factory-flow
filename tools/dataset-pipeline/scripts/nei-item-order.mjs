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

/**
 * NEI's default `inventory.itemsort`, which both packs ship. A mod's own sort options come after it,
 * so only this start is checked: `default` (each item's own sub-item order) settles every tie
 * before them.
 */
export const NEI_DEFAULT_SORT = [
  "nei.itemsort.minecraft",
  "nei.itemsort.mod",
  "nei.itemsort.id",
  "nei.itemsort.default",
  "nei.itemsort.damage",
  "nei.itemsort.name",
];

/**
 * Why an exported list cannot stand for the pack's NEI order, or undefined when it can. An
 * instance whose sort was changed in game exports that sort, not the one players see.
 */
export function neiSortProblem(neiItemList) {
  const sort = String(neiItemList?.sort ?? "").split(",").map((rule) => rule.trim());
  return NEI_DEFAULT_SORT.every((rule, index) => sort[index] === rule)
    ? undefined
    : `NEI item list sorted by "${neiItemList?.sort ?? ""}", not NEI's default (${NEI_DEFAULT_SORT.join(",")}): the export instance's config/NEI/client.cfg has another inventory.itemsort.`;
}

/**
 * The dataset's `neiItemOrder` from an oracle export's `neiItemList`, or undefined without one or
 * when it was not sorted by NEI's default (`neiSortProblem`, which the normalizer prints).
 */
export function neiItemOrderFromExport(neiItemList) {
  if (neiItemList?.status !== "exported" || !Array.isArray(neiItemList.stacks)) {
    return undefined;
  }
  if (neiSortProblem(neiItemList)) {
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

/**
 * A built dataset's NEI order as `neiItemOrder` again, from its resource-index.json.gz
 * (`resourceIndex` with `resourceOrder`), or undefined when it has none. A rebuild whose export
 * has no list (the split export skips the client phase when the assets are unchanged, and only
 * the client reads NEI's list) carries the order on from here, as it carries icons.
 */
export function neiItemOrderFromCatalog(catalog) {
  const records = catalog?.resourceIndex;
  const order = catalog?.resourceOrder;
  if (!Array.isArray(records) || !Array.isArray(order) || order.length !== records.length) {
    return undefined;
  }
  const placed = [];
  records.forEach((record, index) => {
    if (Number.isInteger(order[index])) {
      placed.push([order[index], `${record.kind}:${record.id}`]);
    }
  });
  placed.sort((left, right) => left[0] - right[0]);
  return placed.length > 0 ? placed.map(([, key]) => key) : undefined;
}
