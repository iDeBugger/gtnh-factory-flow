/**
 * Text written into HTML the way React writes it: `&`, `<`, `>`, `"` and `'`
 * become entities, and nothing else changes (a newline stays a newline). Next
 * renders the page head through React, so a head built here with the same
 * escaping is the same bytes, and player text (a plan's name or description)
 * can never close a tag or an attribute.
 */
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

const SPECIAL = /[&<>"']/g;

/** Text between tags, such as a `<title>`. */
export function escapeHtml(text: string): string {
  return text.replace(SPECIAL, (character) => ENTITIES[character] ?? character);
}

/** A double-quoted attribute value. React escapes the same five characters there. */
export function escapeAttribute(text: string): string {
  return escapeHtml(text);
}
