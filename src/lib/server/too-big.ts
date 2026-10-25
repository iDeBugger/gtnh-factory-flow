/**
 * The 413 sentences of the routes whose players read them, in one place: the
 * route says one past its own cap, and `src/proxy.ts` says the same one for a
 * declared length over every cap, which it refuses before any route runs.
 */
export const FEEDBACK_TOO_BIG = "The report is too big. Send fewer plans.";
export const IMAGE_TOO_BIG = "That image is too big: the limit is 4 MB.";
export const PREVIEW_TOO_BIG = "That preview is too big: the limit is 4 MB.";
export const PLAN_UPLOAD_TOO_BIG = "Upload too large.";
export const DESIGN_TOO_BIG = "This design is too large to sync.";
export const BLUEPRINT_TOO_BIG = "Blueprint is too large to save.";
