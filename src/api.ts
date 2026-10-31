import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import type { Role } from "./core/models.js";
import type { AppConfig } from "./core/config.js";
import { allowedDomainsFromSeeds, loadDomainSeeds, resolveDomainIngestList, resolveDomainSeeds } from "./core/domain-seeds.js";
import { resolveDeepWebConfig } from "./core/deep-web-config.js";
import { Orchestrator } from "./core/orchestrator.js";
import { buildSecurityStack } from "./security/nomad.js";
import { handleChat } from "./chat/chat-service.js";
import { pagesToLiveDocuments } from "./chat/live-data-policy.js";
import { loadScribdKnowledge } from "./sources/scribd-service.js";
import { scribdLoginHelp } from "./sources/scribd.js";
import { syncDeepWebSource, listDeepWebSources, loadDeepWebKnowledge } from "./sources/deep-web-service.js";
import {
  exportCorpusDocuments,
  loadCorpusManifest,
  searchCorpusDocuments,
} from "./sources/corpus-index.js";
import { ingestUrlsForDomain, ingestToChatDocuments } from "./sources/url-ingest.js";
import { startDeepWebScheduler } from "./sync/deep-web-scheduler.js";
import { prioritizeSeedsForQuestion } from "./chat/retrieval-ranker.js";

import { registerV2 } from "./http/v2.js";
import { registerCorpusRoutes } from "./http/corpus-routes.js";
import { registerTextRoutes } from "./http/text-routes.js";
import { openCorpus } from "./corpus/pg-store.js";
import type { Corpus, CrawlerProfile } from "./corpus/types.js";
import { AutonomousCrawler } from "./corpus/crawler.js";
import { playwrightRenderer } from "./corpus/render.js";
import { ApiKeys, LatencyStats } from "./http/guards.js";
import { getEgressMode } from "./net/safe-fetch.js";
import { analysisSlots } from "./metadata/pipeline.js";

const API_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const UI_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface BuildOptions {
  /** SQLite path when DATABASE_URL is not set (default: $DATA_DIR/corpus.db). ":memory:" for tests. */
  corpusPath?: string;
  /** Inject a corpus (tests). */
  corpus?: Corpus;
  /** Start crawlers in this process. Default: SERVICE_ROLE ≠ "api" and CRAWLER_ENABLED ≠ "off". */
  crawler?: boolean;
  /** Mount the legacy v1 crawler/chat/deep-web routes (SQLite + disk). Default: LEGACY_API=on. */
  legacy?: boolean;
  logger?: boolean;
}

