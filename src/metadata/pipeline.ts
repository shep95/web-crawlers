import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";
import { CATEGORIES, CATEGORY_BY_ID, C, categoryApplies, type FieldType } from "./categories.js";
import { FieldCollector, type ExtractionContext, type ExtractionInput, type Extractor } from "./extractor.js";
import { parseJsonLdBlocks } from "./jsonld.js";
import { decodeBody, sniffKind } from "./normalize.js";
import { EXTRACTORS } from "./extractors/index.js";
import type { CategoryCoverage, MetadataField, QualityReport, ResourceKind, ResourceRecord } from "./types.js";
import { DEFAULT_USER_AGENT, FetchBlockedError, getEgressMode, safeFetch, type SafeResponse } from "../net/safe-fetch.js";
import { LruCache, Semaphore } from "../util/async.js";

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as (url: string, txt: string) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
};

export const PIPELINE_VERSION = "2.0.0";

export interface AnalyzeOptions {
  /** Run network enrichment extractors (DNS, TLS, Wayback, Crossref, GitHub, HF). Default true. */
  enrich?: boolean;
  /** Bypass the in-memory result cache. */
  fresh?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Restrict to these category ids in the output (all are still evaluated). */
  categories?: number[];
}

const MAX_BYTES = Number(process.env.MAX_FETCH_BYTES ?? 25 * 1024 * 1024);
const MAX_PARSE_CHARS = 6 * 1024 * 1024;
const cache = new LruCache<ResourceRecord>(Number(process.env.RESULT_CACHE_SIZE ?? 300), Number(process.env.RESULT_CACHE_TTL_MS ?? 10 * 60_000));
const robotsCache = new LruCache<ReturnType<typeof robotsParser> | null>(2000, 30 * 60_000);
/** Bounds concurrent analyses so a burst cannot exhaust container memory. */
export const analysisSlots = new Semaphore(Number(process.env.MAX_CONCURRENT_ANALYSES ?? 6));

export class AnalysisError extends Error {
  constructor(
    public code: "EGRESS_BLOCKED" | "ROBOTS_DISALLOWED" | "FETCH_FAILED" | "INVALID_URL",
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

export async function robotsFor(url: string): Promise<ReturnType<typeof robotsParser> | null> {
  const origin = new URL(url).origin;
  const hit = robotsCache.get(origin);
  if (hit !== undefined) return hit.value;
  let parser: ReturnType<typeof robotsParser> | null = null;
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { maxBytes: 512 * 1024, timeoutMs: 5000, accept: "text/plain,*/*" });
    // RFC 9309: 4xx → no restrictions; 5xx/unreachable → treat as full disallow.
    if (res.status >= 200 && res.status < 300) parser = robotsParser(`${origin}/robots.txt`, res.body.toString("utf8"));
    else if (res.status >= 500) parser = robotsParser(`${origin}/robots.txt`, "User-agent: *\nDisallow: /");
  } catch (err) {
    if (err instanceof FetchBlockedError) throw err;
    parser = null; // network error fetching robots: conservative but not blocking single lookups
  }
  robotsCache.set(origin, parser);
  return parser;
}

export async function robotsAllows(url: string): Promise<{ allowed: boolean | null; crawlDelay: number | null; sitemaps: string[] }> {
  const p = await robotsFor(url);
  if (!p) return { allowed: null, crawlDelay: null, sitemaps: [] };
  return { allowed: p.isAllowed(url, DEFAULT_USER_AGENT) ?? true, crawlDelay: p.getCrawlDelay(DEFAULT_USER_AGENT) ?? null, sitemaps: p.getSitemaps().slice(0, 20) };
}

function cacheKey(url: string, opts: AnalyzeOptions) {
  return `${url}|${opts.enrich !== false}`;
}

