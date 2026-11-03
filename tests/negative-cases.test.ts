import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Agent } from "undici";
import type { Corpus, ResourceRow } from "../src/corpus/types.js";
import { AutonomousCrawler } from "../src/corpus/crawler.js";
import { searchCorpus } from "../src/corpus/search.js";
import type { DiscoverySource } from "../src/corpus/bootstrap.js";
import { __testing, safeFetch } from "../src/net/safe-fetch.js";
import { registerCorpusRoutes } from "../src/http/corpus-routes.js";
import { ApiKeys } from "../src/http/guards.js";
import { backends } from "./helpers/backends.js";
import * as F from "./fixtures/build.js";

/**
 * Negative cases, end to end through the real crawler, the real SSRF-guarded fetcher (loopback allowed
 * for the test server only) and both corpus backends. Each case asserts lifecycle states, transitions
 * and field statuses — not just that "something happened".
 */
const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser");

let server: Server;
let base = "";
const hits = new Map<string, number>();
let flakyCalls = 0;
let removed = false;
const files: Record<string, Buffer> = {};
// Built at runtime so the source never contains a scanner-matching literal (fake value).
const SECRET_STRIPE = ["sk", "live", "51HxAbCdEfGhIjKlMnOpQrSt12"].join("_");
const SECRET_AWS = "AKIAIOSFODNN7EXAMPLE";
const SECRET_PW = "hunter2hunter2";
const ROBOTS = "User-agent: *\nDisallow: /private\n";
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} test page"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const routes: Record<string, () => { status?: number; type?: string; body?: Buffer | string; headers?: Record<string, string> }> = {
  "/robots.txt": () => ({ type: "text/plain", body: ROBOTS }),
  "/start": () => ({
    type: "text/html",
    body: page("Negative case index", `<p>Station listings for the quiet valley.</p><ul>
      <li><a href="/private/report">private report</a></li>
      <li><a href="/redirect-private">internal mirror</a></li>
      <li><a href="/secret-page">deployment notes</a></li>
      <li><a href="/photo.jpg">station photo</a></li>
      <li><a href="/files/big.csv">big table</a></li>
      <li><a href="/flaky">flaky page</a></li>
      <li><a href="/gone">gone page</a></li>
      <li><a href="/removed">removed later</a></li>
      <li><a href="/files/a.csv">table A</a></li>
      <li><a href="/mirror/a.csv">table A (mirror)</a></li>
      <li><a href="/docs/broken.pdf">broken report</a></li>
      <li><a href="/calendar?date=2025-01-01">calendar</a></li>
      <li><a href="/events/2025/01/02/03/x">event</a></li>
    </ul>`),
  }),
  "/calendar": () => ({ type: "text/html", body: page("Calendar", `<a href="/calendar?date=2025-01-02">next day</a>`) }),
  "/redirect-private": () => ({ status: 302, headers: { location: "http://10.0.0.1/admin" }, body: "" }),
  "/secret-page": () => ({
    type: "text/html",
    body: page("Deployment notes zebrafinch", `<p>Zebrafinch migration notes.</p><pre>api_key = ${SECRET_STRIPE}\naws_access_key_id=${SECRET_AWS}\npassword: ${SECRET_PW}</pre>`),
  }),
  "/photo.jpg": () => ({ type: "image/jpeg", body: files.pdf }),
  "/files/big.csv": () => ({ type: "text/csv", body: files.big }),
  "/flaky": () => (++flakyCalls <= 2 ? { status: 503, type: "text/html", body: "<h1>Service Unavailable</h1>" } : { type: "text/html", body: page("Flaky but fine", "<p>Recovered content about rainfall.</p>") }),
  "/gone": () => ({ status: 404, type: "text/html", body: "<html><head><title>Not found</title></head></html>" }),
  "/removed": () => (removed ? { status: 410, type: "text/html", body: "<h1>Gone</h1>" } : { type: "text/html", body: page("Soon removed glacier survey", "<p>Glacier survey results.</p>") }),
  "/files/a.csv": () => ({ type: "text/csv", body: F.CSV }),
  "/mirror/a.csv": () => ({ type: "text/csv", body: F.CSV }),
  "/docs/broken.pdf": () => ({ type: "application/pdf", body: Buffer.from("%PDF-1.7\nthis is not really a pdf") }),
};

