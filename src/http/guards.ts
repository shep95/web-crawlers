import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * API keys come from the API_KEYS env var (comma separated). Entries may be raw
 * keys or `sha256:<hex>` digests so plaintext keys need not live in config.
 */
export class ApiKeys {
  private digests: Buffer[];
  constructor(spec = process.env.API_KEYS ?? "") {
    this.digests = spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((k) => (k.startsWith("sha256:") ? Buffer.from(k.slice(7), "hex") : createHash("sha256").update(k).digest()));
  }
  get enabled(): boolean {
    return this.digests.length > 0;
  }
  verify(token: string | undefined): boolean {
    if (!token) return false;
    const d = createHash("sha256").update(token).digest();
    return this.digests.some((k) => k.length === d.length && timingSafeEqual(k, d));
  }
  static tokenFrom(req: FastifyRequest): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
    const k = req.headers["x-api-key"];
    return typeof k === "string" ? k : undefined;
  }
}

/**
 * Per-client sliding-window counter (two fixed buckets, weighted): O(1) time
 * and memory per client regardless of request rate. Approximates a true
 * sliding log to within one bucket's error, which is the standard trade-off.
 */
export class ClientRateLimiter {
  private buckets = new Map<string, { start: number; cur: number; prev: number }>();
  private timer: NodeJS.Timeout;
  constructor(
    private perMinute: number,
    private windowMs = 60_000,
  ) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }
  check(client: string): { ok: boolean; retryAfterS: number; remaining: number } {
    const now = Date.now();
    const windowStart = now - (now % this.windowMs);
    let b = this.buckets.get(client);
    if (!b) this.buckets.set(client, (b = { start: windowStart, cur: 0, prev: 0 }));
    if (b.start !== windowStart) {
      b.prev = b.start === windowStart - this.windowMs ? b.cur : 0;
      b.cur = 0;
      b.start = windowStart;
    }
    const weight = 1 - (now - windowStart) / this.windowMs;
    const estimate = b.prev * weight + b.cur;
    if (estimate >= this.perMinute) return { ok: false, retryAfterS: Math.max(1, Math.ceil((windowStart + this.windowMs - now) / 1000)), remaining: 0 };
    b.cur++;
    return { ok: true, retryAfterS: 0, remaining: Math.max(0, Math.floor(this.perMinute - estimate - 1)) };
  }
  private sweep() {
    const cutoff = Date.now() - 2 * this.windowMs;
    for (const [k, v] of this.buckets) if (v.start < cutoff) this.buckets.delete(k);
    if (this.buckets.size > 200_000) this.buckets.clear();
  }
  stop() {
    clearInterval(this.timer);
  }
}

/** Ring-buffer latency recorder per route for p50/p95/p99 (Phase 8 baselines). */
export class LatencyStats {
  private data = new Map<string, { samples: number[]; i: number; count: number; errors: number }>();
  record(route: string, ms: number, error: boolean) {
    let s = this.data.get(route);
    if (!s) this.data.set(route, (s = { samples: [], i: 0, count: 0, errors: 0 }));
    if (s.samples.length < 1000) s.samples.push(ms);
    else s.samples[s.i++ % 1000] = ms;
    s.count++;
    if (error) s.errors++;
  }
  snapshot() {
    const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
    return Object.fromEntries(
      [...this.data.entries()].map(([route, s]) => {
        const sorted = [...s.samples].sort((a, b) => a - b);
        return [route, { count: s.count, errors: s.errors, p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1] ?? null }];
      }),
    );
  }
}

/** Server-Sent Events writer with heartbeats and client-disconnect cancellation. */
export interface SseChannel {
  signal: AbortSignal;
  send(event: string, data: unknown): void;
  end(): void;
  readonly closed: boolean;
}

export function openSse(req: FastifyRequest, reply: FastifyReply, corsOrigin: string | null): SseChannel {
  const controller = new AbortController();
  reply.hijack();
  const headers: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  if (corsOrigin) headers["access-control-allow-origin"] = corsOrigin;
  reply.raw.writeHead(200, headers);
  const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
  };
  req.raw.on("close", close);
  return {
    signal: controller.signal,
    send(event: string, data: unknown) {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!closed) {
        reply.raw.end();
        close();
      }
    },
    get closed() {
      return closed;
    },
  };
}
