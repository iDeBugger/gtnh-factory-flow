/**
 * A machine's worked formulas, as data: every number on its card derived in front of the player with their own
 * settings plugged in (the crop card's Formulas strip, generalised). Each line is a label, the working, and the
 * answer; a term that is a setting's value names that setting, so the card can paint it in the setting's colour.
 * The in-game mod renders the same lines in its gear sheet.
 */
export type FormulaTerm =
  | string
  /** A number that comes from a setting (painted in that setting's colour). */
  | { text: string; knob: string }
  /** A superscript, optionally a setting's number. */
  | { sup: string; knob?: string };

export interface FormulaLine {
  label: string;
  math: FormulaTerm[];
  result: string;
  /** Green when a requirement is met, red when it is not; plain otherwise. */
  tone?: "good" | "bad";
}

export function knob(text: string | number, id: string): FormulaTerm {
  return { text: String(text), knob: id };
}

/** Plain text of a line's working, for tests, tooltips and the mod. */
export function formulaText(terms: FormulaTerm[]): string {
  return terms
    .map((term) => (typeof term === "string" ? term : "sup" in term ? `^${term.sup}` : term.text))
    .join("");
}

/**
 * A number as the formulas show it: whole numbers grouped, fractions to three significant places, or to
 * `fractionDigits` decimals where a line needs a fixed precision (a draw that sits just past an overclock
 * boundary must not round onto it).
 */
export function formulaNumber(value: number, fractionDigits?: number): string {
  if (!Number.isFinite(value)) return "-";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  const abs = Math.abs(value);
  const digits = fractionDigits ?? (abs >= 100 ? 1 : abs >= 1 ? 2 : 3);
  return Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
}