beforeAll(async () => {
  files.pdf = await F.pdf();
  files.big = Buffer.from("station,date,mm\n" + Array.from({ length: 20_000 }, (_, i) => `S${i},2024-01-01,${i % 50}`).join("\n"));
  server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1);
    const r = routes[u.pathname]?.();
    if (!r) return res.writeHead(404, { "content-type": "text/plain" }).end("no");
    res.writeHead(r.status ?? 200, { ...(r.type ? { "content-type": r.type } : {}), ...r.headers });
    res.end(r.body ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __testing.allowLoopback = true;
  __testing.dispatcher = new Agent();
});
afterAll(async () => {
  __testing.allowLoopback = false;
  __testing.dispatcher = null;
  await new Promise<void>((r) => server.close(() => r()));
});

const MAX_BYTES = 64 * 1024;
// The real guarded fetcher: every redirect hop is re-checked against the egress policy.
const fetcher = (url: string, headers: Record<string, string>) => safeFetch(url, { headers, maxBytes: MAX_BYTES, timeoutMs: 10_000 });
const robots = async (url: string) => ({ allowed: robotsParser(`${base}/robots.txt`, ROBOTS).isAllowed(url, "OmnispiderMetadataBot") ?? true, crawlDelay: null, sitemaps: [] as string[] });
const source = (): DiscoverySource => ({ id: "negative", description: "negative cases", intervalMs: 3600_000, run: async () => [{ url: `${base}/start`, priority: 60, depth: 0, via: "bootstrap:negative", purpose: "bootstrap" }] });

