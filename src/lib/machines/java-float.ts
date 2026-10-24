/**
 * Java float arithmetic. A Java `float` literal or operation rounds to 32 bits
 * at each step, and the machine numbers the game shows come from those rounded
 * values, so a 2.8.1 coefficient the Java computes in float is reproduced with
 * `f32` at every float operation. A literal the Java passes as a double stays
 * a double.
 */
export const f32 = Math.fround;

/** Java's float `a * b`: both operands and the product rounded to 32 bits. */
export function fmul(a: number, b: number): number {
  return f32(f32(a) * f32(b));
}

/** Java's float `a / b`: both operands and the quotient rounded to 32 bits. */
export function fdiv(a: number, b: number): number {
  return f32(f32(a) / f32(b));
}

/**
 * The table's `speed` for a float the Java passes to `setSpeedBonus`. The
 * table's duration multiplier is `1 / speed`, which gives back exactly
 * `bonus` for the bonuses the machines use (1/1.5, 1/2.2, 1/2.25, 1/2.5,
 * 1/2.8, 1/3, 1/3.5, 1/5, 1/6), so the duration reads the Java's float.
 * Not every float has such a speed (0.95F, 2F / 11F): a coefficient
 * computed from a formula states the table's `durationMultiplier` instead.
 */
export function speedFromBonus(bonus: number): number {
  return 1 / bonus;
}

/** Java's `1F / xF`: the float reciprocal of a float literal. */
export function floatBonus(divisor: number): number {
  return f32(1 / f32(divisor));
}

/**
 * GTUtility.powInt: `base` to a whole power by repeated squaring, in double.
 * It is not Math.pow: 0.9^4 by squaring is 0.6561000000000001, Math.pow gives
 * 0.6561. A coefficient the game builds with powInt uses this, so a ceil or a
 * float cast after it sees the game's last bit. GT5U@5.09.54.205
 * gregtech/api/util/GTUtility.java:3504; GT5U@5.09.51.476 :4721.
 */
export function powInt(base: number, exp: number): number {
  if (exp < 0) return 1 / powInt(base, -exp);
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result *= b;
    b *= b;
    e >>= 1;
  }
  return result;
}

/**
 * Where a Java momentum ramp stops: `x += step` while `x < limit`, from
 * `start`, in float when `float` is set. The game checks before it adds, so a
 * double ramp of 0.025 from 1 to 3 ends at 3.025 (80 steps leave
 * 2.9999999999999933, under 3), and the float ramp ends at 3.0000029.
 */
export function rampCeiling(start: number, step: number, limit: number, float: boolean): number {
  const round = float ? f32 : (x: number) => x;
  let x = round(start);
  const s = round(step);
  while (x < limit) x = round(x + s);
  return x;
}
