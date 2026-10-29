import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import type { SafeResponse } from "../src/net/safe-fetch.js";
import * as F from "./fixtures/build.js";

// Common Crawl index API is mocked at the HTTP-client boundary; everything else is real.
vi.mock("../src/net/safe-fetch.js", async (orig) => {
  const actual = await orig<typeof import("../src/net/safe-fetch.js")>();
  return {
    ...actual,
    safeFetchJson: vi.fn(async (url: string) => {
      if (url.endsWith("collinfo.json")) return [{ id: "CC-MAIN-2026-40", "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-40-index" }];
      throw new Error("unexpected");
    }),
    safeFetchText: vi.fn(async (url: string) => {
      const u = new URL(url);
      const mime = u.searchParams.getAll("filter").find((f) => f.startsWith("mime:"))!.slice(5);
      const ext = mime.includes("pdf") ? "pdf" : mime.includes("csv") ? "csv" : "jpg";
      return [1, 2].map((i) => JSON.stringify({ url: `https://www.${u.searchParams.get("url")}/files/report-${i}.${ext}`, mime, status: "200" })).join("\n");
    }),
  };
});

const { AutonomousCrawler } = await import("../src/corpus/crawler.js");
const { SqliteCorpus } = await import("../src/corpus/store.js");
const { commonCrawlSource } = await import("../src/corpus/bootstrap.js");
const { searchCorpus } = await import("../src/corpus/search.js");

let server: Server;
let base = "";
const files: Record<string, { type: string; body: () => Buffer | string | Promise<Buffer> }> = {};

beforeAll(async () => {
  Object.assign(files, {
    "/bucket/": { type: "application/xml", body: () => `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>open-data</Name><IsTruncated>false</IsTruncated>
      <Contents><Key>snow/report.pdf</Key><Size>900</Size><LastModified>2025-01-02T00:00:00.000Z</LastModified><ETag>"a"</ETag></Contents>
      <Contents><Key>snow/station.jpg</Key><Size>800</Size><LastModified>2025-01-03T00:00:00.000Z</LastModified><ETag>"b"</ETag></Contents>
      <Contents><Key>snow/</Key><Size>0</Size><LastModified>2025-01-03T00:00:00.000Z</LastModified><ETag>"c"</ETag></Contents></ListBucketResult>` },
    "/bucket/snow/report.pdf": { type: "application/octet-stream", body: () => F.pdf() },
    "/bucket/snow/station.jpg": { type: "application/octet-stream", body: () => F.jpegWithExif(1024, 768) },
    "/gcs.json": { type: "application/json", body: () => JSON.stringify({ kind: "storage#objects", items: [{ name: "obs/snowfall.csv", size: "120", contentType: "text/csv", md5Hash: "abc=", updated: "2025-02-01T00:00:00Z", mediaLink: `${base}/gcs/obs/snowfall.csv` }] }) },
    "/gcs/obs/snowfall.csv": { type: "text/csv", body: () => "station,date,snowfall_cm,lat,lon\nGulmarg,2025-01-01,12.5,34.05,74.38\nLeh,2025-01-01,,34.15,77.58\n" },
    "/pub/": { type: "text/html", body: () => `<html><head><title>Index of /pub/</title></head><body><h1>Index of /pub/</h1><pre><a href="../">../</a>\n<a href="clip.mp4">clip.mp4</a>   2025-01-04 10:00  540\n<a href="tone.wav">tone.wav</a>   2025-01-05 10:00  16K\n<a href="bundle.zip">bundle.zip</a>   2025-01-06 10:00  1K\n</pre></body></html>` },
    "/pub/clip.mp4": { type: "application/octet-stream", body: () => F.mp4(1280, 720, 9) },
    "/pub/tone.wav": { type: "application/octet-stream", body: () => F.wav(1) },
    "/pub/bundle.zip": { type: "application/zip", body: () => F.zip({ "readme.md": "# Snow bundle\n", "data/depth.csv": "a,b\n1,2\n" }) },
    "/ia/metadata": { type: "application/json", body: () => JSON.stringify({ dir: "/1/items/snowclips", metadata: { identifier: "snowclips", title: "Snow clips", creator: "Archive User", licenseurl: "https://creativecommons.org/licenses/by/4.0/", collection: ["opensource_movies"] }, files: [{ name: "a.jpg", source: "original", size: "800", md5: "x", format: "JPEG" }, { name: "a_thumb.jpg", source: "derivative" }] }) },
  });
  server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path.startsWith("/ia/download/")) {
      res.writeHead(200, { "content-type": "image/jpeg" });
      return res.end(F.jpegWithExif(640, 480));
    }
    const f = files[path];
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": f.type });
    res.end(await f.body());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetcher = async (url: string): Promise<SafeResponse> => {
  // IA manifests point at archive.org/download — route those to the local server.
  const local = url.replace("https://archive.org/download/snowclips/", `${base}/ia/download/`);
  const res = await request(local.split("#")[0], { maxRedirections: 0 });
  const body = Buffer.from(await res.body.arrayBuffer());
  return F.response(body, Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), url, res.statusCode);
};

