/**
 * A least-recently-used cache bounded by the summed size of its entries.
 *
 * Each entry is set with a size (1 by default, which bounds the key count).
 * Reading an entry makes it the newest. Setting one evicts the oldest entries
 * until the total fits the limit again, but never the entry just set: a value
 * bigger than the whole limit is still kept, alone, until the next one arrives,
 * so the caller that loaded it is never made to load it twice.
 */
export class BoundedLru<K, V> {
  private readonly entries = new Map<K, { value: V; size: number }>();
  private total = 0;

  constructor(readonly limit: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, size = 1): void {
    this.delete(key);
    this.entries.set(key, { value, size });
    this.total += size;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.total <= this.limit || oldestKey === key) {
        break;
      }
      this.entries.delete(oldestKey);
      this.total -= oldest.size;
    }
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.total -= entry.size;
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  /** The summed size of what is held. */
  get totalSize(): number {
    return this.total;
  }

  get count(): number {
    return this.entries.size;
  }

  /** Oldest first. */
  keys(): K[] {
    return [...this.entries.keys()];
  }
}
