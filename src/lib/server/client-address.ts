import { isIP } from "node:net";

/**
 * The address a request came from, as every per-address rule on the site reads it.
 *
 * The site sits behind Cloudflare and then Caddy, and only Caddy may reach it (the unit binds loopback and the
 * firewall closes the port; that is what makes the first header trustworthy). Caddy puts the client's address in
 * `X-Client-Ip`, replacing anything the client sent (its `client_ip` is Cloudflare's CF-Connecting-IP, trusted only
 * from Cloudflare's ranges). Without it, `CF-Connecting-IP`, which Cloudflare sets itself and a client cannot change
 * through Cloudflare. Nothing else is read: `X-Forwarded-For` names the Cloudflare edge, or the client's own chain
 * when Cloudflare is bypassed, and nothing in front of the site sets `X-Real-Ip`, so either would only widen what a
 * client can forge. A value that is not an IP literal is skipped.
 *
 * The address is a key for limits, not a record: an IPv6 literal is keyed on its /64, the block a home connection
 * gets, so one connection cannot mint a fresh budget per address.
 */

/** What a request with no trusted address is keyed on. */
export const NO_ADDRESS = "local";

const TRUSTED_ADDRESS_HEADERS = ["x-client-ip", "cf-connecting-ip"] as const;

export function addressFromHeaders(header: (name: string) => string | null | undefined): string {
  for (const name of TRUSTED_ADDRESS_HEADERS) {
    const value = header(name)?.split(",")[0]?.trim();
    if (!value) {
      continue;
    }
    const family = isIP(value);
    if (family === 4) {
      return value;
    }
    if (family === 6) {
      return ipv6Block(value);
    }
  }
  return NO_ADDRESS;
}

export function clientAddress(request: Request): string {
  return addressFromHeaders((name) => request.headers.get(name));
}

/** The /64 of an IPv6 literal: its first four groups, normalized, and "::". */
function ipv6Block(address: string): string {
  const [head = "", tail = ""] = address.split("::");
  // An embedded IPv4 ("::ffff:203.0.113.9") takes the last two groups; only
  // the count matters here, the first four groups never hold it.
  const groups = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group]));
  const left = groups(head);
  const right = groups(tail);
  const expanded = address.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${expanded
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::`;
}
