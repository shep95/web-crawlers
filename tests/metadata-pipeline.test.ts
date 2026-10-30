import { describe, expect, it } from "vitest";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import { CATEGORIES } from "../src/metadata/categories.js";
import { EXTRACTORS } from "../src/metadata/extractors/index.js";
import type { ResourceRecord } from "../src/metadata/types.js";
import * as F from "./fixtures/build.js";

const run = (body: Buffer | string, headers: Record<string, string> = {}, url?: string, status?: number) =>
  analyzeResponse(F.response(body, headers, url, status), { sourceType: "url", enrich: false });

const vals = (r: ResourceRecord, cat: number, field: string) => r.fields.filter((f) => f.category === cat && f.field === field);
const val = (r: ResourceRecord, cat: number, field: string) => vals(r, cat, field)[0]?.value;
const state = (r: ResourceRecord, id: number) => r.categories.find((c) => c.id === id)!.state;

describe("registry", () => {
  it("defines exactly 41 unique categories with schema, methods and limitations", () => {
    expect(CATEGORIES).toHaveLength(41);
    expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(41);
    expect(new Set(CATEGORIES.map((c) => c.key)).size).toBe(41);
    for (const c of CATEGORIES) {
      expect(Object.keys(c.fields).length, c.key).toBeGreaterThan(0);
      expect(c.methods.length, c.key).toBeGreaterThan(0);
      expect(c.limitations.length, c.key).toBeGreaterThan(10);
    }
  });
  it("every category is declared by at least one extractor", () => {
    const declared = new Set(EXTRACTORS.flatMap((e) => e.categories));
    const pipelineOwned = new Set([20]); // data quality is computed by the pipeline itself
    for (const c of CATEGORIES) expect(declared.has(c.id) || pipelineOwned.has(c.id), c.key).toBe(true);
  });
});

