/*
 * The first module the entry evaluates: it marks that the app's own code has begun, so the browser check can
 * tell a font the boot script stamped from one the app stamped later.
 */
declare global {
  interface Window {
    __gtnhEntryStarted?: boolean;
  }
}

window.__gtnhEntryStarted = true;

export {};
