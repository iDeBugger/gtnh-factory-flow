/**
 * How much one `resolve-recipes` call may carry, shared by the server's check
 * and the browser's chunking so the two never drift apart. A plan's refs are
 * 340 to 660 bytes each; 2,000 of them are about 1.3 MiB, under the body cap
 * with room for pretty printing, and no plan the site can hold (3 MiB whole)
 * carries more recipes than that.
 */
export const RESOLVE_RECIPES_MAX_REFS = 2000;

/** The body cap in bytes for one call. */
export const RESOLVE_RECIPES_MAX_BYTES = 2 * 1024 * 1024;

/** The browser sends refs this many at a time, in order, and joins the answers. */
export const RESOLVE_RECIPES_CHUNK_REFS = 500;
