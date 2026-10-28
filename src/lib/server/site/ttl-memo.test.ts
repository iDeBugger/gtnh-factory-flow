import { describe, expect, it } from "vitest";
import { ttlMemo } from "./ttl-memo";

const HOUR = 3_600_000;

/** A load whose answers the test releases one at a time. */
function controlledLoad() {
  const calls: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const load = () =>
    new Promise<string>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, load };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ttlMemo", () => {
  it("loads once per hour, and serves the old value while a reload runs", async () => {
    let clock = 0;
    const { calls, load } = controlledLoad();
    const memo = ttlMemo(HOUR, load, () => clock);

    const first = memo();
    const second = memo();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve("one");
    expect(await first).toBe("one");
    expect(await second).toBe("one");

    clock = HOUR - 1;
    expect(await memo()).toBe("one");
    expect(calls).toHaveLength(1);

    clock = HOUR;
    expect(await memo()).toBe("one");
    expect(await memo()).toBe("one");
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("two");
    await flush();
    expect(await memo()).toBe("two");
    expect(calls).toHaveLength(2);

    clock = 2 * HOUR - 1;
    expect(await memo()).toBe("two");
    expect(calls).toHaveLength(2);
    clock = 2 * HOUR;
    await memo();
    expect(calls).toHaveLength(3);
  });

  it("keeps the old value when a reload throws, and tries again on the next call", async () => {
    let clock = 0;
    const { calls, load } = controlledLoad();
    const memo = ttlMemo(HOUR, load, () => clock);
    const first = memo();
    calls[0]!.resolve("one");
    await first;

    clock = HOUR;
    expect(await memo()).toBe("one");
    calls[1]!.reject(new Error("database down"));
    await flush();
    expect(await memo()).toBe("one");
    expect(calls).toHaveLength(3);
    calls[2]!.resolve("two");
    await flush();
    expect(await memo()).toBe("two");
  });

  it("rejects a first load that throws, and loads again on the next call", async () => {
    const { calls, load } = controlledLoad();
    const memo = ttlMemo(HOUR, load, () => 0);
    const first = memo();
    calls[0]!.reject(new Error("database down"));
    await expect(first).rejects.toThrow("database down");
    const second = memo();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("one");
    expect(await second).toBe("one");
  });

  it("rejects a load that throws before it returns a promise", async () => {
    let fail = true;
    let at = 0;
    // Not async: the throw happens in the call itself, before any promise exists.
    const load = (): Promise<string> => {
      if (fail) throw new Error("sync");
      return Promise.resolve("ok");
    };
    const memo = ttlMemo(HOUR, load, () => at);
    await expect(memo()).rejects.toThrow("sync");
    fail = false;
    expect(await memo()).toBe("ok");
    // A reload past the TTL that throws the same way keeps the old value.
    fail = true;
    at = HOUR;
    expect(await memo()).toBe("ok");
    expect(await memo()).toBe("ok");
  });
});