/** Fetch and analyse a public URL. */
export async function analyzeUrl(rawUrl: string, opts: AnalyzeOptions = {}): Promise<ResourceRecord> {
  let url: string;
  try {
    url = new URL(rawUrl.trim()).toString();
  } catch {
    throw new AnalysisError("INVALID_URL", "Not a valid absolute URL", 400);
  }
  const key = cacheKey(url, opts);
  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit) {
      return filterCategories({ ...hit.value, processing: { ...hit.value.processing, cache: "hit", cachedAgeSeconds: Math.round(hit.ageMs / 1000) } }, opts);
    }
  }
  return analysisSlots.run(async () => {
    let robots: Awaited<ReturnType<typeof robotsAllows>>;
    try {
      robots = await robotsAllows(url);
    } catch (err) {
      if (err instanceof FetchBlockedError) throw new AnalysisError("EGRESS_BLOCKED", err.message, 403);
      throw err;
    }
    if (robots.allowed === false) {
      throw new AnalysisError("ROBOTS_DISALLOWED", `robots.txt disallows ${DEFAULT_USER_AGENT.split(" ")[0]} from fetching this URL`, 451);
    }
    let response: SafeResponse;
    try {
      response = await safeFetch(url, { maxBytes: opts.maxBytes ?? MAX_BYTES, timeoutMs: opts.timeoutMs ?? 25_000, signal: opts.signal });
    } catch (err) {
      if (err instanceof FetchBlockedError) throw new AnalysisError("EGRESS_BLOCKED", err.message, 403);
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as NodeJS.ErrnoException).code;
      if (cause === "EGRESS_BLOCKED") throw new AnalysisError("EGRESS_BLOCKED", (err as Error).message, 403);
      throw new AnalysisError("FETCH_FAILED", `Fetch failed: ${(err as Error).message}${cause ? ` (${cause})` : ""}`, 502);
    }
    // Redirect target may live under a different robots.txt.
    if (new URL(response.finalUrl).origin !== new URL(url).origin) {
      const r2 = await robotsAllows(response.finalUrl).catch(() => null);
      if (r2?.allowed === false) throw new AnalysisError("ROBOTS_DISALLOWED", `robots.txt at redirect target disallows ${response.finalUrl}`, 451);
    }
    const record = await analyzeResponse(response, { sourceType: "url", enrich: opts.enrich !== false });
    record.robots = robots;
    record.fields.push({
      category: C.discovery,
      field: "robotsAllowed",
      value: robots.allowed,
      status: "observed",
      method: "robots.txt (RFC 9309)",
      extractor: `pipeline@${PIPELINE_VERSION}`,
      evidence: robots.allowed === null ? "no robots.txt (or unreachable) — no restrictions declared" : undefined,
      sensitivity: "public",
      evidenceType: "system_measurement",
      scope: "resource",
      observedAt: record.fetchedAt,
    });
    if (robots.sitemaps.length) record.fields.push({ category: C.discovery, field: "sitemaps", value: robots.sitemaps, status: "source_declared", method: "robots.txt Sitemap:", extractor: `pipeline@${PIPELINE_VERSION}`, sensitivity: "public", evidenceType: "source_claim", scope: "site", observedAt: record.fetchedAt });
    if (robots.crawlDelay) record.fields.push({ category: C.discovery, field: "crawlDelay", value: robots.crawlDelay, status: "source_declared", method: "robots.txt Crawl-delay", extractor: `pipeline@${PIPELINE_VERSION}`, sensitivity: "public", evidenceType: "source_claim", scope: "site", observedAt: record.fetchedAt });
    record.categories = coverage(record.fields, record.kind, record.processing.extractors, record.httpStatus);
    cache.set(key, record);
    return filterCategories(record, opts);
  });
}

