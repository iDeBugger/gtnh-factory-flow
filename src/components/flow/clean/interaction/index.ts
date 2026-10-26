import { installAcceptPaint } from "./accept";
import { installPromptSync } from "./prompt-sync";
import { ensureTipHost } from "./TipHost";

/**
 * Starts what the board's interactions need once, however many clean cards
 * mount: the one tooltip host with its 0.8 s wait, the wire-in-hand painter and
 * the shared phase of every pulse. Idempotent.
 */
export function ensureInteractionHost(): void {
  ensureTipHost();
  installAcceptPaint();
  installPromptSync();
}

export { useClickSlop } from "./click-slop";
export { tipAttrs, type TipSpec } from "./tip-spec";
export { setHandHeld } from "./rest-tracker";
