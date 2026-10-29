import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "undici";
import { AutonomousCrawler } from "../src/corpus/crawler.js";
import type { DiscoverySource } from "../src/corpus/bootstrap.js";
import type { Corpus, CrawlerProfile } from "../src/corpus/types.js";
import type { SafeResponse } from "../src/net/safe-fetch.js";
import { backends } from "./helpers/backends.js";
import * as F from "./fixtures/build.js";

// 8 distinct hosts (127.0.0.2–9 all reach the loopback server) × 12 pages, plus files.
const HOSTS = Array.from({ length: 8 }, (_, i) => `127.0.0.${i + 2}`);
let server: Server;
let port = 0;
const hits = new Map<string, number>();
const inFlight = new Map<string, number>();
let maxConcurrentPerHost = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const key = `${host}${req.url}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
    maxConcurrentPerHost = Math.max(maxConcurrentPerHost, inFlight.get(host)!);
    await new Promise((r) => setTimeout(r, 5)); // make overlap observable if it happened
    const path = new URL(req.url!, "http://x").pathname;
    const done = (code: number, type: string, body: Buffer | string) => {
      inFlight.set(host, inFlight.get(host)! - 1);
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };
    if (path === "/") {
      const links = Array.from({ length: 12 }, (_, i) => `<a href="/p/${i}">Page ${i}</a>`).join("") + `<a href="/files/data.csv">data</a><a href="/files/photo.jpg">photo</a>`;
      return done(200, "text/html", `<!doctype html><html lang="en"><head><title>Host ${host}</title></head><body><main>${links}</main></body></html>`);
    }
    if (path.startsWith("/p/")) return done(200, "text/html", `<!doctype html><html lang="en"><head><title>${host} page ${path}</title><meta name="description" content="snowfall station records ${path}"></head><body><main><p>Station report ${path} on ${host}.</p></main></body></html>`);
    if (path === "/files/data.csv") return done(200, "text/csv", F.CSV);
    if (path === "/files/photo.jpg") return done(200, "image/jpeg", F.jpegWithExif());
    return done(404, "text/plain", "nope");
  });
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetcher = async (url: string, headers: Record<string, string>): Promise<SafeResponse> => {
  const res = await request(url, { headers, maxRedirections: 0 });
  const body = Buffer.from(await res.body.arrayBuffer());
  return F.response(body, Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), url, res.statusCode);
};
let sourceRuns = 0;
const source: DiscoverySource = {
  id: "multi_hosts",
  description: "test hosts",
  intervalMs: 3600_000,
  run: async () => {
    sourceRuns++;
    return HOSTS.map((h) => ({ url: `http://${h}:${port}/`, priority: 60, depth: 0, via: "bootstrap:multi_hosts", purpose: "bootstrap" as const }));
  },
};

for (const makeBackend of backends().slice(1)) {
  // Postgres only: SQLite is a single-writer, single-process backend by design.
  const backend = makeBackend();
  describe(`multiple crawler replicas on one shared frontier [${backend.name}]`, () => {
    const stores: Corpus[] = [];
    afterAll(async () => {
      for (const s of stores) await s.close();
      await backend.dispose();
    });

    it("never duplicates work, never overlaps a host, runs each source once, and indexes everything", async () => {
      stores.push(await backend.open());
      for (let i = 0; i < 3; i++) stores.push(await backend.reopen()); // separate pools ≈ separate replicas
      const profiles: CrawlerProfile[] = ["generalist", "datasets", "media", "documents"];
      const crawlers = stores.map((store, i) => new AutonomousCrawler({ store, fetch: fetcher, robots: async () => ({ allowed: true, crawlDelay: null, sitemaps: [] }), sources: [source], enrich: false, hostDelayMs: 0, concurrency: 4, profile: profiles[i], name: `replica-${i}`, urlPolicy: (u) => ({ ok: u.startsWith("http://127.0.0.") }) }));
      const processedBy = new Map<string, string[]>();
      crawlers.forEach((c) => c.on("processed", (e: { url: string }) => processedBy.set(e.url, [...(processedBy.get(e.url) ?? []), c.id])));
      // All replicas drain concurrently.
      await Promise.all(crawlers.map((c) => c.drain(500)));
      // Some replicas may finish early while others still discover; run a final round.
      await Promise.all(crawlers.map((c) => c.drain(500)));

      const expected = HOSTS.length * (1 + 12 + 2);
      expect([...hits.values()].every((n) => n === 1), JSON.stringify([...hits].filter(([, n]) => n > 1))).toBe(true);
      const stats = await stores[0].stats();
      const diag = JSON.stringify({ hits: hits.size, expected, maxConcurrentPerHost, sourceRuns, byState: stats.byState, recent: (stats.recentEvents as unknown[]).slice(0, 8) });
      expect(hits.size, diag).toBe(expected);
      expect(maxConcurrentPerHost, diag).toBe(1);
      expect(sourceRuns, diag).toBe(1);
      expect([...processedBy.values()].every((by) => by.length === 1), diag).toBe(true);
      expect(stats.byState.indexed, diag).toBe(expected);
      // Work was actually shared between replicas.
      const perReplica = new Map<string, number>();
      for (const by of processedBy.values()) perReplica.set(by[0], (perReplica.get(by[0]) ?? 0) + 1);
      expect(perReplica.size).toBeGreaterThanOrEqual(2); // distribution depends on timing; correctness bounds above are strict
    }, 120_000);
  });
}
