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
 * gets, so one connection cannot mint a fresh budget per address. An IPv4-mapped literal (a dual-stack socket's
 * view of an IPv4 peer) is keyed as that IPv4, and an address inside ::/64 (loopback) as itself.
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
      return ipv6Key(value);
    }
  }
  return NO_ADDRESS;
}

export function clientAddress(request: Request): string {
  return addressFromHeaders((name) => request.headers.get(name));
}

/** The limit key of an IPv6 literal: its /64, the IPv4 it maps, or itself inside ::/64. */
function ipv6Key(address: string): string {
  const groups = expandIpv6(address);
  const zero = (group: string) => group === "0";
  if (groups.slice(0, 5).every(zero) && groups[5] === "ffff") {
    const [high = "0", low = "0"] = groups.slice(6);
    return [Number.parseInt(high, 16), Number.parseInt(low, 16)]
      .flatMap((word) => [word >> 8, word & 0xff])
      .join(".");
  }
  if (groups.slice(0, 4).every(zero)) {
    return groups.join(":");
  }
  return `${groups.slice(0, 4).join(":")}::`;
}

/** The eight groups of an IPv6 literal, lowercase, no leading zeros, an embedded IPv4 as two groups. */
function expandIpv6(address: string): string[] {
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) {
            return [group.toLowerCase().replace(/^0+(?=.)/, "")];
          }
          const bytes = group.split(".").map((octet) => Number.parseInt(octet, 10));
          return [
            ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0),
            ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
          ].map((word) => word.toString(16));
        });
  const left = groups(head);
  const right = groups(tail);
  return address.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
}