/** Analyse a user-provided file (no network fetch of the content itself). */
export async function analyzeUpload(body: Buffer, meta: { filename?: string | null; contentType?: string | null }): Promise<ResourceRecord> {
  return analysisSlots.run(async () => {
    const now = new Date().toISOString();
    const pseudoUrl = `upload://local/${encodeURIComponent(meta.filename ?? "file")}`;
    const response: SafeResponse = {
      requestedUrl: pseudoUrl,
      finalUrl: pseudoUrl,
      status: 200,
      headers: meta.contentType ? { "content-type": meta.contentType } : {},
      body,
      truncated: false,
      encodedBytes: body.length,
      redirects: [],
      remoteAddress: null,
      timings: { startedAt: now, ttfbMs: 0, totalMs: 0 },
      egress: getEgressMode(),
    };
    return analyzeResponse(response, { sourceType: "upload", filename: meta.filename ?? null, enrich: false });
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Core: run every applicable extractor over a fetched (or uploaded) response. */
export async function analyzeResponse(
  response: SafeResponse,
  opts: { sourceType: "url" | "upload"; filename?: string | null; enrich: boolean; extractors?: Extractor[]; onShared?: (shared: Map<string, unknown>) => void },
): Promise<ResourceRecord> {
  const started = Date.now();
  const observedAt = new Date().toISOString();
  const declared = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? null;
  const { kind, sniffed } = sniffKind(response.body, declared, opts.filename ?? response.finalUrl);
  const collector = new FieldCollector(observedAt);
  const input: ExtractionInput = { url: response.finalUrl, response, kind, sniffedType: sniffed, sourceType: opts.sourceType, filename: opts.filename, network: opts.enrich };

  let textCache: Promise<string> | null = null;
  let domCache: Promise<cheerio.CheerioAPI> | null = null;
  let ldCache: Promise<Record<string, unknown>[]> | null = null;
  const shared = new Map<string, unknown>();
  const text = () => (textCache ??= decodeBody(response.body, response.headers["content-type"] ?? null).then((d) => {
    shared.set("charset", d.charset);
    return d.text;
  }));
  const dom = () => (domCache ??= text().then((t) => cheerio.load(t.slice(0, MAX_PARSE_CHARS), { xml: kind === "xml" || kind === "feed" ? { xmlMode: true, decodeEntities: true } : false })));
  const jsonLd = () => (ldCache ??= dom().then(($) => {
    const blocks = $('script[type="application/ld+json" i]').map((_, el) => $(el).text()).get().slice(0, 30);
    const parsed = parseJsonLdBlocks(blocks);
    shared.set("jsonld.contexts", parsed.contexts);
    shared.set("jsonld.errors", parsed.errors);
    return parsed.nodes;
  }));

  const runs: ResourceRecord["processing"]["extractors"] = [];
  const all = opts.extractors ?? EXTRACTORS;
  // Error responses (404/5xx...) carry an error page, not the resource: only transport-level extractors run.
  const errorPage = opts.sourceType === "url" && response.status >= 400;
  const applicable = all.filter((e) => (e.kinds === "all" || e.kinds.includes(kind)) && (!e.needsNetwork || opts.enrich) && (!errorPage || e.kinds === "all"));

  const exec = async (ex: Extractor) => {
    const tag = `${ex.id}@${ex.version}`;
    const ctx: ExtractionContext = {
      ...input,
      observedAt,
      text,
      dom,
      jsonLd,
      shared,
      fields: () => collector.fields,
      add: (category, field, value, o) => collector.add(tag, category, field, value, o),
      relate: (type, target, evidence, method, status) => collector.relate(type, target, evidence, method, status),
    };
    const t0 = Date.now();
    const before = collector.fields.length;
    try {
      await withTimeout(ex.run(ctx, tag), ex.timeoutMs, tag);
      runs.push({ id: tag, ms: Date.now() - t0, fields: collector.fields.length - before });
    } catch (err) {
      // Isolation: one malformed resource or failing source never aborts the whole record.
      runs.push({ id: tag, ms: Date.now() - t0, fields: collector.fields.length - before, error: String((err as Error | undefined)?.message ?? err ?? "unknown error").slice(0, 300) });
    }
  };
  // HTML first (it populates shared plain text used by privacy/retention), then the rest in parallel.
  const local = applicable.filter((e) => (e.phase ?? "local") === "local");
  const html = local.find((e) => e.id === "html");
  if (html) await exec(html);
  await Promise.all(local.filter((e) => e !== html).map(exec));
  await Promise.all(applicable.filter((e) => e.phase === "enrich").map(exec));

  opts.onShared?.(shared);
  const charset = shared.get("charset") as string | undefined;
  if (charset) collector.add(`pipeline@${PIPELINE_VERSION}`, C.technical, "decodedCharset", charset, { status: "observed", method: "charset detection" });
  const ldErrors = shared.get("jsonld.errors") as number | undefined;

  const fields = collector.fields;
  // A failed extractor is itself an observation: the category was inspected and parsing failed.
  for (const r of runs.filter((x) => x.error)) {
    const ex = all.find((e) => `${e.id}@${e.version}` === r.id);
    for (const cat of (ex?.categories ?? []).slice(0, 3)) {
      if (fields.some((f) => f.category === cat)) continue;
      fields.push({ category: cat, field: "extractionError", value: r.error, status: "extraction_failed", method: r.id, extractor: `pipeline@${PIPELINE_VERSION}`, evidence: "parser raised an error on this resource", sensitivity: "public", evidenceType: "system_measurement", scope: "resource", observedAt });
    }
  }
  const quality = assessQuality(fields, kind, runs, collector.duplicates, response, declared, sniffed, ldErrors ?? 0);
  addQualityFields(fields, quality, observedAt);

  const pick = (cat: number, names: string[]) => {
    for (const n of names) {
      const f = fields.find((x) => x.category === cat && x.field === n && typeof x.value === "string");
      if (f) return f.value as string;
    }
    return null;
  };
  const canonical = (fields.find((f) => f.field === "canonical" && f.category === C.web_seo)?.value as string | undefined) ?? response.finalUrl;
  const contentHash = createHash("sha256").update(response.body).digest("hex");
  const record: ResourceRecord = {
    resourceId: createHash("sha256").update(opts.sourceType === "upload" ? contentHash : canonical).digest("hex").slice(0, 20),
    requestedUrl: response.requestedUrl,
    canonicalUrl: canonical,
    finalUrl: response.finalUrl,
    sourceType: opts.sourceType,
    kind,
    mimeType: declared ?? sniffed,
    title: pick(C.descriptive, ["title", "headline"]) ?? pick(C.document, ["title"]) ?? (opts.filename ?? null),
    description: pick(C.descriptive, ["description"]),
    fetchedAt: response.timings.startedAt,
    httpStatus: opts.sourceType === "url" ? response.status : null,
    contentHash,
    bytes: response.body.length,
    fields,
    categories: [],
    relationships: collector.relationships,
    quality,
    processing: {
      extractors: runs.sort((a, b) => a.id.localeCompare(b.id)),
      totalMs: Date.now() - started + (opts.sourceType === "url" ? response.timings.totalMs : 0),
      fetchMs: opts.sourceType === "url" ? response.timings.totalMs : null,
      egress: opts.sourceType === "url" ? response.egress : "none",
      cache: "miss",
    },
  };
  record.categories = coverage(fields, kind, runs, record.httpStatus);
  return record;
}

const CORE_FIELDS: Partial<Record<ResourceKind, Array<[number, string[]]>>> = {
  webpage: [[C.descriptive, ["title"]], [C.descriptive, ["description"]], [C.descriptive, ["language"]], [C.temporal, ["published", "modified", "lastModifiedHeader"]], [C.web_seo, ["canonical"]], [C.descriptive, ["author"]], [C.rights, ["license", "copyright"]], [C.provenance, ["publisher", "siteName"]]],
  pdf: [[C.document, ["title"]], [C.document, ["author"]], [C.temporal, ["created"]], [C.document, ["pageCount"]], [C.descriptive, ["language"]]],
  office: [[C.document, ["title"]], [C.document, ["author"]], [C.temporal, ["created"]], [C.temporal, ["modified"]]],
  image: [[C.image, ["width"]], [C.image, ["height"]], [C.temporal, ["created"]], [C.rights, ["copyright"]], [C.descriptive, ["description", "title"]]],
  audio: [[C.audio, ["duration"]], [C.audio, ["codec"]], [C.audio, ["title"]], [C.audio, ["artist"]]],
  video: [[C.video, ["duration"]], [C.video, ["width"]], [C.audio, ["codec"]], [C.descriptive, ["title"]]],
  json: [[C.schema, ["schemaType", "properties"]], [C.descriptive, ["title"]], [C.descriptive, ["description"]]],
  csv: [[C.schema, ["columns"]], [C.structural, ["rowCount"]]],
  feed: [[C.descriptive, ["title"]], [C.structural, ["itemCount"]], [C.temporal, ["modified"]]],
  email: [[C.email, ["messageId"]], [C.email, ["date"]], [C.email, ["subject"]]],
};

function typeOk(value: unknown, t: FieldType): boolean {
  switch (t) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "date": return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "url": return typeof value === "string" && /^https?:\/\//.test(value);
    case "array": return Array.isArray(value);
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}

function assessQuality(
  fields: MetadataField[],
  kind: ResourceKind,
  runs: ResourceRecord["processing"]["extractors"],
  duplicates: number,
  response: SafeResponse,
  declared: string | null,
  sniffed: string,
  jsonLdErrors: number,
): QualityReport {
  const notes: string[] = [];
  const core = CORE_FIELDS[kind] ?? [[C.descriptive, ["title"]]];
  const present: string[] = [];
  const missing: string[] = [];
  for (const [cat, names] of core) {
    const label = `${CATEGORY_BY_ID.get(cat)!.key}.${names[0]}`;
    (fields.some((f) => f.category === cat && names.includes(f.field)) ? present : missing).push(label);
  }

  // Schema validation against the registry (declared fields only; extra fields are allowed).
  for (const f of fields) {
    const t = CATEGORY_BY_ID.get(f.category)!.fields[f.field];
    if (t && !typeOk(f.value, t)) {
      notes.push(`schema: ${CATEGORY_BY_ID.get(f.category)!.key}.${f.field} expected ${t}`);
      f.status = f.status === "observed" ? "observed" : "extraction_failed";
    }
  }

  const contradictions: QualityReport["contradictions"] = [];
  const flag = (field: string, fs: MetadataField[]) => {
    contradictions.push({ field, values: fs.map((f) => ({ value: f.value, method: f.method })) });
    for (const f of fs) if (f.status === "source_declared") f.status = "contradicted";
  };
  // Publication dates from different declarations disagreeing by > 1 day.
  const pub = fields.filter((f) => f.category === C.temporal && f.field === "published");
  if (pub.length > 1) {
    const ts = pub.map((f) => Date.parse(String(f.value)));
    if (Math.max(...ts) - Math.min(...ts) > 86400_000) flag("temporal.published", pub);
  }
  const mod = fields.filter((f) => f.category === C.temporal && f.field === "modified").map((f) => Date.parse(String(f.value)));
  if (pub.length && mod.length && Math.max(...mod) + 86400_000 < Math.min(...pub.map((f) => Date.parse(String(f.value))))) {
    flag("temporal.modified<published", fields.filter((f) => f.category === C.temporal && (f.field === "modified" || f.field === "published")));
  }
  const langs = fields.filter((f) => f.category === C.descriptive && f.field === "language" && typeof f.value === "string");
  const primary = new Set(langs.map((f) => String(f.value).toLowerCase().split(/[-_,\s]/)[0]));
  if (primary.size > 1) flag("descriptive.language", langs);
  const licenses = fields.filter((f) => f.category === C.rights && f.field === "license" && f.status !== "inferred");
  if (new Set(licenses.map((f) => String(f.value).toLowerCase().replace(/[^a-z0-9.]/g, ""))).size > 1) flag("rights.license", licenses);
  const registry = fields.find((f) => f.field === "registryTitle" && f.status === "contradicted");
  if (registry) contradictions.push({ field: "scientific.registryTitle", values: [{ value: registry.value, method: registry.method }] });

  const canonical = fields.find((f) => f.category === C.web_seo && f.field === "canonical")?.value as string | undefined;
  if (canonical && new URL(canonical).hostname !== new URL(response.finalUrl).hostname) notes.push(`canonical points to a different host (${new URL(canonical).hostname})`);
  if (response.status >= 400) notes.push(`HTTP ${response.status}: response is an error page — content extractors were skipped`);
  if (response.truncated) notes.push("body truncated at byte cap; some metadata may be missing");
  if (jsonLdErrors) notes.push(`${jsonLdErrors} JSON-LD block(s) failed to parse`);
  const kindOfDeclared = declared ? sniffKind(Buffer.alloc(0), declared, "").kind : null;
  const mismatch = declared && kindOfDeclared !== "text" && kindOfDeclared !== kind && !(kind === "feed" && /xml/.test(declared)) && !(kind === "webpage" && /xml/.test(declared));
  if (mismatch) notes.push(`declared Content-Type ${declared} but content sniffs as ${sniffed}`);

  return {
    completeness: core.length ? Number((present.length / core.length).toFixed(3)) : 1,
    coreFieldsPresent: present,
    coreFieldsMissing: missing,
    contradictions,
    extractorErrors: runs.filter((r) => r.error).map((r) => ({ extractor: r.id, error: r.error! })),
    duplicatesCollapsed: duplicates,
    bodyTruncated: response.truncated,
    declaredVsSniffedType: mismatch ? { declared, sniffed } : undefined,
    notes,
  };
}

function addQualityFields(fields: MetadataField[], q: QualityReport, observedAt: string) {
  const add = (field: string, value: unknown, method: string, evidence?: string) =>
    fields.push({ category: C.quality, field, value, status: "observed", method, extractor: `pipeline@${PIPELINE_VERSION}`, evidence, sensitivity: "public", evidenceType: "system_measurement", scope: "resource", observedAt });
  add("completeness", q.completeness, "core fields present ÷ core fields for kind", `present: ${q.coreFieldsPresent.join(", ") || "none"}; missing: ${q.coreFieldsMissing.join(", ") || "none"}`);
  add("contradictionCount", q.contradictions.length, "cross-declaration consistency checks");
  add("extractorErrorCount", q.extractorErrors.length, "extractor run results");
  add("truncated", q.bodyTruncated, "byte cap");
  add("duplicatesCollapsed", q.duplicatesCollapsed, "identical value de-duplication");
}

export function coverage(
  fields: MetadataField[],
  kind: ResourceKind,
  runs: ResourceRecord["processing"]["extractors"],
  httpStatus: number | null,
): CategoryCoverage[] {
  const counts = new Map<number, number>();
  for (const f of fields) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const failedExtractors = new Set(runs.filter((r) => r.error).map((r) => r.id.split("@")[0]));
  const denied = httpStatus === 401 || httpStatus === 403 || httpStatus === 407;
  return CATEGORIES.map((def) => {
    const n = counts.get(def.id) ?? 0;
    const applies = categoryApplies(def.id, kind);
    let state: CategoryCoverage["state"];
    let note: string | undefined;
    if (n > 0) state = "observed";
    else if (!applies) state = "not_applicable";
    else if (denied) state = "unavailable";
    else if (httpStatus !== null && httpStatus >= 400) {
      state = "extraction_failed";
      note = `HTTP ${httpStatus}`;
    }
    else {
      const responsible = EXTRACTORS.filter((e) => e.categories.includes(def.id) && (e.kinds === "all" || e.kinds.includes(kind))).map((e) => e.id);
      if (responsible.length && responsible.every((id) => failedExtractors.has(id))) {
        state = "extraction_failed";
        note = `failed: ${responsible.join(", ")}`;
      } else state = "not_found_after_inspection";
    }
    return { id: def.id, key: def.key, name: def.name, state, fieldCount: n, note };
  });
}

function filterCategories(record: ResourceRecord, opts: AnalyzeOptions): ResourceRecord {
  if (!opts.categories?.length) return record;
  const want = new Set(opts.categories);
  return { ...record, fields: record.fields.filter((f) => want.has(f.category)) };
}