describe("HTML webpage extraction", async () => {
  const r = await run(F.HTML_RICH, { "content-type": "text/html; charset=utf-8", "last-modified": "Tue, 01 Apr 2025 10:00:00 GMT", etag: '"abc"', "strict-transport-security": "max-age=1", "set-cookie": "sid=secret; HttpOnly", "x-robots-tag": "noarchive" }, "https://fixture.test/datasets/gtd-2025");

  it("detects kind and title/description", () => {
    expect(r.kind).toBe("webpage");
    expect(r.title).toBe("Global Temperature Dataset 2025 | Example Climate Institute");
    expect(r.description).toContain("temperature anomalies");
  });
  it("extracts descriptive, SEO and social-sharing metadata with provenance", () => {
    const desc = vals(r, 1, "description");
    expect(desc.length).toBeGreaterThan(0);
    expect(desc[0].method).toBe("html.meta[name=description]");
    expect(desc[0].status).toBe("source_declared");
    expect(desc[0].extractor).toMatch(/^html@/);
    expect(val(r, 26, "canonical")).toBe("https://fixture.test/datasets/gtd-2025");
    expect(val(r, 26, "hreflang")).toEqual([{ lang: "fr", href: "https://fixture.test/fr/datasets/gtd-2025" }]);
    expect((val(r, 27, "openGraph") as Record<string, string>).site_name).toBe("Example Climate Institute");
    expect(val(r, 27, "previewImage")).toBe("https://fixture.test/img/og.png");
    expect(val(r, 25, "feeds")).toEqual(["https://fixture.test/feed.xml"]);
    expect(val(r, 25, "robotsDirectives")).toEqual(["index", "follow"]);
    expect(val(r, 25, "xRobotsTag")).toBe("noarchive");
  });
  it("parses JSON-LD Dataset into statistical, spatial, lineage, version, usage and social categories", () => {
    expect(val(r, 19, "variables")).toEqual(["temperature anomaly (°C)", "uncertainty"]);
    expect(val(r, 13, "spatialCoverage")).toBe("Global");
    expect(val(r, 13, "coordinates")).toEqual({ lat: 40.7128, lon: -74.006 });
    expect(val(r, 9, "derivedFrom")).toEqual(["https://fixture.test/datasets/gtd-2024"]);
    expect(val(r, 11, "version")).toBe("3.0");
    expect(val(r, 23, "interactionCounts")).toEqual([{ type: "DownloadAction", count: 5120 }]);
    expect(val(r, 24, "rating")).toEqual({ value: 4.5, count: 12, best: null });
    expect(val(r, 3, "maintainer")).toBe("Data Office");
    expect(val(r, 21, "lei")).toBe("5493001KJTIIGC8Y1R12");
    expect(val(r, 7, "isAccessibleForFree")).toBe(true);
    expect(val(r, 40, "expires")).toBe("2030-01-01T00:00:00.000Z");
    expect(val(r, 35, "instrument")).toContain("Weather station");
    expect(val(r, 16, "types")).toEqual(expect.arrayContaining(["Dataset", "Organization", "BreadcrumbList"]));
  });
  it("normalises dates to UTC ISO while keeping the original", () => {
    const pub = vals(r, 12, "published").find((f) => f.method.includes("datePublished"))!;
    expect(pub.value).toBe("2025-03-10T00:00:00.000Z");
    expect(pub.original).toBe("2025-03-10");
    expect(val(r, 12, "lastModifiedHeader")).toBe("2025-04-01T10:00:00.000Z");
  });
  it("flags contradictory publication dates instead of hiding them", () => {
    // JSON-LD says 2025-03-10, article:published_time says 2025-03-14.
    expect(r.quality.contradictions.map((c) => c.field)).toContain("temporal.published");
    expect(vals(r, 12, "published").every((f) => f.status === "contradicted")).toBe(true);
  });
  it("validates identifiers with checksums", () => {
    expect(val(r, 14, "doi")).toEqual(["10.1234/climate.2025.001"]);
    expect(vals(r, 14, "isbn").flatMap((f) => f.value as string[])).toContain("9780306406157");
    expect(vals(r, 14, "orcid").flatMap((f) => f.value as string[])).toContain("0000-0002-1825-0097");
    expect(vals(r, 14, "arxiv").flatMap((f) => f.value as string[])).toContain("2101.00001");
  });
  it("extracts scholarly citation metadata", () => {
    expect(val(r, 36, "journal")).toBe("Journal of Climate Data");
    expect(val(r, 36, "publicationDate")).toBe("2025-03-14T00:00:00.000Z");
  });
  it("records rights from rel=license, JSON-LD and © notice", () => {
    expect(vals(r, 6, "license").map((f) => f.value)).toContain("CC BY 4.0");
    expect(vals(r, 6, "copyright").some((f) => String(f.value).startsWith("© 2025 Example Climate Institute"))).toBe(true);
    expect(r.relationships.some((x) => x.type === "licensed_under" && x.target.includes("creativecommons.org"))).toBe(true);
  });
  it("audits accessibility signals without claiming conformance", () => {
    expect(val(r, 38, "imagesTotal")).toBe(3);
    expect(val(r, 38, "imagesWithAlt")).toBe(2);
    expect(val(r, 38, "captionTracks")).toBe(1);
    expect(val(r, 38, "labelledInputs")).toBe(1);
    expect(val(r, 38, "skipLink")).toBe(true);
  });
  it("reports form constraints and login forms", () => {
    const cons = val(r, 18, "formConstraints") as Array<Record<string, unknown>>;
    expect(cons).toEqual(expect.arrayContaining([expect.objectContaining({ name: "email", required: true, maxlength: "120" }), expect.objectContaining({ name: "age", min: "0", max: "120" })]));
    expect(val(r, 7, "hasLoginForm")).toBe(true);
  });
  it("counts personal data without returning it", () => {
    const pii = val(r, 39, "personalDataIndicators") as Record<string, number>;
    expect(pii.emails).toBe(1);
    expect(pii.phones).toBe(1);
    expect(JSON.stringify(r.fields)).not.toContain("data-office@fixture.test");
    expect(JSON.stringify(r.fields)).not.toContain("sid=secret");
    expect(val(r, 39, "privacyPolicyUrl")).toBe("https://fixture.test/privacy");
    expect(val(r, 39, "thirdPartyScriptDomains")).toEqual(["cdn.example-cdn.net"]);
  });
  it("finds retention statements, SRI, relationships and structure", () => {
    expect((val(r, 40, "retentionStatements") as string[])[0]).toContain("90 days");
    expect(val(r, 41, "sriScripts")).toBe(1);
    expect(r.relationships.map((x) => x.type)).toEqual(expect.arrayContaining(["canonical", "alternate_language", "feed", "same_as", "derived_from", "cites", "next", "alternate_format"]));
    expect(val(r, 2, "breadcrumbs")).toEqual(["Home", "Datasets"]);
    expect(val(r, 15, "outboundDomains")).toEqual(expect.arrayContaining([expect.objectContaining({ domain: "other.test" })]));
  });
  it("reports JSON-LD parse failures as quality notes and every field validates against the registry schema", () => {
    expect(r.quality.notes.join(" ")).toMatch(/JSON-LD block\(s\) failed to parse/);
    expect(r.quality.notes.filter((n) => n.startsWith("schema:"))).toEqual([]);
  });
  it("marks media categories not applicable to a webpage", () => {
    expect(state(r, 29)).toBe("not_applicable");
    expect(state(r, 33)).toBe("not_applicable");
    expect(state(r, 1)).toBe("observed");
  });
});

