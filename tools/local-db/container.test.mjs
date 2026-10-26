import { describe, expect, it } from "vitest";
import { containerMismatch } from "./container.mjs";

const want = { image: "postgres:17.10-bookworm@sha256:abc", port: 54330, name: "gtnh-local-db" };
const bindings = (hostIp, hostPort) => ({ "5432/tcp": [{ HostIp: hostIp, HostPort: hostPort }] });

describe("the local Postgres container check", () => {
  it("accepts the pinned image published on loopback at the port", () => {
    expect(
      containerMismatch({ image: want.image, portBindings: bindings("127.0.0.1", "54330") }, want),
    ).toBeUndefined();
  });

  it("names an image other than the compose pin", () => {
    expect(
      containerMismatch(
        { image: "postgres:16-bookworm", portBindings: bindings("127.0.0.1", "54330") },
        want,
      ),
    ).toMatch(
      /runs postgres:16-bookworm, not postgres:17\.10-bookworm@sha256:abc.*docker rm -f gtnh-local-db/,
    );
  });

  it("names a binding off loopback or on another port", () => {
    for (const portBindings of [
      bindings("0.0.0.0", "54330"),
      bindings("", "54330"),
      bindings("127.0.0.1", "54331"),
      {},
      {
        "5432/tcp": [
          { HostIp: "127.0.0.1", HostPort: "54330" },
          { HostIp: "::", HostPort: "54330" },
        ],
      },
    ]) {
      expect(containerMismatch({ image: want.image, portBindings }, want)).toMatch(
        /publishes .* not only 127\.0\.0\.1:54330/,
      );
    }
  });
});