for (const makeBackend of backends()) {
  const backend = makeBackend();
  describe(`negative cases [${backend.name}]`, () => {
    let store: Corpus;
    let clock = Date.parse("2026-10-30T08:00:00Z");
    const mk = () => new AutonomousCrawler({ store, fetch: fetcher, robots, sources: [source()], enrich: false, hostDelayMs: 0, concurrency: 2, now: () => clock, urlPolicy: (u) => ({ ok: u.startsWith(base), reason: "outside test site" }) });
    /** Drain; let the host circuit-breaker window pass a few times (failures on one test host are expected). */
    const settle = async () => {
      await mk().drain(200);
      for (let i = 0; i < 3; i++) {
        clock += 2 * 60_000;
        await mk().drain(200);
      }
    };
    const r = async (p: string) => (await store.byUrl(`${base}${p}`)) as ResourceRow;
    const steps = async (p: string) => (await store.transitionsFor((await r(p)).id, 200)).reverse().map((t) => t.to);
    const fields = async (p: string) => store.observationsFor((await store.latestSnapshot((await r(p)).id))!.id);

    beforeAll(async () => {
      hits.clear();
      flakyCalls = 0;
      removed = false;
      store = await backend.open();
      await settle();
    });
    afterAll(async () => {
      await store?.close();
      await backend.dispose();
    });

    it("respects robots.txt disallow: restricted, never fetched", async () => {
      const x = await r("/private/report");
      expect(hits.get("/private/report")).toBeUndefined();
      expect(x).toMatchObject({ state: "skipped", lifecycle: "restricted", lifecycle_reason: "robots_disallow", retrieved_at: null });
      expect(await steps("/private/report")).toEqual(["discovered", "leased", "restricted"]);
    });

    it("refuses a redirect to a private IP: skipped by egress policy, target never contacted", async () => {
      const x = await r("/redirect-private");
      expect(hits.get("/redirect-private")).toBe(1);
      expect(x.state).toBe("skipped");
      expect(x.lifecycle).toBe("skipped");
      expect(x.lifecycle_reason).toBe("egress_policy:non_public_ip");
      expect(x.last_error).toMatch(/EGRESS_BLOCKED: non_public_ip \(http:\/\/10\.0\.0\.1\/admin\)/);
      expect(x.snapshot_count).toBe(0);
    });

    it("masks credential-looking strings and never makes them searchable", async () => {
      const x = await r("/secret-page");
      expect(x.lifecycle).toBe("indexed");
      expect((await searchCorpus(store, "zebrafinch migration")).results.some((h) => h.url === x.url)).toBe(true);
      // The secret-bearing token of each credential (search splits "sk_live_…" into words; the key part is unique).
      for (const token of [SECRET_STRIPE.split("_").pop()!, SECRET_AWS, SECRET_PW]) {
        const res = await searchCorpus(store, token);
        expect(res.results.some((h) => h.url === x.url), token).toBe(false);
      }
      const own = await searchCorpus(store, "zebrafinch deployment notes");
      expect(JSON.stringify(own.results)).not.toMatch(new RegExp(`${SECRET_STRIPE}|${SECRET_AWS}|${SECRET_PW}`));
      const fs = await fields("/secret-page");
      const dump = JSON.stringify(fs.map((f) => [f.value, f.evidence, f.original]));
      for (const secret of [SECRET_STRIPE, SECRET_AWS, SECRET_PW]) expect(dump).not.toContain(secret);
      const cred = fs.find((f) => f.field === "credentialLikeStrings")!;
      expect(cred).toMatchObject({ category: 39, masked: true, status: "observed" });
      expect((cred.value as { total: number }).total).toBeGreaterThanOrEqual(3);
    });

    it("detects a file-type mismatch (PDF bytes served as image/jpeg) by signature", async () => {
      const x = await r("/photo.jpg");
      expect(x.kind).toBe("pdf");
      expect(x.lifecycle).toBe("indexed");
      expect(x.validation_issues).toContain("declared_type_mismatch");
      const fs = await fields("/photo.jpg");
      expect(fs.find((f) => f.field === "sniffedType")?.value).toBe("application/pdf");
      expect(fs.find((f) => f.field === "validationIssues")?.value).toContain("declared_type_mismatch");
      expect(fs.some((f) => f.category === 32 && f.status !== "extraction_failed")).toBe(true); // parsed as the PDF it is
    });

    it("truncates a huge payload at the byte cap with an honest truncated flag", async () => {
      const x = await r("/files/big.csv");
      expect(x.lifecycle).toBe("indexed");
      expect(x.validation_issues).toContain("truncated");
      const fs = await fields("/files/big.csv");
      expect(fs.find((f) => f.category === 20 && f.field === "truncated")?.value).toBe(true);
      expect(fs.find((f) => f.field === "bodyBytes")?.value).toBe(MAX_BYTES);
      expect(String(fs.find((f) => f.field === "rowCount")?.evidence)).toMatch(/sampled/);
      expect((await store.transitionsFor(x.id)).find((t) => t.to === "fetched")?.detail).toMatch(/truncated at byte cap/);
    });

    it("retries a flaky source (5xx then success): failed_retryable → … → indexed", async () => {
      let x = await r("/flaky");
      expect(x).toMatchObject({ lifecycle: "failed_retryable", lifecycle_reason: "http_503", state: "queued", failures: 1, snapshot_count: 0 });
      clock += 20 * 60_000; // first backoff: 15 min
      await mk().drain(50);
      x = await r("/flaky");
      expect(x).toMatchObject({ lifecycle: "failed_retryable", failures: 2 });
      clock += 40 * 60_000; // second backoff: 30 min
      await mk().drain(50);
      x = await r("/flaky");
      expect(hits.get("/flaky")).toBe(3);
      expect(x).toMatchObject({ lifecycle: "indexed", state: "indexed", failures: 0, last_error: null });
      expect(await steps("/flaky")).toEqual(["discovered", "leased", "fetched", "failed_retryable", "leased", "fetched", "failed_retryable", "leased", "fetched", "inspected", "extracted", "validated", "indexed"]);
      expect((await searchCorpus(store, "recovered content rainfall")).results.some((h) => h.url === x.url)).toBe(true);
    });

    it("records a permanent 404 as unavailable without retrying", async () => {
      const x = await r("/gone");
      expect(hits.get("/gone")).toBe(1);
      expect(x).toMatchObject({ state: "unavailable", lifecycle: "unavailable", lifecycle_reason: "http_404", failures: 0, inspected_at: null });
      expect(await steps("/gone")).toEqual(["discovered", "leased", "fetched", "unavailable"]);
      expect(x.due_at - clock).toBeGreaterThan(5 * 86400_000); // normal revisit schedule, not a retry
    });

    it("deduplicates mirrors (same bytes, two URLs): one indexed, the other superseded with duplicate_of", async () => {
      const a = await r("/files/a.csv");
      const b = await r("/mirror/a.csv");
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      expect(first).toMatchObject({ lifecycle: "indexed", duplicate_of: null });
      expect(second).toMatchObject({ lifecycle: "superseded", duplicate_of: first.id, lifecycle_reason: `duplicate_of:${first.id}`, indexed_at: null });
      expect(first.content_hash).toBe(second.content_hash);
    });

    it("marks a corrupt PDF's document fields extraction_failed — never as a verified value", async () => {
      const x = await r("/docs/broken.pdf");
      expect(x.lifecycle).toBe("indexed");
      expect(x.validation_issues).toContain("extraction_failed_fields");
      const fs = (await fields("/docs/broken.pdf")).filter((f) => f.category === 32);
      expect(fs.find((f) => f.field === "parseError")).toMatchObject({ status: "extraction_failed" });
      // Only byte-level measurements survive (no /Encrypt marker, not linearised); no document value is claimed.
      expect(fs.filter((f) => f.status !== "extraction_failed").map((f) => f.field).sort()).toEqual(["encrypted", "linearized"]);
      expect(fs.some((f) => ["title", "author", "pageCount"].includes(f.field))).toBe(false);
      expect(fs.some((f) => f.status === "corroborated" || f.status === "source_declared")).toBe(false);
    });

    it("does not loop on calendar / date-path traps", async () => {
      expect(hits.get("/calendar")).toBeUndefined();
      expect(await store.byUrl(`${base}/calendar?date=2025-01-01`)).toBeUndefined();
      expect(await store.byUrl(`${base}/events/2025/01/02/03/x`)).toBeUndefined();
      const ev = (await store.eventsFor((await r("/start")).id)).map((e) => e.detail ?? "").join("\n");
      expect(ev).toMatch(/calendar_trap/);
    });

    it("records source removal (200 then 410) as a detected change and drops it from search", async () => {
      expect((await searchCorpus(store, "glacier survey")).results.some((h) => h.url === `${base}/removed`)).toBe(true);
      removed = true;
      clock += 8 * 86400_000;
      await settle();
      const x = await r("/removed");
      expect(x).toMatchObject({ state: "unavailable", lifecycle: "unavailable", lifecycle_reason: "http_410", change_count: 1, indexed_at: null });
      const t = (await store.transitionsFor(x.id)).reverse();
      const i = t.findIndex((s) => s.to === "change_detected");
      expect(t[i]).toMatchObject({ from: "fetched", reason: "removed" });
      expect(t[i].detail).toMatch(/HTTP 200 → 410/);
      expect(t[i + 1].to).toBe("unavailable");
      expect((await store.eventsFor(x.id)).some((e) => e.type === "removed")).toBe(true);
      expect((await searchCorpus(store, "glacier survey")).results.some((h) => h.url === x.url)).toBe(false);
    });

    it("rejects illegal transitions and stale compare-and-set on the stored row", async () => {
      const x = await r("/gone");
      await expect(store.transition(x.id, "unavailable", "indexed")).rejects.toThrow(/illegal lifecycle transition unavailable → indexed/);
      await expect(store.transition(x.id, "discovered", "leased")).rejects.toThrow(/row is in unavailable, expected discovered/);
      expect((await r("/gone")).lifecycle).toBe("unavailable");
    });

    it("reports measured coverage and capabilities over the API", async () => {
      const app = Fastify();
      registerCorpusRoutes(app, { store, crawlers: [], keys: new ApiKeys(), topicalDiscovery: false, countries: () => [{ code: "DE", name: "Germany" }, { code: "IN", name: "India" }] });
      const cov = (await app.inject({ url: "/api/v2/coverage" })).json();
      const all = await Promise.all(Object.keys(routes).map((p) => store.byUrl(`${base}${p}`)));
      const rows = all.filter(Boolean) as ResourceRow[];
      expect(cov.totals.indexed).toBe(cov.byLifecycle.indexed);
      expect(cov.byLifecycle.superseded).toBeGreaterThanOrEqual(1);
      expect(cov.totals.discovered).toBeGreaterThanOrEqual(rows.length);
      expect(cov.totals.fetched).toBeLessThan(cov.totals.discovered); // seeing a link is not fetching it (robots-restricted one)
      expect(cov.totals.inspected).toBeLessThan(cov.totals.fetched); // an HTTP response is not an inspection (404/410/redirect)
      expect(cov.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: "restricted", reason: "robots_disallow" }),
        expect.objectContaining({ state: "unavailable", reason: "http_404" }),
        expect.objectContaining({ state: "skipped", reason: "egress_policy:non_public_ip" }),
      ]));
      expect(cov.validationIssues.truncated).toBeGreaterThanOrEqual(1);
      // Hosting country: loopback is an IP literal; registry countries are measured zeros, publisher country unknown.
      expect(cov.byCountry.hostingSignal.strength).toBe("weak");
      const de = cov.byCountry.countries.find((c: { code: string }) => c.code === "DE");
      expect(de.hostingTld.discovered).toBe(0);
      expect(de.publisherCountry).toBe("unknown");
      expect(cov.byCountry.nonCountryHosts.ip_literal.discovered).toBe(cov.totals.discovered);
      expect(cov.byLanguage.languages.find((l: { language: string }) => l.language === "en").indexed).toBeGreaterThan(0);
      const pdf = cov.byCategory.categories.find((c: { id: number }) => c.id === 32);
      expect(pdf.fields.extraction_failed).toBeGreaterThanOrEqual(1);
      expect(pdf.resources.observed).toBeGreaterThanOrEqual(2); // photo.jpg (a real PDF) + broken.pdf's byte-level fields
      expect(pdf.resources.not_applicable).toBeGreaterThan(0);
      expect(cov.byKind.find((k: { kind: string }) => k.kind === "csv").superseded).toBe(1);
      expect(cov.bySourceFamily.find((f: { family: string }) => f.family === "reference").discovered).toBeGreaterThan(5);
      expect(typeof cov.totals.standaloneFiles).toBe("number");
      expect(cov.totals.freshness.indexedResources).toBe(cov.totals.indexed);

      const cap = (await app.inject({ url: "/api/v2/capabilities" })).json();
      expect(cap.categories).toHaveLength(41);
      const doc = cap.categories.find((c: { id: number }) => c.id === 32);
      expect(doc.formats.find((f: { kind: string }) => f.kind === "pdf")).toMatchObject({ implemented: true, tested: true, status: "live_verified" });
      const desc = cap.categories.find((c: { id: number }) => c.id === 1).formats.find((f: { kind: string }) => f.kind === "webpage");
      expect(desc.liveVerified).toBeGreaterThan(0);
      await app.close();
    });
  });
}
