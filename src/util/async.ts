/** Small TTL-bounded LRU (insertion-order Map). Values are kept in memory only. */
export class LruCache<V> {
  private map = new Map<string, { value: V; at: number }>();
  constructor(
    private max: number,
    private ttlMs: number,
  ) {}

  get(key: string): { value: V; ageMs: number } | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    const ageMs = Date.now() - hit.at;
    if (ageMs > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return { value: hit.value, ageMs };
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Counting semaphore with a bounded wait queue (backpressure instead of unbounded memory). */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(
    private limit: number,
    private maxQueue = 200,
  ) {}

  get stats() {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue) throw Object.assign(new Error("OVERLOADED: analysis queue full"), { code: "OVERLOADED" });
      await new Promise<void>((r) => this.queue.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Run `fn` over items with at most `n` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
