import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "undici";
import type { Corpus } from "../src/corpus/types.js";
import { backends } from "./helpers/backends.js";
import { AutonomousCrawler } from "../src/corpus/crawler.js";
import { searchCorpus, resourceDetail } from "../src/corpus/search.js";
import type { DiscoverySource } from "../src/corpus/bootstrap.js";
import { CATEGORIES } from "../src/metadata/categories.js";
import type { SafeResponse } from "../src/net/safe-fetch.js";
import * as F from "./fixtures/build.js";

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser");

let server: Server;
let base = "";
const hits = new Map<string, number>();
let licenceText = "CC BY 4.0";
const files: Record<string, Buffer> = {};

const datasetPage = () => `<!doctype html><html lang="en"><head><title>Regional Rainfall Observations</title>
<meta name="description" content="Daily rainfall totals from 4 stations.">
<meta property="article:tag" content="hydrology">
<meta property="og:title" content="Regional Rainfall Observations">
<meta property="og:image" content="/media/gauge.jpg">
<link rel="license" href="/license">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Dataset","name":"Regional Rainfall Observations","license":"${base}/license","version":"${licenceText === "CC BY 4.0" ? "1.0" : "2.0"}","spatialCoverage":"River Basin North",
  "variableMeasured":["rainfall (mm)"],"measurementTechnique":"Tipping-bucket rain gauge","maintainer":{"@type":"Organization","name":"Hydrology Unit"},"interactionStatistic":{"@type":"InteractionCounter","interactionType":"https://schema.org/DownloadAction","userInteractionCount":"321"},
  "distribution":[{"@type":"DataDownload","encodingFormat":"text/csv","contentUrl":"${base}/files/rainfall.csv"},{"@type":"DataDownload","encodingFormat":"application/zip","contentUrl":"${base}/files/bundle.zip"}]},
 {"@type":"Organization","name":"Basin Water Authority","legalName":"Basin Water Authority"}]}</script>
</head><body><header><nav><a href="/">Home</a></nav></header><main>
<h1>Regional Rainfall Observations</h1><p>Licensed as ${licenceText}.</p>
<ul>
<li><a href="/docs/methodology.pdf">Methodology (PDF)</a></li>
<li><a href="/schema/rainfall.schema.json">Data dictionary / schema</a></li>
<li><a href="/changelog.xml">Changelog</a></li>
<li><a href="/models/README.md">Model card for the gap-filling model</a></li>
<li><a href="/messages/announcement.eml">Release announcement (email)</a></li>
<li><a href="/docs/broken.pdf">Legacy report</a></li>
</ul>
<img src="/media/gauge.jpg" alt="Rain gauge"><audio src="/media/sound.wav"></audio><video src="/media/flyover.mp4"></video>
<a href="/calendar?date=2025-01-01">calendar</a><a href="/page/99">p99</a><a href="/private/x">private</a>
</main><footer><a href="https://creativecommons.org/licenses/by-sa/4.0/">Site content CC BY-SA 4.0</a> <a href="/privacy">Privacy</a> © 2025 Basin Water Authority</footer></body></html>`;

const pages: Record<string, () => { type: string; body: Buffer | string; etag?: string }> = {
  "/robots.txt": () => ({ type: "text/plain", body: "User-agent: *\nDisallow: /private\n" }),
  "/catalog.xml": () => ({ type: "application/xml", body: `<urlset><url><loc>${base}/datasets</loc><lastmod>2025-04-01</lastmod></url></urlset>` }),
  "/datasets": () => ({ type: "text/html", body: `<!doctype html><html lang="en"><head><title>Dataset index</title></head><body><main><h1>Datasets</h1><a href="/datasets/rainfall">Regional rainfall</a><a href="/datasets/rainfall?utm_source=x">dup variant</a><a href="/mirror">Mirror</a></main></body></html>` }),
  "/mirror": () => ({ type: "text/html", body: `<!doctype html><html lang="en"><head><title>Dataset index</title></head><body><main><h1>Datasets</h1><a href="/datasets/rainfall">Regional rainfall</a><a href="/datasets/rainfall?utm_source=x">dup variant</a><a href="/mirror">Mirror</a></main></body></html>` }),
  "/datasets/rainfall": () => ({ type: "text/html", body: datasetPage(), etag: `"${createHash("md5").update(licenceText).digest("hex")}"` }),
  "/files/rainfall.csv": () => ({ type: "text/csv", body: F.CSV, etag: '"csv1"' }),
  "/files/bundle.zip": () => ({ type: "application/zip", body: files.zip }),
  "/docs/methodology.pdf": () => ({ type: "application/pdf", body: files.pdf }),
  "/docs/broken.pdf": () => ({ type: "application/pdf", body: Buffer.from("%PDF-1.7\nthis is not really a pdf") }),
  "/schema/rainfall.schema.json": () => ({ type: "application/schema+json", body: F.JSON_SCHEMA }),
  "/license": () => ({ type: "text/html", body: `<!doctype html><html lang="en"><head><title>Licence</title></head><body><main><h1>Data licence</h1><p>Data on this portal is licensed under <a rel="license" href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.</p></main></body></html>` }),
  "/changelog.xml": () => ({ type: "application/rss+xml", body: F.RSS }),
  "/models/README.md": () => ({ type: "text/markdown", body: F.MODEL_CARD }),
  "/messages/announcement.eml": () => ({ type: "message/rfc822", body: F.EML }),
  "/media/gauge.jpg": () => ({ type: "image/jpeg", body: F.jpegWithExif(800, 600) }),
  "/media/sound.wav": () => ({ type: "audio/wav", body: F.wav(1) }),
  "/media/flyover.mp4": () => ({ type: "video/mp4", body: F.mp4() }),
  "/privacy": () => ({ type: "text/html", body: `<html lang="en"><head><title>Privacy</title></head><body><main><p>We retain server logs for 30 days before they are deleted.</p></main></body></html>` }),
};

