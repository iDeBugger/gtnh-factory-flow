import { describe, expect, it } from "vitest";
import { BoundedLru } from "./bounded-lru";

describe("a size-bounded LRU", () => {
  it("evicts the oldest entries until the sizes fit the limit", () => {
    const cache = new BoundedLru<string, number>(10);
    cache.set("a", 1, 4);
    cache.set("b", 2, 4);
    cache.set("c", 3, 4);
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.totalSize).toBe(8);
    expect(cache.get("a")).toBeUndefined();
  });

  it("counts a read as a use, so the entry read last is evicted last", () => {
    const cache = new BoundedLru<string, number>(10);
    cache.set("a", 1, 4);
    cache.set("b", 2, 4);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3, 4);
    expect(cache.keys()).toEqual(["a", "c"]);
  });

  it("keeps an entry bigger than the whole limit, alone, until the next arrives", () => {
    const cache = new BoundedLru<string, number>(10);
    cache.set("a", 1, 4);
    cache.set("huge", 2, 25);
    expect(cache.keys()).toEqual(["huge"]);
    expect(cache.get("huge")).toBe(2);
    cache.set("b", 3, 1);
    expect(cache.keys()).toEqual(["b"]);
    expect(cache.totalSize).toBe(1);
  });

  it("replaces an entry set again, counting only its new size", () => {
    const cache = new BoundedLru<string, number>(10);
    cache.set("a", 1, 6);
    cache.set("b", 2, 2);
    cache.set("a", 3, 3);
    expect(cache.keys()).toEqual(["b", "a"]);
    expect(cache.totalSize).toBe(5);
    expect(cache.get("a")).toBe(3);
  });

  it("bounds the key count when every entry has the default size", () => {
    const cache = new BoundedLru<number, string>(3);
    for (let key = 0; key < 10; key += 1) {
      cache.set(key, `v${key}`);
    }
    expect(cache.count).toBe(3);
    expect(cache.keys()).toEqual([7, 8, 9]);
  });

  it("forgets everything on clear and on delete", () => {
    const cache = new BoundedLru<string, number>(10);
    cache.set("a", 1, 4);
    cache.set("b", 2, 4);
    cache.delete("a");
    expect(cache.totalSize).toBe(4);
    cache.clear();
    expect(cache.count).toBe(0);
    expect(cache.totalSize).toBe(0);
  });
});
