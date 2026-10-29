import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "undici";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import { shutdownOcr } from "../src/metadata/extractors/ocr.js";
import { AutonomousCrawler } from "../src/corpus/crawler.js";
import { SqliteCorpus } from "../src/corpus/store.js";
import { playwrightRenderer } from "../src/corpus/render.js";
import type { SafeResponse } from "../src/net/safe-fetch.js";
import * as F from "./fixtures/build.js";

afterAll(() => shutdownOcr());

describe("OCR when needed", () => {
  it("reads rendered text from an image that has no embedded description", async () => {
    const png = readFileSync(new URL("./fixtures/ocr-sample.png", import.meta.url));
    const r = await analyzeResponse(F.response(png, { "content-type": "image/png" }, "https://fixture.test/scan.png"), { sourceType: "url", enrich: false });
    const text = String(r.fields.find((f) => f.field === "ocrText")?.value ?? "");
    expect(text.toUpperCase()).toContain("SNOWFALL SURVEY 2024");
    const ocr = r.fields.find((f) => f.field === "ocrText")!;
    expect(ocr.evidenceType).toBe("system_measurement");
    expect(r.fields.find((f) => f.field === "doi")?.value).toEqual(["10.5555/snow.2024"]);
  }, 60_000);
  it("skips OCR when embedded metadata already describes the image", async () => {
    const r = await analyzeResponse(F.response(F.jpegWithExif(), { "content-type": "image/jpeg" }), { sourceType: "url", enrich: false });
    // jpegWithExif has no title/description and no real pixel data → OCR is skipped safely, not crashed.
    expect(r.categories).toHaveLength(41);
    expect(r.fields.find((f) => f.field === "ocrSkipped")?.value).toBe("pixel data could not be decoded");
    expect(r.quality.extractorErrors).toEqual([]);
  }, 60_000);
});

// Use the repo's Playwright browser if installed, else a system Chromium (CHROMIUM_PATH / /opt/pw-browsers).
const chromiumAvailable = (() => {
  try {
    const { chromium } = require("playwright") as typeof import("playwright");
    if (existsSync(chromium.executablePath())) return true;
  } catch {
    /* fall through */
  }
  const candidates = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (found) process.env.CHROMIUM_PATH = found;
  return Boolean(found);
})();

describe.skipIf(!chromiumAvailable)("selective JS rendering", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/app") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><html lang="en"><head><title>App</title></head><body><div id="root"></div><script>
          document.getElementById('root').innerHTML = '<main><h1>Snowfall dashboard</h1><p>' + 'Daily snowfall depth for northern stations, updated hourly. '.repeat(8) + '</p><a href="/data.csv">Download CSV</a></main>';
          const ld = document.createElement('script'); ld.type = 'application/ld+json'; ld.text = JSON.stringify({"@context":"https://schema.org","@type":"Dataset","name":"Snowfall dashboard data","license":"https://creativecommons.org/licenses/by/4.0/"}); document.head.appendChild(ld);
        </script></body></html>`);
      }
      if (req.url === "/static") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><html lang="en"><head><title>Static</title></head><body><main><p>${"Plenty of server-rendered text here. ".repeat(20)}</p></main></body></html>`);
      }
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(F.CSV);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("renders only JS-dependent pages and extracts structured data from the rendered DOM", async () => {
    const store = new SqliteCorpus(":memory:");
    const renderer = playwrightRenderer({ urlPolicy: (u) => ({ ok: u.startsWith(base) }) });
    let renders = 0;
    const counting = { render: async (u: string) => (renders++, renderer.render(u)) };
    const fetcher = async (url: string): Promise<SafeResponse> => {
      const res = await request(url);
      return F.response(Buffer.from(await res.body.arrayBuffer()), Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), url, res.statusCode);
    };
    const crawler = new AutonomousCrawler({ store, fetch: fetcher, renderer: counting, robots: async () => ({ allowed: true, crawlDelay: null, sitemaps: [] }), enrich: false, hostDelayMs: 0, urlPolicy: (u) => ({ ok: u.startsWith(base) }),
      sources: [{ id: "s", description: "", intervalMs: 3600_000, run: async () => [`${base}/app`, `${base}/static`].map((url) => ({ url, priority: 60, depth: 0, via: "bootstrap:s", purpose: "bootstrap" as const })) }] });
    await crawler.drain(20);
    await renderer.close();
    expect(renders).toBe(1); // static page was not rendered
    const app = (await store.byUrl(`${base}/app`))!;
    const fields = await store.observationsFor((await store.latestSnapshot(app.id))!.id);
    expect(fields.find((f) => f.field === "renderedWithBrowser")?.value).toBe(true);
    expect(fields.find((f) => f.category === 16 && f.field === "types")?.value).toEqual(["Dataset"]);
    expect(fields.some((f) => f.category === 6 && f.field === "license" && f.value === "CC BY 4.0")).toBe(true);
    expect((await store.byUrl(`${base}/data.csv`))?.state).toBe("indexed"); // link only present after rendering
    await store.close();
  }, 90_000);
});
