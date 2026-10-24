import { describe, expect, it } from "vitest";
import { addressFromHeaders, clientAddress, NO_ADDRESS } from "./client-address";

function headers(values: Record<string, string>) {
  const map = new Headers(values);
  return (name: string) => map.get(name);
}

describe("the client address", () => {
  it("takes Caddy's X-Client-Ip before Cloudflare's CF-Connecting-IP", () => {
    expect(
      addressFromHeaders(
        headers({ "x-client-ip": "203.0.113.9", "cf-connecting-ip": "198.51.100.7" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("takes CF-Connecting-IP when X-Client-Ip is missing", () => {
    expect(addressFromHeaders(headers({ "cf-connecting-ip": "198.51.100.7" }))).toBe(
      "198.51.100.7",
    );
  });

  it("reads neither X-Forwarded-For nor X-Real-Ip", () => {
    expect(
      addressFromHeaders(
        headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "203.0.113.9" }),
      ),
    ).toBe(NO_ADDRESS);
    expect(addressFromHeaders(() => null)).toBe("local");
  });

  it("takes the first of a comma list and refuses what is not an address", () => {
    expect(
      addressFromHeaders(
        headers({ "x-client-ip": "not-an-ip", "cf-connecting-ip": "198.51.100.7" }),
      ),
    ).toBe("198.51.100.7");
    expect(addressFromHeaders(headers({ "x-client-ip": "2001:db8::1, 10.0.0.1" }))).toBe(
      "2001:db8:0:0::",
    );
    expect(addressFromHeaders(headers({ "x-client-ip": " " }))).toBe(NO_ADDRESS);
  });

  it("keys an IPv6 address on its /64, the block one connection gets", () => {
    expect(addressFromHeaders(headers({ "x-client-ip": "2001:db8:abcd:1234:5678::1" }))).toBe(
      "2001:db8:abcd:1234::",
    );
    expect(
      addressFromHeaders(headers({ "x-client-ip": "2001:db8:abcd:1234:ffff:ffff:ffff:ffff" })),
    ).toBe("2001:db8:abcd:1234::");
    expect(
      addressFromHeaders(headers({ "x-client-ip": "2001:0DB8:0000:0000:0000:0000:0000:0001" })),
    ).toBe("2001:db8:0:0::");
    expect(addressFromHeaders(headers({ "x-client-ip": "2001:db8::1" }))).toBe("2001:db8:0:0::");
    expect(addressFromHeaders(headers({ "x-client-ip": "::1" }))).toBe("0:0:0:0::");
    expect(addressFromHeaders(headers({ "x-client-ip": "::ffff:203.0.113.9" }))).toBe("0:0:0:0::");
    expect(addressFromHeaders(headers({ "x-client-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("reads a Request the same way", () => {
    expect(
      clientAddress(
        new Request("http://localhost/", { headers: { "x-client-ip": "203.0.113.9" } }),
      ),
    ).toBe("203.0.113.9");
    expect(clientAddress(new Request("http://localhost/"))).toBe(NO_ADDRESS);
  });
});