describe("error responses", () => {
  it("does not mine 404 pages as if they were the resource", async () => {
    const r = await run("<html><head><title>Not Found</title></head></html>", { "content-type": "text/html" }, "https://fixture.test/missing", 404);
    expect(vals(r, 1, "title")).toHaveLength(0);
    expect(r.quality.notes.join()).toContain("HTTP 404");
    expect(state(r, 1)).toBe("extraction_failed");
  });
  it("marks 401/403 categories as not publicly accessible", async () => {
    const r = await run("{}", { "content-type": "application/json", "www-authenticate": "Bearer" }, "https://fixture.test/private", 401);
    expect(val(r, 7, "accessRequiresAuth")).toBe(true);
    expect(state(r, 17)).toBe("unavailable");
  });
});

describe("structured data formats", () => {
  it("JSON Schema → schema + constraints + semantic field descriptions", async () => {
    const r = await run(F.JSON_SCHEMA, { "content-type": "application/schema+json" });
    expect(r.kind).toBe("json");
    expect(val(r, 17, "schemaType")).toMatch(/^JSON Schema/);
    expect(val(r, 18, "required")).toEqual(["name", "age"]);
    expect(val(r, 18, "enums")).toEqual([{ path: "status", values: ["active", "inactive"] }]);
    expect(val(r, 18, "ranges")).toEqual(expect.arrayContaining([{ path: "age", minimum: 0, maximum: 120 }]));
    expect(val(r, 18, "patterns")).toEqual([{ path: "zip", pattern: "^[0-9]{5}$" }]);
    expect(val(r, 16, "fieldDescriptions")).toEqual(expect.arrayContaining([{ field: "age", description: "Age in years" }]));
  });
  it("OpenAPI → API paths, version, licence, security schemes, servers", async () => {
    const r = await run(F.OPENAPI, { "content-type": "application/json" });
    expect(val(r, 17, "schemaType")).toBe("OpenAPI 3.1.0");
    expect(val(r, 17, "apiPaths")).toBe(2);
    expect(val(r, 11, "version")).toBe("2.4.1");
    expect(val(r, 6, "license")).toBe("Apache 2.0");
    expect(val(r, 7, "securitySchemes")).toEqual([{ name: "bearer", type: "http", scheme: "bearer" }]);
    expect(val(r, 34, "declaredServers")).toEqual(["https://api.pets.test/v2"]);
  });
  it("Data Package → columns, constraints, lineage, licence", async () => {
    const r = await run(F.DATAPACKAGE, { "content-type": "application/json" });
    expect(val(r, 17, "schemaType")).toBe("Frictionless Data Package");
    expect((val(r, 17, "columns") as unknown[]).length).toBe(2);
    expect(val(r, 9, "sources")).toEqual(["National Weather Service"]);
    expect(val(r, 6, "license")).toBe("ODC-PDDL-1.0");
    expect(val(r, 18, "primaryKey")).toEqual([{ resource: "obs", key: ["station"] }]);
  });
  it("model config.json → AI/ML architecture", async () => {
    const r = await run(F.HF_CONFIG, { "content-type": "application/json" });
    expect(val(r, 37, "architectures")).toEqual(["BertForMaskedLM"]);
    expect(val(r, 37, "modelType")).toBe("bert");
  });
  it("CSV → inferred column types, statistics and null rates (labelled inferred)", async () => {
    const r = await run(F.CSV, { "content-type": "text/csv" });
    expect(r.kind).toBe("csv");
    expect(val(r, 2, "rowCount")).toBe(4);
    const cols = val(r, 17, "columns") as Array<{ name: string; type: string }>;
    expect(cols).toEqual([{ name: "station", type: "string" }, { name: "date", type: "date" }, { name: "mm", type: "number" }, { name: "flag", type: "string" }]);
    expect(vals(r, 17, "columns")[0].status).toBe("inferred");
    const mm = (val(r, 19, "columnStats") as Array<Record<string, number>>).find((c) => c.name === "mm")!;
    expect(mm).toMatchObject({ min: 0, max: 7.5, n: 3, nullRate: 0.25 });
    expect(val(r, 20, "nullRate")).toBe(0.125);
  });
  it("RSS → feed metadata, audit change entries and refresh interval", async () => {
    const r = await run(F.RSS, { "content-type": "application/rss+xml" });
    expect(r.kind).toBe("feed");
    expect(val(r, 2, "itemCount")).toBe(3);
    expect(val(r, 12, "modified")).toBe("2025-04-01T10:00:00.000Z");
    expect(val(r, 22, "refreshInterval")).toBe("60");
    expect((val(r, 10, "changeEntries") as unknown[]).length).toBe(3);
  });
  it("sitemap → discovery entries + XSD schema location", async () => {
    const r = await run(F.SITEMAP, { "content-type": "application/xml" });
    expect(val(r, 25, "sitemapEntries")).toBe(2);
    expect(val(r, 17, "xsd")).toEqual(["http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd"]);
    expect(val(r, 12, "modified")).toBe("2025-02-01T00:00:00.000Z");
  });
  it("DataCite XML → DOI, bounding box, rights", async () => {
    const r = await run(F.DATACITE, { "content-type": "application/xml" });
    expect(val(r, 14, "doi")).toEqual(["10.5555/abc"]);
    expect(val(r, 13, "boundingBox")).toEqual({ west: 142, east: 154, south: -24, north: -10 });
    expect(val(r, 6, "rightsStatement")).toBe("CC0");
  });
});

