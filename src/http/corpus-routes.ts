import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Corpus } from "../corpus/types.js";
import type { AutonomousCrawler } from "../corpus/crawler.js";
import { resourceDetail, searchCorpus } from "../corpus/search.js";
import { SYSTEM_RETENTION } from "../corpus/types.js";
import { learnedAdjustment } from "../corpus/patterns.js";
import { federatedSearch } from "../search/engine.js";
import { PROVIDERS } from "../search/providers.js";
import { EXCLUDED_PROVIDERS } from "../corpus/host-policy.js";
import { canonicalizeUrl } from "../crawl/site-crawler.js";
import { EXTRACTORS } from "../metadata/extractors/index.js";
import { CATEGORIES } from "../metadata/categories.js";
import { understandQuery, type QueryPlan } from "../query/understand.js";
import { askCorpus } from "../query/execute.js";
import { LruCache } from "../util/async.js";
import { ApiKeys } from "./guards.js";
import { buildCoverageReport, type CountryEntry, type CoverageReport } from "../corpus/coverage.js";
import { buildCapabilities, loadFormatRegistry } from "../corpus/capabilities.js";
import { LIFECYCLE_STATES, RETRY_POLICY, TRANSITIONS } from "../corpus/lifecycle.js";
import { getEgressMode } from "../net/safe-fetch.js";

/**
 * Integration point for the geography registry (src/geo, 249 ISO 3166-1 entries). Any exported array of
 * { code | alpha2 | iso2, name } is accepted; without it the coverage API uses ccTLDs observed in the corpus.
 */
export async function loadCountryRegistry(): Promise<{ list: CountryEntry[]; source: string } | null> {
  for (const spec of [new URL("../geo/index.js", import.meta.url).href, new URL("../geo/index.ts", import.meta.url).href]) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      for (const [key, v] of Object.entries(mod)) {
        if (!Array.isArray(v) || v.length < 100) continue;
        const list = v
          .map((e: Record<string, unknown>) => ({ code: String(e?.code ?? e?.alpha2 ?? e?.iso2 ?? "").toUpperCase(), name: String(e?.name ?? e?.shortName ?? "") }))
          .filter((e) => /^[A-Z]{2}$/.test(e.code));
        if (list.length >= 100) return { list, source: `src/geo (${key})` };
      }
    } catch {
      /* registry not present yet */
    }
  }
  return null;
}

const SearchQ = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(1000).optional(),
  kind: z.string().regex(/^[a-z]+(,[a-z]+){0,5}$/).optional(),
  category: z.coerce.number().int().min(1).max(41).optional(),
  host: z.string().max(253).optional(),
});

const AskQ = SearchQ.extend({
  // Up to three earlier questions from the same session, oldest first, so "only 2020 to 2025" refines the last search.
  context: z.string().max(1500).optional(),
});
const recentTopics = new LruCache<number>(5000, 30 * 60_000);
/** Short-lived answer cache: identical questions within the TTL cost one DB round-trip per replica. */
const answerCache = new LruCache<unknown>(Number(process.env.SEARCH_CACHE_SIZE ?? 2000), Number(process.env.SEARCH_CACHE_TTL_MS ?? 30_000));

/** Concurrent identical questions share one computation (prevents cache stampedes). */
const inflight = new Map<string, Promise<unknown>>();
let statsCache: { at: number; value: Promise<Awaited<ReturnType<Corpus["stats"]>>> } | null = null;
function cachedStats(store: Corpus) {
  if (!statsCache || Date.now() - statsCache.at > 30_000) {
    statsCache = { at: Date.now(), value: store.stats() };
    statsCache.value.catch(() => (statsCache = null));
  }
  return statsCache.value;
}

