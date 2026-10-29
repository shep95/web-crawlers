import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "undici";
import { crawlSite, type CrawlEvent } from "../src/crawl/site-crawler.js";
import type { SafeResponse } from "../src/net/safe-fetch.js";
import { buildApp } from "../src/api.js";
import { loadConfig } from "../src/core/config.js";
import * as F from "./fixtures/build.js";

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser");

// ------------------------------------------------------------------ local site
let server: Server;
let base = "";
const hits: string[] = [];
const page = (title: string, body: string, extra = "") => `<!doctype html><html lang="en"><head><title>${title}</title>${extra}</head><body>${body}</body></html>`;
const routes: Record<string, () => { status?: number; type?: string; body: string; headers?: Record<string, string> }> = {
  "/robots.txt": () => ({ type: "text/plain", body: `User-agent: *\nDisallow: /private\nSitemap: ${base}/sitemap.xml` }),
  "/sitemap.xml": () => ({ type: "application/xml", body: `<urlset><url><loc>${base}/from-sitemap</loc></url></urlset>` }),
  "/": () => ({ type: "text/html", body: page("Home", `<a href="/a">A</a><a href="/b?utm_source=x">B</a><a href="/private/secret">P</a><a href="https://elsewhere.test/">ext</a><a href="/style.css">css</a><a href="/redirect">R</a><a href="/missing">M</a>`) }),
  "/a": () => ({ type: "text/html", body: page("A", `<a href="/deep1">D1</a><a href="/">home</a><a href="/a#frag">self</a>`) }),
  "/b": () => ({ type: "text/html", body: page("A", `<a href="/deep1">D1</a><a href="/">home</a><a href="/a#frag">self</a>`) }), // same bytes as /a? (no: title A, same body) → duplicate content
  "/deep1": () => ({ type: "text/html", body: page("Deep 1", `<a href="/deep2">D2</a>`) }),
  "/deep2": () => ({ type: "text/html", body: page("Deep 2", `<a href="/deep3">D3</a>`) }),
  "/nofollow": () => ({ type: "text/html", body: page("NF", `<a href="/never">never</a>`, `<meta name="robots" content="nofollow">`) }),
  "/from-sitemap": () => ({ type: "text/html", body: page("From sitemap", `<a href="/nofollow">nf</a>`) }),
  "/redirect": () => ({ status: 301, body: "", headers: { location: "https://elsewhere.test/landing" } }),
  "/missing": () => ({ status: 404, type: "text/html", body: page("404", "gone") }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    hits.push(path);
    const r = routes[path]?.() ?? { status: 404, type: "text/plain", body: "nope" };
    res.writeHead(r.status ?? 200, { "content-type": r.type ?? "text/plain", ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Test fetcher: loopback is (correctly) blocked by the real egress guard, so tests inject a plain one. */
const localFetch = async (url: string): Promise<SafeResponse> => {
  if (url.startsWith("https://elsewhere.test")) throw new Error("ENOTFOUND elsewhere.test");
  const res = await request(url, { maxRedirections: 0 });
  const body = Buffer.from(await res.body.arrayBuffer());
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)]));
  if (res.statusCode >= 300 && res.statusCode < 400) {
    return { ...F.response("", headers, url, res.statusCode), finalUrl: new URL(headers.location, url).toString(), status: 200 };
  }
  return F.response(body, headers, url, res.statusCode);
};
const localRobots = async (url: string) => {
  const txt = routes["/robots.txt"]().body;
  const p = robotsParser(`${base}/robots.txt`, txt);
  return { allowed: p.isAllowed(url, "OmnispiderMetadataBot") ?? true, crawlDelay: null, sitemaps: p.getSitemaps() };
};

