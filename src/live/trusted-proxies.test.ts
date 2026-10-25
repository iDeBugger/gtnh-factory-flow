import { describe, expect, it } from "vitest";
import { parseTrustedProxies } from "./trusted-proxies";

describe("trusted proxies", () => {
  it("trusts loopback with no list", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(trusted.has("127.0.0.1")).toBe(true);
    expect(trusted.has("::1")).toBe(true);
    expect(trusted.has("::ffff:127.0.0.1")).toBe(true);
    expect(trusted.has("172.30.61.1")).toBe(false);
    expect(parseTrustedProxies("").has("172.30.61.1")).toBe(false);
    expect(trusted.describe()).toBe("loopback");
  });

  it("trusts an address and a subnet from the list", () => {
    const trusted = parseTrustedProxies("172.30.61.1, 10.90.60.0/24");
    expect(trusted.has("172.30.61.1")).toBe(true);
    expect(trusted.has("::ffff:172.30.61.1")).toBe(true);
    expect(trusted.has("172.30.61.2")).toBe(false);
    expect(trusted.has("10.90.60.77")).toBe(true);
    expect(trusted.has("10.90.61.1")).toBe(false);
    expect(trusted.has("127.0.0.1")).toBe(true);
    expect(trusted.has("unknown")).toBe(false);
    expect(trusted.describe()).toBe("loopback, 172.30.61.1, 10.90.60.0/24");
  });

  it("refuses an entry that is not an address or a subnet", () => {
    expect(() => parseTrustedProxies("172.30.61.1,nonsense")).toThrow(/nonsense/);
    expect(() => parseTrustedProxies("10.0.0.0/33")).toThrow(/10\.0\.0\.0\/33/);
    expect(() => parseTrustedProxies("10.0.0.0/")).toThrow(/10\.0\.0\.0\//);
  });
});