describe("standalone files without any webpage", () => {
  it("discovers files through storage listings and archive manifests and inspects each by its real format", async () => {
    const store = new SqliteCorpus(":memory:");
    const seeds = [`${base}/bucket/`, `${base}/gcs.json`, `${base}/pub/`, `${base}/ia/metadata`];
    const crawler = new AutonomousCrawler({
      store,
      fetch: fetcher,
      robots: async () => ({ allowed: true, crawlDelay: null, sitemaps: [] }),
      sources: [{ id: "listings", description: "", intervalMs: 3600_000, run: async () => seeds.map((url) => ({ url, priority: 60, depth: 0, via: "bootstrap:listings", purpose: "bootstrap" as const })) }],
      enrich: false,
      hostDelayMs: 0,
      urlPolicy: (u) => ({ ok: u.startsWith(base) || u.startsWith("https://archive.org/download/snowclips/") }),
    });
    await crawler.drain(100);
    const get = async (p: string) => (await store.byUrl(p.startsWith("http") ? p : `${base}${p}`))!;
    const fields = async (p: string) => store.observationsFor((await store.latestSnapshot((await get(p)).id))!.id);
    const val = async (p: string, field: string) => (await fields(p)).find((f) => f.field === field)?.value;

    // Served as application/octet-stream, recognised from bytes.
    expect((await get("/bucket/snow/report.pdf")).kind).toBe("pdf");
    expect(await val("/bucket/snow/report.pdf", "pageCount")).toBe(2);
    expect((await get("/bucket/snow/station.jpg")).kind).toBe("image");
    expect(await val("/bucket/snow/station.jpg", "deviceMake")).toBe("TestMaker");
    expect((await get("/bucket/snow/report.pdf")).via).toBe("storage_listing");
    expect((await get("/bucket/snow/report.pdf")).purpose).toBe("artifact");
    expect(await val("/bucket/", "listing")).toEqual(expect.arrayContaining([expect.objectContaining({ key: "snow/report.pdf", size: 900 })]));

    expect((await get("/gcs/obs/snowfall.csv")).kind).toBe("csv");
    expect((await val("/gcs/obs/snowfall.csv", "columns")) as unknown[]).toEqual(expect.arrayContaining([{ name: "snowfall_cm", type: "number" }]));

    expect((await get("/pub/clip.mp4")).kind).toBe("video");
    expect(await val("/pub/clip.mp4", "width")).toBe(1280);
    expect(await val("/pub/clip.mp4", "duration")).toBe(9);
    expect((await get("/pub/tone.wav")).kind).toBe("audio");
    expect(await val("/pub/", "directoryListing")).toBe(true);
    expect((await get(`${base}/pub/bundle.zip#entry=data%2Fdepth.csv`)).state).toBe("indexed");

    const ia = await get("https://archive.org/download/snowclips/a.jpg");
    expect(ia.state).toBe("indexed");
    expect(await store.byUrl("https://archive.org/download/snowclips/a_thumb.jpg")).toBeUndefined(); // derivatives skipped

    const found = await searchCorpus(store, "snowfall station data");
    expect(found.results.some((r) => r.kind === "csv")).toBe(true);
    await store.close();
  });

  it("Common Crawl source turns index records into standalone-file frontier entries by MIME type", async () => {
    const src = commonCrawlSource({ domains: ["imd.gov.in"], mimes: ["application/pdf", "text/csv"] }, 2);
    const items = await src.run();
    expect(items.length).toBe(4);
    expect(items.every((i) => i.purpose === "artifact" && i.via === "bootstrap:commoncrawl_files")).toBe(true);
    expect(items.map((i) => i.url)).toEqual(expect.arrayContaining(["https://www.imd.gov.in/files/report-1.pdf", "https://www.imd.gov.in/files/report-2.csv"]));
  });
});