async function methodologyPdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle("Rainfall Methodology");
  doc.setAuthor("Hydrology Unit");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  const lines = ["Methodology: sampling design uses 4 tipping-bucket gauges.", "Sample size of 1,250 daily readings, n = 1250.", "Quality control removes readings above 300 mm.", "See doi:10.5555/rain.2025 for the station register.", "Licensed under CC BY 4.0."];
  lines.forEach((l, i) => p.drawText(l, { x: 50, y: 740 - i * 20, size: 11, font }));
  return Buffer.from(await doc.save());
}

beforeAll(async () => {
  files.pdf = await methodologyPdf();
  files.zip = F.zip({ "data/rainfall-2024.csv": F.CSV, "manifest-sha256.txt": `${createHash("sha256").update(F.CSV).digest("hex")}  data/rainfall-2024.csv\n`, "bagit.txt": "BagIt-Version: 1.0\n" });
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const p = pages[path]?.();
    if (!p) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html><head><title>Not found</title></head></html>");
    }
    if (p.etag && req.headers["if-none-match"] === p.etag) {
      res.writeHead(304, { etag: p.etag });
      return res.end();
    }
    res.writeHead(200, { "content-type": p.type, ...(p.etag ? { etag: p.etag } : {}) });
    res.end(p.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// Loopback is blocked by the production egress guard, so the test injects a plain fetcher.
const localFetch = async (url: string, headers: Record<string, string>): Promise<SafeResponse> => {
  const res = await request(url.split("#")[0], { headers, maxRedirections: 0 });
  const body = Buffer.from(await res.body.arrayBuffer());
  const h = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)]));
  return F.response(body, h, url, res.statusCode);
};
const localRobots = async (url: string) => {
  const p = robotsParser(`${base}/robots.txt`, pages["/robots.txt"]().body);
  return { allowed: p.isAllowed(url, "OmnispiderMetadataBot") ?? true, crawlDelay: null, sitemaps: [] as string[] };
};
const source = (): DiscoverySource => ({
  id: "test_catalog",
  description: "local sitemap",
  intervalMs: 3600_000,
  run: async () => [{ url: `${base}/catalog.xml`, priority: 60, depth: 0, via: "bootstrap:test_catalog", purpose: "bootstrap" }],
});