async function collect(gen: AsyncGenerator<CrawlEvent>): Promise<CrawlEvent[]> {
  const out: CrawlEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("site crawler", () => {
  it("crawls same-site BFS with robots, sitemap, dedupe, depth limit and nofollow", async () => {
    const events = await collect(crawlSite(`${base}/`, { maxPages: 30, maxDepth: 2, minDelayMs: 0, fetcher: localFetch, robots: localRobots }));
    const pages = events.filter((e) => e.type === "page") as Extract<CrawlEvent, { type: "page" }>[];
    const urls = pages.map((p) => new URL(p.url).pathname);
    expect(urls[0]).toBe("/");
    expect(urls).toEqual(expect.arrayContaining(["/a", "/b", "/deep1", "/from-sitemap"]));
    expect(urls).not.toContain("/private/secret");
    expect(urls).not.toContain("/deep3"); // beyond depth 2
    expect(urls).not.toContain("/never"); // nofollow page links not followed
    expect(urls.filter((u) => u === "/a")).toHaveLength(1); // fragment variant deduped
    expect(pages.find((p) => p.url.endsWith("/b"))!.url).toBe(`${base}/b`); // tracking param stripped
    expect(pages.find((p) => p.url.endsWith("/b"))!.duplicateOf).toBe(`${base}/a`); // identical bytes detected
    expect(events.some((e) => e.type === "skip" && e.reason === "robots.txt disallow")).toBe(true);
    expect(events.some((e) => e.type === "skip" && /redirected off-site/.test(e.reason))).toBe(true);
    expect(events.some((e) => e.type === "skip" && e.reason === "non-document asset")).toBe(false); // css filtered before queueing
    expect(hits).not.toContain("/private/secret");
    const missing = pages.find((p) => p.url.endsWith("/missing"))!;
    expect(missing.status).toBe(404);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", stoppedBy: "frontier_exhausted" });
  });
  it("respects maxPages and cancellation", async () => {
    const limited = await collect(crawlSite(`${base}/`, { maxPages: 2, maxDepth: 3, minDelayMs: 0, includeSitemap: false, fetcher: localFetch, robots: localRobots }));
    expect(limited.filter((e) => e.type === "page")).toHaveLength(2);
    expect(limited.at(-1)).toMatchObject({ stoppedBy: "limit" });
    const ac = new AbortController();
    ac.abort();
    const cancelled = await collect(crawlSite(`${base}/`, { maxPages: 10, signal: ac.signal, minDelayMs: 0, fetcher: localFetch, robots: localRobots }));
    expect(cancelled.at(-1)).toMatchObject({ type: "done", stoppedBy: "cancelled", pages: 0 });
  });
  it("enforces crawl delay between requests", async () => {
    const t0 = Date.now();
    await collect(crawlSite(`${base}/a`, { maxPages: 3, maxDepth: 1, minDelayMs: 150, includeSitemap: false, fetcher: localFetch, robots: localRobots }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });
  it("refuses private seeds with the real egress guard", async () => {
    const events = await collect(crawlSite(`${base}/`));
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { error: string }).error).toMatch(/EGRESS_BLOCKED/);
  });
});

// ------------------------------------------------------------------ HTTP API
describe("HTTP API", () => {
  const config = loadConfig();
  it("serves health, readiness, registry, UI shell and security headers", async () => {
    const app = await buildApp(config, { logger: false, legacy: false, corpusPath: ":memory:", crawler: false });
    const health = await app.inject("/health");
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
    expect((await app.inject("/ready")).json().ready).toBe(true);
    const cats = (await app.inject("/api/v2/categories")).json();
    expect(cats.count).toBe(41);
    const ex = (await app.inject("/api/v2/extractors")).json();
    expect(ex.count).toBeGreaterThanOrEqual(19);
    const ui = await app.inject({ url: "/search?q=x", headers: { accept: "text/html" } });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(ui.body).toContain('<script src="/app.js"');
    const api404 = await app.inject("/api/v2/nope");
    expect(api404.statusCode).toBe(404);
    expect(api404.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });
  it("validates input and blocks SSRF targets", async () => {
    const app = await buildApp(config, { logger: false, legacy: false, corpusPath: ":memory:", crawler: false });
    expect((await app.inject("/api/v2/analyze?url=not-a-url")).statusCode).toBe(400);
    const ssrf = await app.inject("/api/v2/analyze?url=http://169.254.169.254/latest/meta-data/");
    expect(ssrf.statusCode).toBe(403);
    expect(ssrf.json().error).toBe("EGRESS_BLOCKED");
    const priv = await app.inject("/api/v2/analyze?url=http://10.0.0.5/");
    expect(priv.statusCode).toBe(403);
    expect((await app.inject("/api/v2/search?q=")).statusCode).toBe(400);
    const empty = (await app.inject("/api/v2/search?q=rainfall")).json();
    expect(empty).toMatchObject({ total: 0, results: [] });
    expect((await app.inject("/api/v2/crawler/status")).json()).toMatchObject({ running: false });
    expect((await app.inject("/api/v2/resources/999")).statusCode).toBe(404);
    await app.close();
  });
  it("analyzes uploaded files without network or storage", async () => {
    const app = await buildApp(config, { logger: false, legacy: false, corpusPath: ":memory:", crawler: false });
    const res = await app.inject({ method: "POST", url: "/api/v2/analyze/upload", payload: F.CSV, headers: { "content-type": "application/octet-stream", "x-filename": "rain.csv", "x-content-type": "text/csv" } });
    expect(res.statusCode).toBe(200);
    const rec = res.json();
    expect(rec.kind).toBe("csv");
    expect(rec.sourceType).toBe("upload");
    expect(rec.categories).toHaveLength(41);
    expect(rec.fields.some((f: { field: string }) => f.field === "columnStats")).toBe(true);
    const empty = await app.inject({ method: "POST", url: "/api/v2/analyze/upload", payload: "", headers: { "content-type": "application/octet-stream" } });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });
  it("enforces API keys when configured and rate limits per client", async () => {
    process.env.API_KEYS = "test-key-123";
    process.env.RATE_LIMIT_PER_MIN = "3";
    const app = await buildApp(config, { logger: false, legacy: false, corpusPath: ":memory:", crawler: false });
    expect((await app.inject("/api/v2/stats")).statusCode).toBe(401);
    expect((await app.inject("/api/v2/categories")).statusCode).toBe(200); // registry stays public
    const ok = await app.inject({ url: "/api/v2/stats", headers: { authorization: "Bearer test-key-123" } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v2/stats", headers: { "x-api-key": "wrong" } })).statusCode).toBe(401);
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await app.inject({ url: "/api/v2/stats", headers: { "x-api-key": "test-key-123" } })).statusCode;
    expect(last).toBe(429);
    delete process.env.API_KEYS;
    delete process.env.RATE_LIMIT_PER_MIN;
    await app.close();
  });
  it("does not expose legacy routes (incl. the removed person lookup) by default", async () => {
    const app = await buildApp(config, { logger: false, corpusPath: ":memory:", crawler: false });
    for (const [method, url] of [["POST", "/v1/lookup"], ["GET", "/v1/jobs"], ["GET", "/api/corpus/export"], ["POST", "/api/scribd/sync"]] as const) {
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(404);
    }
    await app.close();
  });
});
