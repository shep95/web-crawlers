import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CATEGORIES, CATEGORY_EXTENSIONS } from "../metadata/categories.js";
import { EXTRACTORS } from "../metadata/extractors/index.js";
import { AnalysisError, analysisSlots, analyzeUpload, analyzeUrl, PIPELINE_VERSION } from "../metadata/pipeline.js";
import type { ResourceRecord } from "../metadata/types.js";
import { providerHealth } from "../search/engine.js";
import { PROVIDERS } from "../search/providers.js";
import { crawlSite } from "../crawl/site-crawler.js";
import { detectChanges } from "../crawl/changes.js";
import { getEgressMode } from "../net/safe-fetch.js";
import { ApiKeys, ClientRateLimiter, LatencyStats, openSse } from "./guards.js";
import { openApiSpec } from "./openapi.js";
import { registerGeographyRoutes } from "./geo-routes.js";

const bool = z.union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")]);
const AnalyzeQuery = z.object({
  url: z.string().url().max(4096),
  enrich: bool.optional(),
  fresh: bool.optional(),
  categories: z.string().regex(/^\d+(,\d+)*$/).optional(),
});
const CrawlQuery = z.object({
  url: z.string().url().max(4096),
  maxPages: z.coerce.number().int().min(1).max(100).optional(),
  maxDepth: z.coerce.number().int().min(0).max(4).optional(),
  sitemap: bool.optional(),
});
const ExportQuery = AnalyzeQuery.extend({ format: z.enum(["json", "csv", "jsonl"]).default("json") });

export interface V2Deps {
  keys: ApiKeys;
  stats: LatencyStats;
  corsOrigin: string | null;
  startedAt: number;
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(input);
  if (!r.success) {
    void reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return null;
  }
  return r.data;
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AnalysisError) return reply.code(err.status).send({ error: err.code, message: err.message });
  const e = err as Error & { code?: string };
  if (e.code === "OVERLOADED") return reply.code(503).header("retry-after", "5").send({ error: "OVERLOADED", message: "Too many concurrent analyses; retry shortly." });
  reply.log.error({ err: e }, "unhandled");
  return reply.code(500).send({ error: "INTERNAL", message: "Unexpected error" });
}

export function toCsv(record: ResourceRecord): string {
  const esc = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["category_id", "category", "field", "value", "status", "method", "extractor", "evidence", "observed_at"]];
  const names = new Map(CATEGORIES.map((c) => [c.id, c.key]));
  for (const f of record.fields) rows.push([String(f.category), names.get(f.category)!, f.field, esc(f.value), f.status, f.method, f.extractor, f.evidence ?? "", f.observedAt].map((x, i) => (i === 3 ? x : esc(x))));
  return rows.map((r) => r.join(",")).join("\n");
}