export function registerCorpusRoutes(app: FastifyInstance, deps: { store: Corpus; crawlers: AutonomousCrawler[]; keys: ApiKeys; topicalDiscovery: boolean; countries?: () => CountryEntry[] | null }) {
  const { store, crawlers, keys } = deps;

  // Coverage aggregates scan whole tables (minutes on a large production corpus). They are built in the
  // background, single-flight per replica; requests get the last completed report with its age, and
  // only the very first request waits (briefly) before being told to come back.
  const COVERAGE_TTL = Number(process.env.COVERAGE_CACHE_TTL_MS ?? 10 * 60_000);
  type Built = CoverageReport & { tookMs: number };
  let coverageLast: { at: number; value: Built } | null = null;
  let coverageInflight: Promise<Built> | null = null;
  let coverageError: { at: number; message: string } | null = null;
  const countryRegistry = loadCountryRegistry();
  const refreshCoverage = () => {
    if (coverageInflight) return coverageInflight;
    const t0 = Date.now();
    coverageInflight = (async () => {
      const injected = deps.countries?.() ?? null;
      const geo = injected ? { list: injected, source: "injected" } : await countryRegistry;
      const raw = await store.coverageRaw(Date.now());
      return { ...buildCoverageReport(raw, { countries: geo?.list ?? null, registrySource: geo?.source }), tookMs: Date.now() - t0 };
    })();
    coverageInflight.then(
      (value) => { coverageLast = { at: Date.now(), value }; coverageError = null; },
      (e) => { coverageError = { at: Date.now(), message: String((e as Error).message ?? e).slice(0, 200) }; app.log.warn({ err: coverageError.message }, "coverage_refresh_failed"); },
    ).finally(() => (coverageInflight = null));
    return coverageInflight;
  };
  app.get("/api/v2/coverage", async (_req, reply) => {
    if (!coverageLast || Date.now() - coverageLast.at > COVERAGE_TTL) void refreshCoverage().catch(() => undefined);
    if (!coverageLast && coverageInflight) await Promise.race([coverageInflight.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
    const last = coverageLast as { at: number; value: Built } | null;
    if (!last) {
      if (coverageError && !coverageInflight) return reply.code(503).header("retry-after", "60").send({ error: "COVERAGE_UNAVAILABLE", message: "The coverage report could not be built; retrying in the background.", detail: coverageError.message });
      return reply.code(202).header("retry-after", "30").send({ status: "computing", message: "The coverage report is being built from the whole corpus. Try again in about 30 seconds." });
    }
    reply.header("cache-control", "public, max-age=30");
    return { ...last.value, cache: { ttlSeconds: COVERAGE_TTL / 1000, ageSeconds: Math.round((Date.now() - last.at) / 1000), refreshing: !!coverageInflight, lastRefreshError: coverageError?.message ?? null } };
  });

  app.get("/api/v2/capabilities", async () => {
    const [live, formats] = await Promise.all([store.liveCategoryEvidence().catch(() => null), loadFormatRegistry()]);
    return buildCapabilities({ live, formats, enrich: process.env.CRAWL_ENRICH !== "off", egress: getEgressMode() });
  });

  /**
   * Ask a question of the collected corpus. Results are this system's own
   * extracted findings. When local coverage is thin, topical discovery is
   * queued: public search APIs only *find candidate resources* for the
   * crawlers to retrieve and inspect — their listings are never returned.
   */
  app.get("/api/v2/search", async (req, reply) => {
    const r = SearchQ.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const key = JSON.stringify(r.data).toLowerCase();
    const cached = answerCache.get(key);
    reply.header("cache-control", "public, max-age=15, stale-while-revalidate=60");
    if (cached) {
      // Cached answers are stored pre-serialised; only the cache marker is appended.
      const body = cached.value as string;
      return reply.type("application/json; charset=utf-8").send(`${body.slice(0, -1)},"cache":{"hit":true,"ageSeconds":${Math.round(cached.ageMs / 1000)}}}`);
    }
    let pending = inflight.get(key) as Promise<Awaited<ReturnType<typeof searchCorpus>>> | undefined;
    if (!pending) {
      pending = searchCorpus(store, r.data.q, r.data);
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    const res = await pending;
    let discovery: { queued: boolean; reason: string } = { queued: false, reason: "local coverage sufficient" };
    const topic = r.data.q.toLowerCase().trim();
    // Thin coverage is either few matches, or many pages that only mention the words without being about them.
    const thin = res.total < 5 || (!r.data.offset && (res.matchQuality === "weak" || res.matchQuality === "none"));
    if (deps.topicalDiscovery && thin && !recentTopics.get(topic)) {
      recentTopics.set(topic, Date.now());
      discovery = { queued: true, reason: res.total < 5 ? "few collected resources match; topical discovery queued — candidates will be retrieved, inspected and indexed in the background" : "collected resources mention these words but none is about them; topical discovery queued — candidates will be retrieved, inspected and indexed in the background" };
      void federatedSearch(r.data.q, { limit: 40, perProvider: 6, providers: PROVIDERS.map((p) => p.id).filter((id) => !EXCLUDED_PROVIDERS.has(id)) })
        .then(async (fs) => {
          const items = fs.results
            .map((x) => ({ x, url: canonicalizeUrl(x.url) }))
            .filter((y): y is { x: (typeof fs.results)[number]; url: string } => Boolean(y.url))
            .map(({ x, url }, i) => ({ url, priority: 80 - i * 0.5, depth: 0, via: `search_api:${x.sources[0]?.provider ?? "unknown"}`, purpose: "discovery" as const }));
          const n = await store.enqueue(items);
          await store.event(null, "topical_discovery", `"${r.data.q.slice(0, 80)}": ${items.length} candidate resources, ${n} new`);
        })
        .catch((err) => store.event(null, "topical_discovery_failed", (err as Error).message.slice(0, 200)));
    }
    const stats = await cachedStats(store);
    const body = { ...res, discovery, corpus: { backend: store.backend, indexed: stats.byState.indexed ?? 0, crawlersInThisProcess: crawlers.map((c) => ({ id: c.id, profile: c.profile, running: c.isRunning })) } };
    answerCache.set(key, JSON.stringify(body));
    return { ...body, cache: { hit: false } };
  });

  /** The structured reading of a question: what it asks for, what was stated vs inferred, what is uncertain. */
  const planFor = (q: string, context?: string): QueryPlan => {
    let previous: QueryPlan | null = null;
    for (const earlier of (context ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(-3)) previous = understandQuery(earlier, { previous });
    return understandQuery(q, { previous });
  };
  app.get("/api/v2/understand", async (req, reply) => {
    const r = AskQ.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    reply.header("cache-control", "public, max-age=300");
    return { plan: planFor(r.data.q, r.data.context) };
  });

  /**
   * Ask a whole question: understand it, search the index with that plan, check every result against each
   * requirement, revise when too few qualify, and send the crawlers looking (with plan-built queries) when the
   * index can't satisfy it yet.
   */
  app.get("/api/v2/ask", async (req, reply) => {
    const r = AskQ.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const key = "ask:" + JSON.stringify(r.data).toLowerCase();
    const cached = answerCache.get(key);
    reply.header("cache-control", "public, max-age=15, stale-while-revalidate=60");
    if (cached) return reply.type("application/json; charset=utf-8").send(`${(cached.value as string).slice(0, -1)},"cache":{"hit":true,"ageSeconds":${Math.round(cached.ageMs / 1000)}}}`);
    const plan = planFor(r.data.q, r.data.context);
    const res = await askCorpus(store, plan, { limit: r.data.limit, offset: r.data.offset, kind: r.data.kind, host: r.data.host });
    let discovery: { queued: boolean; reason: string; queries?: string[] } = { queued: false, reason: "local coverage sufficient" };
    const topic = "ask:" + plan.discoveryQueries.join("|").toLowerCase();
    if (deps.topicalDiscovery && !r.data.offset && !res.evaluation.satisfied && plan.discoveryQueries.length && !recentTopics.get(topic)) {
      recentTopics.set(topic, Date.now());
      discovery = { queued: true, reason: "few indexed sources meet every requirement; the crawlers are looking with queries built from the request", queries: plan.discoveryQueries };
      void Promise.all(plan.discoveryQueries.map((dq) => federatedSearch(dq, { limit: 20, perProvider: 4, providers: PROVIDERS.map((p) => p.id).filter((id) => !EXCLUDED_PROVIDERS.has(id)) }).catch(() => ({ results: [] as Array<{ url: string; sources: Array<{ provider: string }> }> }))))
        .then(async (lists) => {
          const items = lists.flatMap((l) => l.results).map((x) => ({ x, url: canonicalizeUrl(x.url) })).filter((y): y is { x: (typeof y)["x"]; url: string } => Boolean(y.url))
            // Candidates on the requested publisher's own sites go to the front of the queue.
            .map(({ x, url }, i) => ({ url, priority: (plan.constraints.publisher?.hostSuffixes.some((h) => new URL(url).hostname.endsWith(h)) ? 95 : 80) - i * 0.3, depth: 0, via: `ask:${x.sources[0]?.provider ?? "unknown"}`, purpose: "discovery" as const }));
          const n = await store.enqueue(items);
          await store.event(null, "topical_discovery", `ask "${plan.original.slice(0, 80)}": ${items.length} candidates, ${n} new`);
        })
        .catch((err) => store.event(null, "topical_discovery_failed", (err as Error).message.slice(0, 200)));
    }
    const body = { ...res, discovery };
    answerCache.set(key, JSON.stringify(body));
    return { ...body, cache: { hit: false } };
  });

  app.get<{ Params: { id: string } }>("/api/v2/resources/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const d = Number.isInteger(id) ? await resourceDetail(store, id) : null;
    if (!d) return reply.code(404).send({ error: "NOT_FOUND" });
    return d;
  });

  app.get<{ Querystring: { url?: string } }>("/api/v2/resources", async (req, reply) => {
    const url = req.query.url ? canonicalizeUrl(req.query.url) : null;
    const r = url ? await store.byUrl(url) : null;
    if (!r) return reply.code(404).send({ error: "NOT_FOUND", message: "Not in the collected corpus." });
    return resourceDetail(store, r.id);
  });

  app.get<{ Params: { id: string; sid: string } }>("/api/v2/resources/:id/snapshots/:sid", async (req, reply) => {
    const snaps = await store.snapshots(Number(req.params.id));
    const s = snaps.find((x) => x.id === Number(req.params.sid));
    if (!s) return reply.code(404).send({ error: "NOT_FOUND" });
    return { snapshot: s, record: await store.snapshotRecord(s.id), observations: await store.observationsFor(s.id) };
  });

  app.get("/api/v2/crawler/status", async () => ({
    crawlersInThisProcess: crawlers.map((c) => ({ id: c.id, profile: c.profile, running: c.isRunning, processedSinceStart: c.processed, startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null })),
    frontier: await store.frontierSize(),
    systemRetention: SYSTEM_RETENTION,
    lifecycle: { states: LIFECYCLE_STATES, transitions: TRANSITIONS, retryPolicy: { maxAttempts: RETRY_POLICY.maxAttempts, baseBackoffMs: RETRY_POLICY.baseBackoffMs, maxBackoffMs: RETRY_POLICY.maxBackoffMs, maxRetryAfterMs: RETRY_POLICY.maxRetryAfterMs } },
    ...(await store.stats()),
  }));

  /** What the crawlers can do and what they have learned about doing it. */
  app.get("/api/v2/crawler/capabilities", async () => {
    const [extractorStats, best, worst] = await Promise.all([store.extractorStats(), store.topPatterns(20, "yield"), store.topPatterns(20, "failures")]);
    const byId = new Map(extractorStats.map((s) => [s.id.split("@")[0], s]));
    return {
      profiles: ["generalist", "datasets", "media", "documents", "refresh"],
      formats: EXTRACTORS.map((e) => {
        const s = byId.get(e.id);
        return { extractor: `${e.id}@${e.version}`, kinds: e.kinds, categories: e.categories, network: Boolean(e.needsNetwork), observed: s ? { runs: s.runs, errorRate: s.runs ? Number((s.errors / s.runs).toFixed(3)) : 0, avgFields: s.runs ? Number((s.fields / s.runs).toFixed(1)) : 0, avgMs: s.runs ? Math.round(s.ms / s.runs) : 0 } : null };
      }),
      categories: CATEGORIES.map((c) => ({ id: c.id, key: c.key, appliesTo: c.appliesTo, extractors: EXTRACTORS.filter((e) => e.categories.includes(c.id)).map((e) => e.id) })),
      learnedPatterns: {
        highestYield: best.map((p) => ({ ...p, adjustment: learnedAdjustment(p) })),
        mostFailing: worst.filter((p) => p.failed > 0).map((p) => ({ ...p, adjustment: learnedAdjustment(p) })),
      },
      limits: { robots: "RFC 9309", oneRequestPerHostAtATime: true, gapPursuitPerResource: 4, hostBudget: Number(process.env.HOST_BUDGET ?? 400), maxDepth: Number(process.env.CRAWL_MAX_DEPTH ?? 6) },
    };
  });

  const admin = (req: unknown) => keys.enabled && keys.verify(ApiKeys.tokenFrom(req as never));
  app.post("/api/v2/crawler/pause", async (req, reply) => {
    if (!admin(req)) return reply.code(401).send({ error: "UNAUTHORIZED", message: "Requires API_KEYS to be configured and a valid key." });
    await Promise.all(crawlers.map((c) => c.stop()));
    return { running: false };
  });
  app.post("/api/v2/crawler/resume", async (req, reply) => {
    if (!admin(req)) return reply.code(401).send({ error: "UNAUTHORIZED", message: "Requires API_KEYS to be configured and a valid key." });
    crawlers.forEach((c) => c.start());
    return { running: crawlers.some((c) => c.isRunning) };
  });
}
