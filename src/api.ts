import Fastify from "fastify";
import type { Role } from "./core/models.js";
import type { AppConfig } from "./core/config.js";
import { Orchestrator } from "./core/orchestrator.js";
import { buildSecurityStack } from "./security/nomad.js";
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
      });
      return reply.code(202).send(job);
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
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/v1/jobs/:id/pages",
    async (req) => {
      return orchestrator.listPages(
        req.params.id,
        Number(req.query.limit ?? 100),
        Number(req.query.offset ?? 0),
      );
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
