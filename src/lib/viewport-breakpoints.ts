/**
 * The layout breakpoints. Kept in a module that imports nothing, so the boot script (src/client/boot.ts) can inline
 * them into the page; compact-view.ts re-exports them and owns the media queries.
 */

/**
 * A window under this many REAL px wide is a phone (or a small tablet): compact whatever the interface size, and it
 * gets the phone's smaller base size (ui-scale-boot.ts). The interface size can lower this, never raise it: a bigger
 * size must not turn a desktop window into a phone.
 */
export const PHONE_MAX_WIDTH = 900;

/** A window shorter than this many REAL px is a phone on its side, whatever its width. */
export const PHONE_MAX_HEIGHT = 560;

/**
 * Under this many SHELL px (real px over the interface size) the two side columns and a usable board no longer fit:
 * compact whatever the window. Large (1.52) on a 1280 x 720 window leaves 841 x 473, the least a desktop window gets.
 */
export const COMPACT_MAX_WIDTH = 800;
export const COMPACT_MAX_HEIGHT = 440;

/** Under this width (shell px) the top bar's labelled buttons drop to their icons. */
export const SNUG_MAX_WIDTH = 1280;