describe("text formats", () => {
  it("model card front matter → AI/ML, lineage, limitations", async () => {
    const r = await run(F.MODEL_CARD, { "content-type": "text/markdown" }, "https://fixture.test/README.md");
    expect(r.kind).toBe("text");
    expect(val(r, 37, "pipelineTag")).toBe("text-classification");
    expect(val(r, 37, "baseModel")).toEqual(["bert-base-uncased"]);
    expect(val(r, 37, "evaluationResults")).toEqual([{ dataset: "IMDB", metric: "accuracy", value: 0.93 }]);
    expect(String(val(r, 37, "limitations"))).toContain("English movie reviews");
    expect(val(r, 6, "license")).toBe("apache-2.0");
    expect(val(r, 1, "title")).toBe("Sentiment BERT");
  });
  it("CITATION.cff → scientific + identifiers", async () => {
    const r = await run(F.CITATION_CFF, { "content-type": "text/plain" });
    expect(val(r, 36, "authors")).toEqual(["Jane Doe"]);
    expect(val(r, 14, "orcid")).toEqual(["0000-0002-1825-0097"]);
    expect(val(r, 14, "doi")).toEqual(["10.5281/zenodo.123456"]);
  });
  it("security.txt → masked contact + expiry", async () => {
    const r = await run(F.SECURITY_TXT, { "content-type": "text/plain" });
    expect(val(r, 7, "securityContact")).toEqual(["mailto:s***@fixture.test"]);
    expect(val(r, 40, "expires")).toBe("2026-12-31T23:59:00.000Z");
  });
  it("SHA256SUMS manifest → published checksums", async () => {
    const r = await run(F.SHA256SUMS, { "content-type": "text/plain" });
    expect((val(r, 41, "publishedChecksums") as unknown[]).length).toBe(2);
  });
  it("email (.eml) → headers with masked addresses, reply chain, DKIM presence", async () => {
    const r = await run(F.EML, { "content-type": "message/rfc822" }, "https://fixture.test/msg.eml");
    expect(r.kind).toBe("email");
    expect(val(r, 33, "messageId")).toBe("<msg-1@sender.test>");
    expect(val(r, 33, "from")).toBe("a***@sender.test");
    expect(val(r, 33, "to")).toEqual(["b***@receiver.test", "c***@receiver.test"]);
    expect(val(r, 33, "receivedHops")).toBe(2);
    expect(val(r, 33, "dkim")).toBe(true);
    expect(val(r, 33, "attachmentNames")).toEqual(["report.pdf"]);
    expect(r.relationships.some((x) => x.type === "references" && x.target === "mid:msg-0@receiver.test")).toBe(true);
    expect(JSON.stringify(r.fields)).not.toContain("alice@sender.test");
  });
});

