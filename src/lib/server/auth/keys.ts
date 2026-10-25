import { createHash } from "node:crypto";
import { clientAddress } from "../client-address";
import { sessionSecret } from "./session";
import { getSessionUser } from "./sessions";

/**
 * A salted hash, so keys never hold raw addresses or ids. The salt is the
 * session secret (one variable, one rule: a production server without it
 * refuses here too).
 */
export function saltedKey(text: string): string {
  return createHash("sha256").update(`${sessionSecret()}:${text}`).digest("hex").slice(0, 32);
}

/**
 * Anonymous identity for a rate limit: a salted hash of the client address
 * and nothing the client chooses. A device id in the key would let one
 * address start a fresh count with every made-up id (votes use
 * `makeVoterKey`). The trailing colon keeps the key the same bytes as before,
 * so no stored count moves.
 */
export function makeActorKey(request: Request): string {
  return saltedKey(`${clientAddress(request)}:`);
}

/**
 * Who a VOTE belongs to: the signed-in user, else the browser's device id
 * (a random UUID kept in localStorage).
 *
 * Not the actor key above: it folds the client IP in, and IPv6 privacy
 * addresses and carrier NAT change a browser's IP every few minutes, which
 * would let one person vote again.
 */
export async function makeVoterKey(request: Request, deviceId: string): Promise<string> {
  const user = await getSessionUser(request);
  return saltedKey(user ? `user:${user.id}` : `device:${deviceId}`);
}