export async function registerV2(app: FastifyInstance, deps: V2Deps) {
  const general = new ClientRateLimiter(Number(process.env.RATE_LIMIT_PER_MIN ?? 120));
  const heavy = new ClientRateLimiter(Number(process.env.HEAVY_RATE_LIMIT_PER_MIN ?? 20));
  app.addHook("onClose", async () => {
    general.stop();
    heavy.stop();
  });
  const open = new Set(["/api/v2/openapi.json", "/api/v2/categories", "/api/v2/extractors", "/api/v2/providers", "/api/v2/info", "/api/v2/crawler/pause", "/api/v2/crawler/resume"]);
  const heavyRoutes = new Set(["/api/v2/crawl/stream", "/api/v2/changes", "/api/v2/analyze/upload"]);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/v2/")) return;
    if (deps.keys.enabled && !open.has(path) && !path.startsWith("/api/v2/geography") && !deps.keys.verify(ApiKeys.tokenFrom(req) ?? (req.query as Record<string, string> | undefined)?.key)) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "Provide an API key via Authorization: Bearer <key> or X-API-Key." });
    }
    const limiter = heavyRoutes.has(path) || (path === "/api/v2/analyze" && /[?&]fresh=(1|true)/.test(req.url)) ? heavy : general;
    const r = limiter.check(req.ip);
    reply.header("x-ratelimit-remaining", String(r.remaining));
    if (!r.ok) return reply.code(429).header("retry-after", String(r.retryAfterS)).send({ error: "RATE_LIMITED", retryAfterSeconds: r.retryAfterS });
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url;
    if (route?.startsWith("/api/v2/")) deps.stats.record(`${req.method} ${route}`, reply.elapsedTime, reply.statusCode >= 500);
  });

  // ---------------------------------------------------------------- registry
  app.get("/api/v2/info", async () => ({
    service: "omnispider-metadata",
    apiVersion: "v2",
    pipelineVersion: PIPELINE_VERSION,
    authRequired: deps.keys.enabled,
    egress: getEgressMode(),
    storage: "none (stateless; in-memory caches only)",
    categories: CATEGORIES.length,
    extractors: EXTRACTORS.length,
    providers: PROVIDERS.length,
  }));
  app.get("/api/v2/openapi.json", async (req) => openApiSpec(process.env.PUBLIC_URL ?? `${req.protocol}://${req.headers.host ?? "localhost"}`));
  // Static registry responses are serialised once.
  const categoriesJson = JSON.stringify({ count: CATEGORIES.length, categories: CATEGORIES.map((c) => ({ ...c, supportingDiscovery: CATEGORY_EXTENSIONS[c.id].supportingDiscovery?.source ?? null, validation: CATEGORY_EXTENSIONS[c.id].validation })) });
  app.get("/api/v2/categories", async (_req, reply) => reply.header("cache-control", "public, max-age=3600").type("application/json; charset=utf-8").send(categoriesJson));
  registerGeographyRoutes(app);
  app.get("/api/v2/extractors", async () => ({
    count: EXTRACTORS.length,
    extractors: EXTRACTORS.map((e) => ({ id: e.id, version: e.version, description: e.description, kinds: e.kinds, categories: e.categories, needsNetwork: Boolean(e.needsNetwork), phase: e.phase ?? "local", timeoutMs: e.timeoutMs })),
  }));
  app.get("/api/v2/providers", async () => ({ providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, homepage: p.homepage, types: p.types })), health: providerHealth() }));
  app.get("/api/v2/stats", async () => ({
    uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    memory: process.memoryUsage(),
    analysisSlots: analysisSlots.stats,
    latency: deps.stats.snapshot(),
    providers: providerHealth(),
  }));

  // ---------------------------------------------------------------- analyze
  const analyzeHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const input = req.method === "GET" ? req.query : { ...(req.query as object), ...((req.body as object) ?? {}) };
    const q = parse(AnalyzeQuery, input, reply);
    if (!q) return;
    try {
      const record = await analyzeUrl(q.url, { enrich: q.enrich ?? true, fresh: q.fresh ?? false, categories: q.categories?.split(",").map(Number) });
      reply.header("cache-control", "no-store");
      return record;
    } catch (err) {
      return sendError(reply, err);
    }
  };
  app.get("/api/v2/analyze", analyzeHandler);
  app.post("/api/v2/analyze", analyzeHandler);

  app.post("/api/v2/analyze/upload", { bodyLimit: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024) }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Send the file as the raw request body (application/octet-stream or its own content type)." });
    const filename = typeof req.headers["x-filename"] === "string" ? decodeURIComponent(req.headers["x-filename"]).slice(0, 255) : null;
    // Body is sent as application/octet-stream; the file's own type (if known) travels in X-Content-Type.
    const ct = typeof req.headers["x-content-type"] === "string" ? req.headers["x-content-type"].slice(0, 200) : null;
    try {
      return await analyzeUpload(body, { filename, contentType: ct });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/v2/export", async (req, reply) => {
    const q = parse(ExportQuery, req.query, reply);
    if (!q) return;
    try {
      const record = await analyzeUrl(q.url, { enrich: q.enrich ?? true, categories: q.categories?.split(",").map(Number) });
      const name = `metadata-${record.resourceId}`;
      if (q.format === "csv") return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`).send(toCsv(record));
      if (q.format === "jsonl") return reply.header("content-type", "application/x-ndjson").header("content-disposition", `attachment; filename="${name}.jsonl"`).send(record.fields.map((f) => JSON.stringify({ resource: record.canonicalUrl, ...f })).join("\n"));
      return reply.header("content-disposition", `attachment; filename="${name}.json"`).send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/v2/changes", async (req, reply) => {
    const q = parse(AnalyzeQuery.pick({ url: true }), req.query, reply);
    if (!q) return;
    try {
      return await detectChanges(q.url);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------------------------------------------------------------- crawl
  app.get("/api/v2/crawl/stream", async (req, reply) => {
    const q = parse(CrawlQuery, req.query, reply);
    if (!q) return;
    const sse = openSse(req, reply, deps.corsOrigin);
    try {
      for await (const ev of crawlSite(q.url, { maxPages: q.maxPages, maxDepth: q.maxDepth, includeSitemap: q.sitemap ?? true, signal: sse.signal })) {
        sse.send(ev.type, ev);
        if (sse.closed) break;
      }
    } catch (err) {
      sse.send("error", { url: q.url, error: (err as Error).message });
    } finally {
      sse.end();
    }
  });
}

/** Compact view used by streaming deep search. */
export function summarize(r: ResourceRecord) {
  return {
    resourceId: r.resourceId,
    kind: r.kind,
    httpStatus: r.httpStatus,
    title: r.title,
    canonicalUrl: r.canonicalUrl,
    completeness: r.quality.completeness,
    categoriesFound: r.categories.filter((c) => c.state === "observed").map((c) => c.id),
    fieldCount: r.fields.length,
    contradictions: r.quality.contradictions.length,
    fetchedAt: r.fetchedAt,
  };
}
