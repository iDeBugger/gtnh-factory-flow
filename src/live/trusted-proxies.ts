import { BlockList, isIP, isIPv4 } from "node:net";

/**
 * The peers the live service believes when they name a client's address
 * (`X-Client-Ip`, else `CF-Connecting-IP`). Loopback is always one of them:
 * a reverse proxy on the same host. `LIVE_TRUSTED_PROXIES` adds more, for a
 * proxy that reaches the service over a network (in Docker, the bridge
 * gateway docker-proxy dials from). Every other peer is its own address.
 */
export interface TrustedProxies {
  has(peer: string): boolean;
  describe(): string;
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function loopbackList(): BlockList {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  return list;
}

/**
 * An IPv4-mapped IPv6 peer (`::ffff:a.b.c.d`, how a dual-stack socket reports
 * an IPv4 client) is checked as its IPv4 address, so one list entry covers both.
 */
function contains(list: BlockList, peer: string): boolean {
  const mapped = MAPPED_V4.exec(peer);
  const address = mapped && isIPv4(mapped[1]) ? mapped[1] : peer;
  const family = isIP(address);
  if (family === 4) {
    return list.check(address, "ipv4");
  }
  if (family === 6) {
    return list.check(address, "ipv6");
  }
  return false;
}

/**
 * Reads a comma-separated list of IPv4 or IPv6 addresses and CIDR subnets.
 * Unset or blank trusts loopback only. An entry that is neither throws,
 * naming it: a typo must stop the service, not silently trust nobody.
 */
export function parseTrustedProxies(value: string | undefined): TrustedProxies {
  const list = loopbackList();
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (family === 0) {
      throw new Error(`LIVE_TRUSTED_PROXIES: "${entry}" is not an address or a subnet.`);
    }
    // A mapped entry would sit in the IPv6 list, where no peer is looked up
    // (mapped peers are checked as IPv4): refused rather than never matching.
    if (/^::ffff:/i.test(address)) {
      throw new Error(`LIVE_TRUSTED_PROXIES: "${entry}" is IPv4-mapped: write it as IPv4.`);
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (slash === -1) {
      list.addAddress(address, type);
      continue;
    }
    const prefixText = entry.slice(slash + 1);
    const prefix = Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText) || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`LIVE_TRUSTED_PROXIES: "${entry}" is not an address or a subnet.`);
    }
    list.addSubnet(address, prefix, type);
  }
  const description = ["loopback", ...entries].join(", ");
  return {
    has: (peer) => contains(list, peer),
    describe: () => description,
  };
}

/** Loopback only: the service's default when nothing is configured. */
export const LOOPBACK_ONLY: TrustedProxies = parseTrustedProxies(undefined);
