/**
 * Escapes LIKE's wildcards (`%`, `_`) and its escape character (backslash,
 * Postgres's default), so a pattern built around the text matches the typed
 * characters only. The result is still a bound parameter, never SQL text.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}