/** Build the Fastify app without listening (used by tests via app.inject). */
export async function buildApp(config: AppConfig, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const startedAt = Date.now();
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true, // Railway terminates TLS at its edge proxy; req.ip must be the client.
    bodyLimit: 1024 * 1024,
    requestTimeout: 120_000,
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024) }, (_req, body, done) => done(null, body));

  const corsOrigins = (process.env.CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // CORS_ORIGIN: "*" for any origin (public read API), or a comma-separated allow-list of frontend origins.
  await app.register(cors, { origin: corsOrigins.includes("*") ? true : corsOrigins.length ? corsOrigins : false, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type", "authorization", "x-api-key", "x-filename", "x-content-type"], maxAge: 86400 });

  app.addHook("onSend", async (req, reply) => {
    for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) reply.header(k, v);
    const type = String(reply.getHeader("content-type") ?? "");
    reply.header("Content-Security-Policy", type.includes("text/html") ? UI_CSP : "default-src 'none'; frame-ancestors 'none'");
  });

  const keys = new ApiKeys();
  const stats = new LatencyStats();
  let shuttingDown = false;
  app.decorate("markShuttingDown", () => (shuttingDown = true));

  app.get("/health", async () => ({ status: "ok", service: "omnispider", version: "2.0.0", uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
  app.get("/ready", async (_req, reply) => {
    if (shuttingDown) return reply.code(503).send({ ready: false, reason: "shutting_down" });
    const mem = process.memoryUsage().rss;
    const limit = Number(process.env.MEMORY_SOFT_LIMIT_MB ?? 900) * 1024 * 1024;
    const slots = analysisSlots.stats;
    const ready = mem < limit && slots.queued < 150;
    return reply.code(ready ? 200 : 503).send({ ready, rssMb: Math.round(mem / 1048576), analysisSlots: slots, egress: getEgressMode() });
  });

  await registerV2(app, { keys, stats, corsOrigin: corsOrigins.includes("*") ? "*" : corsOrigins[0] ?? null, startedAt });

  const store = opts.corpus ?? (await openCorpus({ sqlitePath: opts.corpusPath }));
  const role = process.env.SERVICE_ROLE ?? "all"; // all | api | crawler
  const crawlerOn = opts.crawler ?? (role !== "api" && process.env.CRAWLER_ENABLED !== "off");
  // Several specialised crawlers can share one process; each profile can also run as its own scaled service.
  const profiles = (process.env.CRAWLER_PROFILES ?? process.env.CRAWLER_PROFILE ?? "generalist,datasets,media,documents,refresh")
    .split(",").map((p) => p.trim()).filter(Boolean) as CrawlerProfile[];
  const renderer = process.env.RENDER_JS === "on" ? playwrightRenderer() : null;
  const crawlers = crawlerOn ? profiles.map((profile) => new AutonomousCrawler({ store, profile, renderer })) : [];
  registerCorpusRoutes(app, { store, crawlers, keys, topicalDiscovery: process.env.TOPICAL_DISCOVERY !== "off" });
  registerTextRoutes(app, { store });
  app.addHook("onReady", async () => crawlers.forEach((c) => c.start()));
  app.addHook("onClose", async () => {
    await Promise.all(crawlers.map((c) => c.stop()));
    await renderer?.close();
    if (!opts.corpus) await store.close();
  });
  // Operational heartbeat: one structured log line with corpus + crawler state (category 22 / monitoring).
  if (crawlers.length) {
    const beat = setInterval(() => {
      void store
        .stats()
        .then((st) => app.log.info({ heartbeat: true, crawlers: crawlers.map((c) => ({ id: c.id, processed: c.processed })), frontier: st.byState.queued ?? 0, byState: st.byState, byKind: st.byKind, observations: st.observations, categoriesObserved: st.categoriesObserved, hosts: st.hosts }, "crawler_heartbeat"))
        .catch(() => undefined);
    }, Number(process.env.HEARTBEAT_MS ?? 300_000));
    beat.unref();
    app.addHook("onClose", async () => clearInterval(beat));
  }
  const prune = setInterval(() => void store.pruneEvents(Date.now()).catch(() => undefined), 6 * 3600_000);
  prune.unref();
  app.addHook("onClose", async () => clearInterval(prune));

  if (existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/", index: ["index.html"], maxAge: 3600_000, immutable: false });
    // Client-side routes (/search, /resource, /crawl …) resolve to the SPA shell instead of 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/v1/") && (req.headers.accept ?? "").includes("text/html")) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({ error: "NOT_FOUND", path: req.url.split("?")[0] });
    });
  }

  const legacy = opts.legacy ?? process.env.LEGACY_API === "on";
  if (legacy) await registerLegacy(app, config, keys);
  return app;
}

/**
 * Legacy v1 routes (crawl jobs, chat, Scribd/deep-web corpus). They persist to
 * SQLite/disk, so they are opt-in (LEGACY_API=on) and, when API_KEYS is set,
 * require a key. The person-profiling `/v1/lookup` route has been removed.
 */
async function registerLegacy(app: FastifyInstance, config: AppConfig, keys: ApiKeys): Promise<void> {
  const security = config.security.enabled ? buildSecurityStack(config) : null;
  const orchestrator = new Orchestrator(config, security);
  orchestrator.init();
  const deepCfg = resolveDeepWebConfig();
  app.addHook("onClose", async () => orchestrator.shutdown());
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    const isLegacy = path.startsWith("/v1/") || (path.startsWith("/api/") && !path.startsWith("/api/v2/"));
    if (!isLegacy) return;
    if (keys.enabled && !keys.verify(ApiKeys.tokenFrom(req))) return reply.code(401).send({ error: "UNAUTHORIZED" });
    if (!keys.enabled && process.env.NODE_ENV === "production") {
      return reply.code(403).send({ error: "LEGACY_API_REQUIRES_API_KEYS", message: "Set API_KEYS to use legacy routes in production." });
    }
  });

  app.get("/v1/domain-seeds", async () => loadDomainSeeds());

  app.get<{ Params: { domain: string } }>("/v1/domain-seeds/:domain", async (req, reply) => {
    const seeds = resolveDomainSeeds(req.params.domain);
    if (!seeds.length) return reply.code(404).send({ error: "No seeds for domain" });
    return { domain: req.params.domain, seeds, allowedDomains: allowedDomainsFromSeeds(seeds) };
  });

  app.post<{ Body: Record<string, unknown> }>("/v1/jobs", async (req, reply) => {
    const body = req.body ?? {};
    const seeds = body.seeds as string[] | undefined;
    if (!seeds?.length) return reply.code(400).send({ error: "seeds required" });
    try {
      const job = await orchestrator.submitJob({
        seeds,
        maxDepth: (body.maxDepth as number) ?? 3,
        maxPages: (body.maxPages as number) ?? 100,
        includeArchive: body.includeArchive !== false,
        includeSitemaps: body.includeSitemaps !== false,
        jsRendering: !!body.jsRendering,
        topic: (body.topic as string) ?? null,
        topicFollowRelated: !!body.topic,
        allowedDomains: (body.allowedDomains as string[] | null) ?? allowedDomainsFromSeeds(seeds),
      });
      return reply.code(202).send(job);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Algorithm chatbot — always crawls live web; never test files or archive snapshots. */
  app.post<{ Body: Record<string, unknown> }>("/api/chat", async (req, reply) => {
    const body = req.body ?? {};
    const message = String(body.message ?? body.question ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const domain = String(body.domain ?? "").trim();
    const seeds = Array.isArray(body.seeds) ? (body.seeds as string[]) : undefined;
    if (!domain && !seeds?.length) {
      return reply.code(400).send({ error: "domain or seeds required — chat always uses live crawl data" });
    }
    try {
      const result = await handleChat(config, orchestrator, {
        message,
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
        domain: domain || undefined,
        seeds,
        maxDepth: body.maxDepth != null ? Number(body.maxDepth) : undefined,
        maxPages: body.maxPages != null ? Number(body.maxPages) : undefined,
        timeoutMs: body.timeoutMs != null ? Number(body.timeoutMs) : undefined,
        includeScribd: body.includeScribd === true,
        forceScribdSync: body.forceScribdSync === true,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("CRAWL_INCOMPLETE:")) {
        return reply.code(504).send({ error: "CRAWL_INCOMPLETE", status: msg.split(":")[1] });
      }
      if (msg.startsWith("SCRIBD_") || msg.startsWith("DEEP_")) {
        return reply.code(msg.includes("AUTH") ? 401 : 400).send({
          error: msg.split(" — ")[0],
          detail: msg,
          help: scribdLoginHelp(),
        });
      }
      if (msg.startsWith("LIVE_") || msg.startsWith("BLOCKED_")) {
        return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
      }
      return reply.code(400).send({ error: msg });
    }
  });

  /** Sync personal Scribd library (https://www.scribd.com/home) into local corpus. */
  app.post<{ Body: Record<string, unknown> }>("/api/scribd/sync", async (req, reply) => {
    try {
      const result = await loadScribdKnowledge({ forceSync: req.body?.forceSync === true });
      return {
        synced: result.synced,
        documentCount: result.documents.length,
        syncedAt: result.corpus.syncedAt,
        libraryUrl: result.corpus.libraryUrl,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(msg.includes("AUTH") ? 401 : 400).send({
        error: msg.split(" — ")[0],
        detail: msg,
        help: scribdLoginHelp(),
      });
    }
  });

  app.get("/api/sources", async () => ({
    authenticated: listDeepWebSources(),
    manifest: loadCorpusManifest(),
  }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/sources/:id/sync",
    async (req, reply) => {
      try {
        const result = await syncDeepWebSource(req.params.id, {
          force: req.body?.forceSync === true,
          config,
        });
        return { ...result, manifest: loadCorpusManifest() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
      }
    },
  );

  app.post<{ Body: Record<string, unknown> }>("/api/ingest/sync", async (req, reply) => {
    const domain = String(req.body?.domain ?? "").trim();
    if (!domain) return reply.code(400).send({ error: "domain required" });
    try {
      const result = await syncDeepWebSource(`ingest:${domain}`, {
        force: true,
        config,
        domain,
      });
      return { domain, ...result, manifest: loadCorpusManifest() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
    }
  });

  /** Auto-add unindexed URLs: fetch, persist to corpus + ingest list, push to frontend webhook. */
  app.post<{ Body: Record<string, unknown> }>("/api/ingest/urls", async (req, reply) => {
    const domain = String(req.body?.domain ?? "unlisted_public").trim();
    const urls = Array.isArray(req.body?.urls) ? (req.body.urls as string[]) : [];
    if (!urls.length) return reply.code(400).send({ error: "urls required" });
    try {
      const listPath = resolveDomainIngestList(domain);
      const result = await ingestUrlsForDomain(config, domain, urls, {
        listPath: listPath ?? undefined,
      });
      return {
        domain,
        documentCount: result.documents.length,
        addedToList: result.added,
        rejected: result.rejected,
        manifest: loadCorpusManifest(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
    }
  });

  app.get<{ Querystring: { domain?: string; q?: string; limit?: string } }>(
    "/api/corpus/documents",
    async (req) => {
      const domain = req.query.domain?.trim();
      const limit = Number(req.query.limit ?? 100);
      let docs = exportCorpusDocuments(domain);
      if (req.query.q?.trim()) {
        const ranked = searchCorpusDocuments(
          req.query.q,
          docs.map((d) => ({
            text: d.text,
            url: d.url,
            title: d.title,
            source: "deep" as const,
            fetchedAt: d.fetchedAt,
          })),
          limit,
        );
        const byUrl = new Map(docs.map((d) => [d.url, d]));
        docs = ranked.map((r) => byUrl.get(r.url)).filter((d): d is NonNullable<typeof d> => Boolean(d));
      } else {
        docs = docs.slice(0, limit);
      }
      return {
        domain: domain ?? null,
        uncensored: deepCfg.uncensored,
        count: docs.length,
        documents: docs,
      };
    },
  );

  app.get<{ Querystring: { domain?: string } }>("/api/corpus/export", async (req) => {
    const domain = req.query.domain?.trim();
    const documents = exportCorpusDocuments(domain);
    return {
      exportedAt: new Date().toISOString(),
      domain: domain ?? null,
      uncensored: deepCfg.uncensored,
      documentCount: documents.length,
      manifest: loadCorpusManifest(),
      documents,
    };
  });

  /** Aureon bridge — topic + domain resolves whitelisted seeds; live web pages only. */
  app.post<{ Body: Record<string, unknown> }>("/api/crawl", async (req, reply) => {
    const body = req.body ?? {};
    const topic = String(body.topic ?? body.question ?? "").trim();
    const domain = String(body.domain ?? "").trim();
    if (!topic) return reply.code(400).send({ error: "topic required" });
    const seeds = prioritizeSeedsForQuestion(
      (body.seeds as string[] | undefined)?.filter(Boolean) ??
        (domain ? resolveDomainSeeds(domain) : []),
      topic,
    );
    if (!seeds.length) {
      return reply.code(400).send({ error: "seeds required (provide seeds or domain)" });
    }
    const timeoutMs = Number(body.timeoutMs ?? 120_000);
    const pollMs = Number(body.pollMs ?? 1500);
    const maxDepth = Number(body.maxDepth ?? 2);
    const maxPages = Number(body.maxPages ?? 25);
    try {
      const job = await orchestrator.submitJob({
        seeds,
        maxDepth,
        maxPages,
        includeArchive: false,
        includeSitemaps: false,
        jsRendering: !!body.jsRendering,
        topic,
        topicFollowRelated: false,
        allowedDomains: allowedDomainsFromSeeds(seeds),
      });
      const finished = await orchestrator.waitForJob(job.id, { timeoutMs, pollMs });
      if (!finished || finished.status !== "completed") {
        return reply.code(504).send({
          error: "CRAWL_INCOMPLETE",
          jobId: job.id,
          status: finished?.status ?? "unknown",
        });
      }
      const pages = orchestrator.listPagesWithText(
        job.id,
        Number(body.pageLimit ?? 50),
        0,
      );
      const allowed = allowedDomainsFromSeeds(seeds);
      const livePages = pagesToLiveDocuments(pages, allowed);
      const liveDocuments = livePages.map((p) => ({
        text: p.text,
        url: p.url,
        title: p.title,
        source: "live" as const,
        fetchedAt: p.fetchedAt,
      }));

      let deepDocuments: Array<{
        text: string;
        url: string;
        title: string;
        source: "deep";
        fetchedAt?: string;
      }> = [];
      if (domain) {
        try {
          const deep = await loadDeepWebKnowledge({ domain, config });
          deepDocuments = deep.documents.map((d) => ({
            text: d.text,
            url: d.url,
            title: d.title,
            source: "deep" as const,
            fetchedAt: d.fetchedAt,
          }));
        } catch {
          /* deep corpus optional for hybrid/public domains */
        }
      } else if (body.includeDeepWeb === true) {
        deepDocuments = ingestToChatDocuments("unlisted_public").map((d) => ({
          ...d,
          source: "deep" as const,
        }));
      }

      const documents = [...deepDocuments, ...liveDocuments];
      return {
        jobId: job.id,
        domain: domain || null,
        topic,
        livePageCount: liveDocuments.length,
        deepWebDocumentCount: deepDocuments.length,
        documents,
      };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/v1/jobs", async () => orchestrator.listJobs());
  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req, reply) => {
    const job = orchestrator.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; includeText?: string } }>(
    "/v1/jobs/:id/pages",
    async (req) => {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      if (req.query.includeText === "1" || req.query.includeText === "true") {
        return orchestrator.listPagesWithText(req.params.id, limit, offset);
      }
      return orchestrator.listPages(req.params.id, limit, offset);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; includeText?: string } }>(
    "/api/jobs/:id/pages",
    async (req) => {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      if (req.query.includeText === "1" || req.query.includeText === "true") {
        return orchestrator.listPagesWithText(req.params.id, limit, offset);
      }
      return orchestrator.listPages(req.params.id, limit, offset);
    },
  );

  app.get("/v1/audit", async () => {
    if (!security) return { events: [] };
    const { valid, errors } = security.audit.verifyChain();
    return { chainValid: valid, chainErrors: errors, events: security.audit.query(100) };
  });

  if (security && config.security.enabled) {
    const t = setInterval(() => security.vitalGuard.pulseCheck(), config.security.organismPulseSeconds * 1000);
    t.unref();
    app.addHook("onClose", async () => clearInterval(t));
  }
  if (deepCfg.autoSync) startDeepWebScheduler(config);
}

export async function startApi(config: AppConfig, host: string, port: number): Promise<void> {
  const app = await buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutdown_started");
    (app as unknown as { markShuttingDown: () => void }).markShuttingDown();
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => app.log.error({ err }, "unhandled_rejection"));
  await app.listen({ host, port });
}
