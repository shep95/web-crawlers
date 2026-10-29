import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "undici";
import { AutonomousCrawler } from "../src/corpus/crawler.js";
import { searchCorpus } from "../src/corpus/search.js";
import type { Corpus } from "../src/corpus/types.js";
import type { SafeResponse } from "../src/net/safe-fetch.js";
import { backends } from "./helpers/backends.js";
import * as F from "./fixtures/build.js";

/**
 * The user's scenario: while nobody is searching, the crawler discovers a
 * public research website, inspects its report, photographs, video and
 * dataset, follows methodology / licensing / revision records, and later
 * answers "research datasets about snowfall in northern india" from the
 * metadata it has already collected.
 */
let server: Server;
let base = "";
const pages: Record<string, () => Promise<{ type: string; body: Buffer | string }> | { type: string; body: Buffer | string }> = {};

beforeAll(async () => {
  const csv = ["station,date,snowfall_cm,lat,lon", "Gulmarg,2023-12-01,14.2,34.05,74.38", "Pahalgam,2023-12-01,9.8,34.01,75.32", "Leh,2024-01-15,,34.15,77.58", "Manali,2024-02-20,22.4,32.24,77.19", "Manali,2024-02-20,22.4,32.24,77.19"].join("\n");
  const report = async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.setTitle("Himalayan Snowfall Report 2024");
    doc.setAuthor("Institute of Mountain Hydrology");
    doc.setCreator("LibreOffice Writer");
    doc.setCreationDate(new Date("2024-03-10T08:00:00Z"));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([612, 792]);
    ["Methodology: sampling design uses automatic snow gauges at 4 stations.", "The target population is all winter days 2023-24 at stations above 2000 m.", "Gauges are calibrated every season against manual snow boards.", "See doi:10.5555/snow.himalaya.2024. Licensed under CC BY 4.0."].forEach((l, i) => p.drawText(l, { x: 40, y: 740 - i * 22, size: 11, font }));
    doc.addPage([612, 792]);
    return Buffer.from(await doc.save());
  };
  Object.assign(pages, {
    "/sitemap.xml": () => ({ type: "application/xml", body: `<urlset><url><loc>${base}/</loc></url></urlset>` }),
    "/": () => ({ type: "text/html", body: `<!doctype html><html lang="en"><head><title>Institute of Mountain Hydrology</title></head><body><main><h1>Research</h1><a href="/projects/snowfall">Northern India snowfall project</a></main></body></html>` }),
    "/projects/snowfall": () => ({
      type: "text/html",
      body: `<!doctype html><html lang="en"><head><title>Snowfall in Northern India — station dataset</title>
<meta name="description" content="Daily snowfall observations from Himalayan stations in Jammu & Kashmir, Ladakh and Himachal Pradesh.">
<link rel="license" href="/license">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dataset","name":"Snowfall in Northern India","description":"Daily snowfall observations.","publisher":{"@type":"Organization","name":"Institute of Mountain Hydrology"},
 "spatialCoverage":{"@type":"Place","name":"Northern India (Western Himalaya)","geo":{"@type":"GeoShape","box":"32.0 74.0 35.0 78.0"}},"temporalCoverage":"2023-12-01/2024-02-29","version":"2.1",
 "variableMeasured":[{"@type":"PropertyValue","name":"snowfall_cm","unitText":"cm","description":"Fresh snowfall depth in 24 hours"}],"measurementTechnique":"Automatic snow gauges",
 "license":"${base}/license","identifier":"https://doi.org/10.5555/snow.himalaya.2024",
 "distribution":[{"@type":"DataDownload","encodingFormat":"text/csv","contentUrl":"${base}/data/snowfall.csv"}]}</script></head>
<body><main><h1>Snowfall in Northern India</h1>
<a href="/docs/report.pdf">Annual report (PDF)</a> <a href="/docs/methodology">Methodology</a> <a href="/changelog.xml">Revision history</a>
<img src="/media/gulmarg.jpg" alt="Gulmarg snow gauge"><img src="/media/leh.jpg" alt="Leh station"><video src="/media/timelapse.mp4"></video>
</main><footer>© 2024 Institute of Mountain Hydrology</footer></body></html>`,
    }),
    "/docs/report.pdf": async () => ({ type: "application/pdf", body: await report() }),
    "/docs/methodology": () => ({ type: "text/html", body: `<!doctype html><html lang="en"><head><title>Methodology</title></head><body><main><h1>Methods</h1><p>Methodology: snowfall is measured with automatic snow gauges calibrated each season; sample size of 1,820 station-days.</p></main></body></html>` }),
    "/license": () => ({ type: "text/html", body: `<!doctype html><html lang="en"><head><title>Data licence</title></head><body><main><p>Data is licensed under <a rel="license" href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.</p></main></body></html>` }),
    "/changelog.xml": () => ({ type: "application/rss+xml", body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Dataset revisions</title><item><title>v2.1: added Manali station</title><link>${base}/projects/snowfall</link><pubDate>Fri, 01 Mar 2024 00:00:00 GMT</pubDate></item><item><title>v2.0</title><link>${base}/projects/snowfall</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>` }),
    "/data/snowfall.csv": () => ({ type: "text/csv", body: csv }),
    "/media/gulmarg.jpg": () => ({ type: "image/jpeg", body: F.jpegWithExif(4000, 3000) }),
    "/media/leh.jpg": () => ({ type: "image/jpeg", body: F.jpegWithExif(2000, 1500) }),
    "/media/timelapse.mp4": () => ({ type: "video/mp4", body: F.mp4(1920, 1080, 42) }),
  });
  server = createServer(async (req, res) => {
    const f = pages[new URL(req.url!, "http://x").pathname];
    if (!f) return res.writeHead(404).end();
    const { type, body } = await f();
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetcher = async (url: string): Promise<SafeResponse> => {
  const res = await request(url);
  return F.response(Buffer.from(await res.body.arrayBuffer()), Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), url, res.statusCode);
};

for (const makeBackend of backends()) {
  const backend = makeBackend();
  describe(`scenario: snowfall in northern India [${backend.name}]`, () => {
    let store: Corpus;
    afterAll(async () => {
      await store?.close();
      await backend.dispose();
    });

    it("background crawl inspects the report, photos, video, dataset and supporting records", async () => {
      store = await backend.open();
      const crawler = new AutonomousCrawler({
        store, fetch: fetcher, enrich: false, hostDelayMs: 0,
        robots: async () => ({ allowed: true, crawlDelay: null, sitemaps: [] }),
        urlPolicy: (u) => ({ ok: u.startsWith(base) }),
        // The only input: a public sitemap the system knows about. No user URLs.
        sources: [{ id: "public_sitemaps", description: "", intervalMs: 3600_000, run: async () => [{ url: `${base}/sitemap.xml`, priority: 60, depth: 0, via: "bootstrap:public_sitemaps", purpose: "bootstrap" }] }],
      });
      await crawler.drain(100);
      const f = async (path: string) => {
        const r = (await store.byUrl(`${base}${path}`))!;
        expect(r?.state, path).toBe("indexed");
        const fs = await store.observationsFor((await store.latestSnapshot(r.id))!.id);
        return (cat: number, field: string) => fs.filter((x) => x.category === cat && x.field === field).map((x) => x.value);
      };
      // 1. Report: title, author, creation date, software, page structure, citations, licence.
      const rep = await f("/docs/report.pdf");
      expect(rep(32, "title")).toContain("Himalayan Snowfall Report 2024");
      expect(rep(32, "author")).toContain("Institute of Mountain Hydrology");
      expect(rep(12, "created")).toContain("2024-03-10T08:00:00.000Z");
      expect(rep(8, "creatorTool")).toContain("LibreOffice Writer");
      expect(rep(32, "pageCount")).toContain(2);
      expect(rep(14, "doi")).toContainEqual(["10.5555/snow.himalaya.2024"]);
      expect(rep(19, "population").length).toBe(1);
      expect(rep(35, "calibration").length).toBe(1);
      // 2. Photographs: camera, capture date, dimensions, creator credit.
      const img = await f("/media/gulmarg.jpg");
      expect(img(29, "width")).toContain(4000);
      expect(img(29, "make")).toContain("TestMaker");
      expect(img(12, "created")).toContain("2024-06-30T14:22:01.000Z");
      expect(img(6, "copyright")).toContain("(c) Jane 2024");
      // 3. Video: duration, resolution, codec, frame-rate container facts.
      const vid = await f("/media/timelapse.mp4");
      expect(vid(31, "duration")).toContain(42);
      expect(vid(31, "width")).toContain(1920);
      expect(vid(31, "videoCodec")).toContain("avc1");
      // 4. Dataset: columns, types, units, geographic + temporal coverage, missing values, duplicates, identifiers.
      const data = await f("/data/snowfall.csv");
      expect(data(17, "columns")[0]).toEqual(expect.arrayContaining([{ name: "snowfall_cm", type: "number" }, { name: "date", type: "date" }]));
      expect(data(16, "units")[0]).toEqual([{ column: "snowfall_cm", unit: "cm" }]);
      expect(data(13, "boundingBox")[0]).toMatchObject({ south: 32.24, north: 34.15, west: 74.38, east: 77.58 });
      expect(data(13, "namedPlaces")[0]).toEqual(["Gulmarg", "Pahalgam", "Leh", "Manali"]);
      expect(data(12, "temporalCoverage")).toContain("2023-12-01/2024-02-20");
      expect(data(20, "duplicateRate")).toContain(0.2);
      expect(data(20, "nullRate")[0]).toBeGreaterThan(0);
      // 5. Supporting material discovered and linked with purposes.
      const ds = (await store.byUrl(`${base}/projects/snowfall`))!;
      expect((await store.byUrl(`${base}/docs/methodology`))!.purpose).toBe("supporting:methodology");
      expect((await store.byUrl(`${base}/license`))!.purpose).toBe("supporting:rights");
      expect((await store.byUrl(`${base}/changelog.xml`))!.purpose).toBe("supporting:revision");
      expect((await store.linkedFrom(ds.id)).map((l) => l.url)).toEqual(expect.arrayContaining([`${base}/data/snowfall.csv`, `${base}/docs/methodology`, `${base}/license`]));
      // All 41 categories evaluated for each resource, with truthful states.
      const rec = (await store.snapshotRecord((await store.latestSnapshot(ds.id))!.id))!;
      expect(rec.categories).toHaveLength(41);
      expect(rec.categories.find((c) => c.id === 33)!.state).toBe("not_applicable");
    }, 60_000);

    it("later answers the question from collected metadata", async () => {
      const res = await searchCorpus(store, "research datasets about snowfall in northern india");
      expect(res.resourceTypes).toContain("dataset");
      const top = res.results[0];
      expect([`${base}/projects/snowfall`, `${base}/data/snowfall.csv`]).toContain(top.url);
      const ds = res.results.find((r) => r.url === `${base}/projects/snowfall`)!;
      const vals = (fs: Array<{ value: unknown }>) => fs.map((x) => (typeof x.value === "string" ? x.value : JSON.stringify(x.value)));
      expect(vals(ds.facts.publisher)).toContain("Institute of Mountain Hydrology");
      expect(vals(ds.facts.spatialCoverage).join(" ")).toMatch(/Northern India/);
      expect(vals(ds.facts.temporalCoverage)).toContain("2023-12-01/2024-02-29");
      expect(vals(ds.facts.version)).toContain("2.1");
      expect(ds.facts.license.length).toBeGreaterThan(0);
      expect(ds.facts.methods.some((m) => String(m.value).includes("Automatic snow gauges"))).toBe(true);
      expect(ds.facts.methods.some((m) => m.via?.startsWith("supporting:methodology"))).toBe(true);
      expect(ds.facts.identifiers.length).toBeGreaterThan(0);
      expect(ds.supportingResources.map((s) => s.purpose)).toEqual(expect.arrayContaining(["artifact", "supporting:methodology", "supporting:rights"]));
      // The CSV itself is also findable, with its computed coverage.
      const csv = res.results.find((r) => r.url === `${base}/data/snowfall.csv`);
      if (csv) expect(vals(csv.facts.spatialCoverage).join(" ")).toMatch(/32\.24/);
    });
  });
}
