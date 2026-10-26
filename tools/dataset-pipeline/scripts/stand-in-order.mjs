/**
 * The rules that pick one stack, member or drop where the game has several for one thing, so a
 * rebuild or a second export of the same pack never changes an icon, a name or an order. The
 * export walks the game's hash maps, so the order stacks arrive in is no rule at all.
 */

/** A normalized resource's NBT, from the `NBT: ...` line the normalizer writes, or undefined. */
export function nbtOf(resource) {
  const line = (resource?.tooltip ?? []).find((entry) => typeof entry === "string" && entry.startsWith("NBT: "));
  return line === undefined ? undefined : line.slice(5);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Which of two stacks of one id stands for it: the one with no NBT, else the smaller NBT; then
 * the smaller name and icon, so even a name the game rolls settles the same way.
 */
export function compareStandIns(left, right) {
  const leftNbt = nbtOf(left);
  const rightNbt = nbtOf(right);
  if ((leftNbt === undefined) !== (rightNbt === undefined)) {
    return leftNbt === undefined ? -1 : 1;
  }
  return (
    compareText(leftNbt ?? "", rightNbt ?? "") ||
    compareText(String(left?.displayName ?? ""), String(right?.displayName ?? "")) ||
    compareText(String(left?.iconPath ?? ""), String(right?.iconPath ?? ""))
  );
}

/**
 * An ore dictionary tag's members in the order a slot shows them: GregTech's unification target
 * for the tag first (the stack GregTech turns every member into), then NEI's order, then id.
 * Repeats keep their first copy.
 */
export function orderOreMembers(members, { target, neiPlace } = {}) {
  const place = (member) => neiPlace?.get(`${member.kind}:${member.id}`) ?? Number.MAX_SAFE_INTEGER;
  const seen = new Set();
  return [...members]
    .sort(
      (left, right) =>
        (right.id === target) - (left.id === target) ||
        place(left) - place(right) ||
        compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`) ||
        compareStandIns(left, right),
    )
    .filter((member) => {
      if (seen.has(member.id)) return false;
      seen.add(member.id);
      return true;
    });
}

/** A crop's drop table, heaviest weight first, then by id. */
export function orderCropDrops(drops) {
  return [...drops].sort(
    (left, right) =>
      (right.weight ?? 0) - (left.weight ?? 0) ||
      compareText(`${left.resource?.kind}:${left.resource?.id}`, `${right.resource?.kind}:${right.resource?.id}`),
  );
}