for (const makeBackend of backends()) {
  const backend = makeBackend();
  describe(`autonomous crawler [${backend.name}]: discovery → retrieval → extraction → index → search`, () => {
    let store: Corpus;
    let clock = Date.parse("2026-10-29T12:00:00Z");
    const mk = () => new AutonomousCrawler({ store, fetch: localFetch, robots: localRobots, sources: [source()], enrich: false, hostDelayMs: 0, concurrency: 3, now: () => clock, urlPolicy: (u) => ({ ok: u.startsWith(base) || u.startsWith("https://creativecommons.org"), reason: "outside test site" }) });
    const url = (p: string) => store.byUrl(`${base}${p}`);
    const obs = async (p: string, field: string) => {
      const r = (await url(p))!;
      return (await store.observationsFor((await store.latestSnapshot(r.id))!.id)).filter((f) => f.field === field);
    };
    afterAll(async () => {
      await store?.close();
      await backend.dispose();
    });

    it("crawls from a bootstrap source alone (no user-supplied URLs) and inspects the underlying artifacts", async () => {
      hits.clear();
      licenceText = "CC BY 4.0";
      store = await backend.open();
      await mk().drain(300);
      const ds = (await url("/datasets/rainfall"))!;
      expect(ds.state).toBe("indexed");
      // Each stage is tracked separately.
      expect(ds.retrieved_at && ds.inspected_at && ds.extracted_at && ds.indexed_at).toBeTruthy();
      const purpose = async (p: string) => (await url(p))?.purpose;
      expect(await purpose("/files/rainfall.csv")).toBe("artifact");
      expect(await purpose("/docs/methodology.pdf")).toBe("supporting:methodology");
      expect(await purpose("/schema/rainfall.schema.json")).toBe("supporting:schema");
      expect(await purpose("/license")).toBe("supporting:rights");
      expect(await purpose("/changelog.xml")).toBe("supporting:revision");
      for (const p of ["/files/rainfall.csv", "/docs/methodology.pdf", "/schema/rainfall.schema.json", "/license", "/changelog.xml", "/media/gauge.jpg", "/media/sound.wav", "/media/flyover.mp4", "/messages/announcement.eml", "/models/README.md", "/files/bundle.zip"]) {
        expect((await url(p))?.state, p).toBe("indexed");
      }
    });

    it("extracts metadata from the actual files, not just listings", async () => {
      expect((await obs("/files/rainfall.csv", "columnStats"))[0].evidenceType).toBe("inferred");
      expect((await obs("/docs/methodology.pdf", "sampleSize"))[0].value).toBe(1250);
      expect(String((await obs("/docs/methodology.pdf", "methodologyStatement"))[0].value)).toContain("sampling design");
      expect((await obs("/docs/methodology.pdf", "doi"))[0].value).toEqual(["10.5555/rain.2025"]);
      expect((await obs("/docs/methodology.pdf", "author")).map((f) => f.value)).toContain("Hydrology Unit");
      expect((await obs("/schema/rainfall.schema.json", "required"))[0].value).toEqual(["name", "age"]);
      expect((await obs("/media/gauge.jpg", "deviceModel"))[0]).toMatchObject({ value: "Model X1", evidenceType: "direct_extraction" });
      expect((await obs("/media/sound.wav", "sampleRate"))[0].value).toBe(8000);
      expect((await obs("/media/flyover.mp4", "duration"))[0].value).toBe(3);
      expect((await obs("/messages/announcement.eml", "from"))[0].value).toBe("a***@sender.test");
      expect((await obs("/models/README.md", "pipelineTag"))[0].value).toBe("text-classification");
      expect((await obs("/files/bundle.zip", "packaging"))[0].value).toBe("BagIt");
      const entry = (await store.byUrl(`${base}/files/bundle.zip#entry=${encodeURIComponent("data/rainfall-2024.csv")}`))!;
      expect(entry.state).toBe("indexed");
      expect(entry.kind).toBe("csv");
    });

    it("scopes site-wide statements separately from resource statements", async () => {
      const lic = (await obs("/datasets/rainfall", "license")).filter((f) => f.category === 6);
      expect(lic.find((f) => f.value === "CC BY-SA 4.0")?.scope).toBe("site");
      expect(lic.find((f) => String(f.value).includes("/license"))?.scope).toBe("resource");
    });

    it("rejects traps, respects robots, collapses URL variants and flags duplicates", async () => {
      expect(hits.get("/calendar")).toBeUndefined();
      expect(hits.get("/page/99")).toBeUndefined();
      expect(hits.get("/private/x")).toBeUndefined();
      expect(hits.get("/datasets/rainfall")).toBe(1); // utm variant canonicalised
      expect((await url("/mirror"))!.duplicate_of).toBe((await url("/datasets"))!.id);
      const ev = (await store.eventsFor((await url("/datasets/rainfall"))!.id)).map((e) => `${e.type} ${e.detail}`).join("\n");
      expect(ev).toMatch(/rejected .*calendar_trap/);
      expect(ev).toMatch(/pagination_limit/);
    });

    it("records failed parsers truthfully without losing the resource", async () => {
      const b = (await url("/docs/broken.pdf"))!;
      expect(b.state).toBe("indexed");
      const fields = await store.observationsFor((await store.latestSnapshot(b.id))!.id);
      expect(fields.some((f) => f.category === 32 && f.status === "extraction_failed")).toBe(true);
      expect(fields.some((f) => f.field === "sha256")).toBe(true);
    });

    it("learns URL-pattern yields and extractor reliability from its own outcomes", async () => {
      const best = await store.topPatterns(50, "yield");
      expect(best.length).toBeGreaterThan(5);
      const csv = best.find((p) => p.key.endsWith("/files/*.csv"))!;
      expect(csv).toMatchObject({ fetched: 1, indexed: 1 });
      expect(csv.catsSum).toBeGreaterThan(10);
      const ex = await store.extractorStats();
      expect(ex.find((e) => e.id.startsWith("pdf@"))!.runs).toBeGreaterThanOrEqual(2);
      expect(ex.find((e) => e.id.startsWith("html@"))!.errors).toBe(0);
    });

    it("answers ordinary questions from the collected corpus with fact sheets, evidence, supporting resources and gaps", async () => {
      const res = await searchCorpus(store, "how was the rainfall data sampled?");
      expect(res.total).toBeGreaterThan(0);
      const pdf = res.results.find((r) => r.url === `${base}/docs/methodology.pdf`)!;
      expect(pdf).toBeTruthy();
      expect(pdf.evidence.some((e) => e.field === "methodologyStatement" && e.method && e.observedAt)).toBe(true);
      expect(pdf.referencedBy.some((p) => p.url === `${base}/datasets/rainfall`)).toBe(true);

      const ds = (await searchCorpus(store, "rainfall observations datasets license")).results.find((r) => r.url === `${base}/datasets/rainfall`)!;
      expect(ds.facts.publisher.map((f) => f.value)).toContain("Basin Water Authority");
      expect(ds.facts.spatialCoverage.map((f) => f.value)).toContain("River Basin North");
      expect(ds.facts.license.some((f) => f.scope === "resource")).toBe(true);
      expect(ds.facts.version.map((f) => f.value)).toContain("1.0");
      // Methodology facts come from the linked supporting PDF, labelled with where they came from.
      expect(ds.facts.methods.some((f) => f.via?.startsWith("supporting:methodology") && String(f.value).includes("sampling design"))).toBe(true);
      expect(ds.supportingResources.some((s) => s.purpose === "supporting:methodology")).toBe(true);

      const gaps = await searchCorpus(store, "rainfall camera exif");
      const csvHit = gaps.results.find((r) => r.kind === "csv");
      if (csvHit) expect(csvHit.gaps.find((g) => g.category === 29)?.state).toBe("not_applicable");
    });

    it("covers all 41 categories with real observations across the crawled corpus", async () => {
      expect((await store.stats()).categoriesObserved).toBe(41);
      const detail = (await resourceDetail(store, (await url("/files/rainfall.csv"))!.id))!;
      expect(detail.categories).toHaveLength(41);
      expect(detail.categories.find((c) => c.id === 29)!.state).toBe("not_applicable");
      expect(detail.categories.find((c) => c.id === 17)!.state).toBe("observed");
    });

    it("detects version changes on revisit and uses conditional requests for unchanged resources", async () => {
      licenceText = "CC BY-NC 4.0";
      clock += 8 * 86400_000;
      await mk().drain(300);
      const ds = (await url("/datasets/rainfall"))!;
      expect(ds.snapshot_count).toBe(2);
      expect(ds.change_count).toBe(1);
      const change = (await obs("/datasets/rainfall", "changedSinceLastSnapshot"))[0];
      expect((change.value as { fields: string[] }).fields).toEqual(expect.arrayContaining(["11.version"]));
      const csv = (await url("/files/rainfall.csv"))!;
      expect((await store.eventsFor(csv.id)).some((e) => e.type === "not_modified")).toBe(true);
      expect(csv.snapshot_count).toBe(1);
    });

    it("recovers abandoned work after a restart", async () => {
      await store.enqueue([{ url: `${base}/privacy?x=1`, priority: 999, depth: 1, via: "test", purpose: "discovery" }], clock);
      const leased = await store.lease(1, 60_000, clock);
      expect(leased[0].url).toBe(`${base}/privacy?x=1`);
      await store.close(); // simulated crash with a lease outstanding
      store = await backend.reopen();
      expect((await url("/privacy?x=1"))!.state).toBe("leased");
      clock += 2 * 60_000; // the dead worker's lease expires (multi-replica safe semantics)
      const crawler = mk();
      crawler.start();
      await new Promise((r) => setTimeout(r, 400));
      await crawler.stop();
      await mk().drain(20);
      const rec = (await url("/privacy?x=1"))!;
      expect(rec.state).toBe("indexed");
      expect(((await store.stats()).recentEvents as Array<{ type: string }>).some((e) => e.type === "lease_recovery")).toBe(true);
    });
  });
}