describe("binary formats (real files)", () => {
  it("JPEG + EXIF → image, device, temporal, rights", async () => {
    const r = await run(F.jpegWithExif(640, 480), { "content-type": "image/jpeg" }, "https://fixture.test/photo.jpg");
    expect(r.kind).toBe("image");
    expect(val(r, 29, "width")).toBe(640);
    expect(val(r, 29, "height")).toBe(480);
    expect(val(r, 29, "make")).toBe("TestMaker");
    expect(val(r, 35, "deviceModel")).toBe("Model X1");
    expect(val(r, 35, "firmware")).toBe("FW 1.02");
    expect(val(r, 6, "copyright")).toBe("(c) Jane 2024");
    expect(val(r, 12, "created")).toBe("2024-06-30T14:22:01.000Z");
  });
  it("PNG → dimensions via header parse", async () => {
    const r = await run(F.png(32, 16), { "content-type": "image/png" });
    expect(val(r, 29, "width")).toBe(32);
    expect(val(r, 29, "format")).toBe("png");
  });
  it("WAV → audio technical metadata", async () => {
    const r = await run(F.wav(2, 8000), { "content-type": "audio/wav" }, "https://fixture.test/a.wav");
    expect(r.kind).toBe("audio");
    expect(val(r, 30, "sampleRate")).toBe(8000);
    expect(val(r, 30, "channels")).toBe(1);
    expect(val(r, 30, "duration")).toBe(2);
  });
  it("PDF → document info, pages, dates", async () => {
    const r = await run(await F.pdf(), { "content-type": "application/pdf" }, "https://fixture.test/report.pdf");
    expect(r.kind).toBe("pdf");
    expect(val(r, 32, "title")).toBe("Annual Report 2024");
    expect(val(r, 32, "author")).toBe("Finance Team");
    expect(val(r, 32, "pageCount")).toBe(2);
    expect(val(r, 12, "created")).toBe("2024-02-01T10:00:00.000Z");
    expect(val(r, 41, "signed")).toBe(false);
    expect(val(r, 4, "pdfVersion")).toMatch(/^1\.\d$/);
  });
  it("DOCX → core/app properties; personal names masked", async () => {
    const r = await run(F.docx(), { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, "https://fixture.test/plan.docx");
    expect(r.kind).toBe("office");
    expect(val(r, 32, "title")).toBe("Project Plan");
    expect(val(r, 32, "pageCount")).toBe(4);
    expect(val(r, 11, "revision")).toBe("7");
    expect(val(r, 21, "organization")).toBe("Acme Corp");
    expect(JSON.stringify(r.fields)).not.toContain("Private Person");
  });
  it("zip bomb with lying size header is capped, not inflated", async () => {
    const before = process.memoryUsage().rss;
    const r = await run(F.zipBomb(), {}, "https://fixture.test/bomb.docx");
    expect(r.kind).toBe("office");
    const errs = vals(r, 32, "parseError");
    expect(errs[0]?.status).toBe("extraction_failed");
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  });
  it("garbage input never throws out of the pipeline", async () => {
    const r = await run(Buffer.from("%PDF-1.7\n garbage garbage"), { "content-type": "application/pdf" });
    expect(r.kind).toBe("pdf");
    expect(r.categories).toHaveLength(41);
  });
});

describe("page text", () => {
  it("keeps block boundaries so adjacent headings, paragraphs and list items never fuse into one word", async () => {
    const r = await run("<!doctype html><html lang=en><head><title>t</title></head><body><h1>Dorset dialect</h1><p>History of it</p><ul><li>one</li><li>two</li></ul></body></html>", { "content-type": "text/html" });
    expect(val(r, 2, "wordCount")).toBe(7);
  });
});
