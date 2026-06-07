import Fastify from "fastify";
import type { Role } from "./core/models.js";
import type { AppConfig } from "./core/config.js";
import { allowedDomainsFromSeeds, loadDomainSeeds, resolveDomainSeeds } from "./core/domain-seeds.js";
import { Orchestrator } from "./core/orchestrator.js";
import { buildSecurityStack } from "./security/nomad.js";
import { handleChat } from "./chat/chat-service.js";
import { pagesToLiveDocuments } from "./chat/live-data-policy.js";
import { formatReportText, runTopicLookup } from "./topic/index.js";

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export async function startApi(config: AppConfig, host: string, port: number): Promise<void> {
  const security = config.security.enabled ? buildSecurityStack(config) : null;
  const orchestrator = new Orchestrator(config, security);
  orchestrator.init();

  const app = Fastify({ logger: true });

  app.addHook("onSend", async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path === "/health" || path === "/organism/vitals") return;

    if (!security) return;
    if (!security.rateLimiter.tryAcquire()) {
      return reply.code(429).send({ error: "RATE_LIMITED" });
    }
    reply.raw.on("finish", () => security.rateLimiter.release());

    if (!security.vitalGuard.isVital()) {
      return reply.code(503).send({ error: "ORGANISM_LOCKDOWN" });
    }

    const clientIp = req.ip;
    if (!security.allowlist.isAllowed(clientIp)) {
      return reply.code(403).send({ error: "CLIENT_NOT_ALLOWLISTED" });
    }

    if (security.auth.requireAuth && !config.security.devMode) {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "UNAUTHORIZED" });
      const principal = security.auth.verifyToken(auth.slice(7).trim());
      if (!principal) return reply.code(401).send({ error: "UNAUTHORIZED" });
      (req as { principal?: unknown }).principal = principal;
    }

    if (!security.rbac.authorize((req as { principal?: { roles: Role[] } | null }).principal ?? null, req.method, path)) {
      if (!config.security.devMode || security.auth.requireAuth) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "omnispider",
    version: "1.0.0",
    security: "nomad_cyber",
    organismVital: security?.vitalGuard.isVital() ?? true,
  }));

  app.get("/organism/vitals", async () => security?.vitalGuard.getVitalsReport() ?? {});

  app.post<{ Body: { topic: string; seeds?: string[]; maxDepth?: number; maxPages?: number; exhaustive?: boolean } }>(
    "/v1/lookup",
    async (req, reply) => {
      const { topic, seeds, maxDepth, maxPages, exhaustive } = req.body ?? {};
      if (!topic) return reply.code(400).send({ error: "topic required" });
      const report = await runTopicLookup(config, security, {
        topic,
        extraSeeds: seeds ?? [],
        maxDepth: maxDepth ?? 5,
        maxPages: maxPages ?? 500,
        exhaustive: exhaustive !== false,
        includeArchive: true,
      });
      return { report, text: formatReportText(report) };
    },
  );

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
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("CRAWL_INCOMPLETE:")) {
        return reply.code(504).send({ error: "CRAWL_INCOMPLETE", status: msg.split(":")[1] });
      }
      if (msg.startsWith("LIVE_") || msg.startsWith("BLOCKED_")) {
        return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
      }
      return reply.code(400).send({ error: msg });
    }
  });

  /** Aureon bridge — topic + domain resolves whitelisted seeds; live web pages only. */
  app.post<{ Body: Record<string, unknown> }>("/api/crawl", async (req, reply) => {
    const body = req.body ?? {};
    const topic = String(body.topic ?? body.question ?? "").trim();
    const domain = String(body.domain ?? "").trim();
    if (!topic) return reply.code(400).send({ error: "topic required" });
    const seeds =
      (body.seeds as string[] | undefined)?.filter(Boolean) ??
      (domain ? resolveDomainSeeds(domain) : []);
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
        includeSitemaps: body.includeSitemaps !== false,
        jsRendering: !!body.jsRendering,
        topic,
        topicFollowRelated: true,
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
      const livePages = pagesToLiveDocuments(pages);
      const documents = livePages.map((p) => ({
        text: p.text,
        url: p.url,
        title: p.title,
        source: "live",
        fetchedAt: p.fetchedAt,
      }));
      return {
        jobId: job.id,
        domain: domain || null,
        topic,
        livePageCount: documents.length,
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
    setInterval(() => security.vitalGuard.pulseCheck(), config.security.organismPulseSeconds * 1000);
  }

  await app.listen({ host, port });
  console.log(`Omnispider API listening on http://${host}:${port}`);
}
