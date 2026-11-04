import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DomainRun, normalizeTarget, scopeRootOf, verificationValue } from "../domain-intel/engine.js";
import { liveNet, type IntelNet } from "../domain-intel/net.js";
import { FAMILIES, RULES } from "../domain-intel/rules.js";

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
  type Report = ReturnType<DomainRun["report"]>;
  const cache = new Map<string, { at: number; report: Promise<Report> }>();
  // Runs kept for continuation: each continue explores the next wave of the frontier.
  const runs = new Map<string, { run: DomainRun; busy: boolean; client: string }>();
  const waveTimes = new Map<string, number[]>();
  const RUN_TTL = 60 * 60_000, MAX_RUNS = 40, WAVES_PER_HOUR = 600;
  const sweep = () => { for (const [id, r] of runs) if (Date.now() - r.run.lastUsed > RUN_TTL) runs.delete(id); while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!); };
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
    const domain = scopeRootOf(host);
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
    // Void relays every visitor from one server address, so it forwards an opaque per-visitor key
    // (a salted hash, never the address). Spoofing it only moves a caller into another bucket:
    // the global concurrency cap below is the protection, this limit is fairness.
    const relayKey = String(req.headers["x-void-client"] ?? "");
    const client = /^[a-f0-9]{16,64}$/.test(relayKey) ? `${req.ip}|${relayKey}` : req.ip;
    const times = (perClient.get(client) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (times.length >= PER_HOUR) return reply.code(429).header("retry-after", "600").send({ error: "RATE_LIMITED", message: `At most ${PER_HOUR} domain runs per hour per client.` });
    if (running >= MAX_RUNNING) return reply.code(503).header("retry-after", "20").send({ error: "BUSY", message: "Other domain runs are in progress. Try again in a few seconds." });
    times.push(Date.now());
    perClient.set(client, times);
    if (perClient.size > 5000) perClient.delete(perClient.keys().next().value!);
    running++;
    const report = (async () => {
      const run = new DomainRun(host, { net, ownedRoots: owned, secret, budgetMs: deps.budgetMs });
      const total = deps.budgetMs ?? 45_000, t0 = Date.now();
      await run.init(Math.round(total * 0.5));
      await run.wave(Math.max(1000, total - (Date.now() - t0)));
      sweep();
      runs.set(run.id, { run, busy: false, client });
      return run.report();
    })().finally(() => running--);
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

  // Continue a run: one more wave of the frontier, then the whole report re-analysed. Repeat until complete.
  app.get("/api/v2/domain-intel/continue", async (req, reply) => {
    const id = String((req.query as Record<string, string>).run ?? "");
    if (!/^[a-f0-9]{24}$/.test(id)) return reply.code(400).send({ error: "INVALID_RUN" });
    sweep();
    const entry = runs.get(id);
    if (!entry) return reply.code(404).send({ error: "RUN_EXPIRED", message: "This run is no longer held (runs are kept for an hour). Start a new run." });
    if (entry.busy) return reply.code(409).header("retry-after", "5").send({ error: "WAVE_IN_PROGRESS", message: "A wave of this run is already in progress." });
    if (entry.run.frontier === 0) return entry.run.report();
    const times = (waveTimes.get(entry.client) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (times.length >= WAVES_PER_HOUR) return reply.code(429).header("retry-after", "300").send({ error: "RATE_LIMITED", message: `At most ${WAVES_PER_HOUR} waves per hour per client.` });
    if (running >= MAX_RUNNING) return reply.code(503).header("retry-after", "10").send({ error: "BUSY", message: "Other domain runs are in progress. Try again in a few seconds." });
    times.push(Date.now());
    waveTimes.set(entry.client, times);
    entry.busy = true;
    running++;
    try {
      await entry.run.wave(deps.budgetMs ?? 45_000);
      reply.header("cache-control", "no-store");
      return entry.run.report();
    } catch (e) {
      app.log.warn({ err: (e as Error).message, run: id }, "domain_intel_wave_failed");
      return reply.code(502).send({ error: "DOMAIN_INTEL_FAILED", message: "This wave could not complete. Try continuing again." });
    } finally {
      entry.busy = false;
      running--;
    }
  });
}
