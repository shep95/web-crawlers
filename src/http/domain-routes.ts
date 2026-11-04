import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeTarget, runDomainIntel, verificationValue, type IntelReport } from "../domain-intel/engine.js";
import { liveNet, type IntelNet } from "../domain-intel/net.js";
import { FAMILIES, RULES } from "../domain-intel/rules.js";
import { registrable } from "../domain-intel/collect.js";

const Q = z.object({ domain: z.string().trim().min(3).max(300), fresh: z.enum(["1", "true"]).optional() });

/** HMAC secret for ownership tokens: DOMAIN_INTEL_SECRET, else a random value kept in the data directory. */
function loadSecret(): string {
  if (process.env.DOMAIN_INTEL_SECRET) return process.env.DOMAIN_INTEL_SECRET;
  const dir = process.env.DATA_DIR ?? "./data";
  const file = join(dir, "domain-intel-secret");
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    mkdirSync(dir, { recursive: true });
    const s = randomBytes(32).toString("hex");
    writeFileSync(file, s, { mode: 0o600 });
    return s;
  } catch {
    return randomBytes(32).toString("hex");
  }
}

/**
 * Domain intelligence: the recursive cause-and-effect audit map applied to one domain.
 * Passive public observation for any domain; owner-verified checks only for owned roots.
 */
export function registerDomainIntelRoutes(app: FastifyInstance, deps: { net?: IntelNet; ownedRoots?: string[]; secret?: string; budgetMs?: number } = {}) {
  const net = deps.net ?? liveNet;
  const owned = deps.ownedRoots ?? (process.env.DOMAIN_INTEL_OWNED ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const secret = deps.secret ?? loadSecret();
  const cache = new Map<string, { at: number; report: Promise<IntelReport> }>();
  const perClient = new Map<string, number[]>();
  let running = 0;
  const MAX_RUNNING = 3, PER_HOUR = 20, TTL = 10 * 60_000;

  app.get("/api/v2/domain-intel/rules", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=86400");
    return { source: "docs/domain-cause-effect-map.txt", families: FAMILIES, rules: RULES };
  });

  app.get("/api/v2/domain-intel/verification", async (req, reply) => {
    const r = Q.pick({ domain: true }).safeParse(req.query);
    const host = r.success ? normalizeTarget(r.data.domain) : null;
    if (!host) return reply.code(400).send({ error: "INVALID_DOMAIN", message: "Enter a public domain name such as example.org." });
    const domain = registrable(host);
    return { domain, record: `_void-verify.${domain}`, type: "TXT", value: verificationValue(domain, secret), effect: "Publishing this TXT record proves control of the domain and enables owner-only checks (exposed files, legacy TLS, CORS origin test, open-redirect test, service ports on non-shared infrastructure). Remove it to return to passive mode." };
  });

  app.get("/api/v2/domain-intel", async (req, reply) => {
    const r = Q.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const host = normalizeTarget(r.data.domain);
    if (!host) return reply.code(400).send({ error: "INVALID_DOMAIN", message: "Enter a public domain name such as example.org (no IP addresses, internal or reserved names)." });
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < TTL && !r.data.fresh) {
      reply.header("x-domain-intel-cache", "hit");
      return hit.report;
    }
    const client = req.ip;
    const times = (perClient.get(client) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (times.length >= PER_HOUR) return reply.code(429).header("retry-after", "600").send({ error: "RATE_LIMITED", message: `At most ${PER_HOUR} domain runs per hour per client.` });
    if (running >= MAX_RUNNING) return reply.code(503).header("retry-after", "20").send({ error: "BUSY", message: "Other domain runs are in progress. Try again in a few seconds." });
    times.push(Date.now());
    perClient.set(client, times);
    if (perClient.size > 5000) perClient.delete(perClient.keys().next().value!);
    running++;
    const report = runDomainIntel(host, { net, ownedRoots: owned, secret, budgetMs: deps.budgetMs }).finally(() => running--);
    cache.set(host, { at: Date.now(), report });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    try {
      const out = await report;
      reply.header("cache-control", "private, max-age=300");
      return out;
    } catch (e) {
      cache.delete(host);
      app.log.warn({ err: (e as Error).message, host }, "domain_intel_failed");
      return reply.code(502).send({ error: "DOMAIN_INTEL_FAILED", message: "The run could not complete. Try again shortly." });
    }
  });
}
