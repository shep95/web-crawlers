import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CorpusStore } from "../corpus/store.js";
import type { AutonomousCrawler } from "../corpus/crawler.js";
import { resourceDetail, searchCorpus } from "../corpus/search.js";
import { SYSTEM_RETENTION } from "../corpus/store.js";
import { federatedSearch } from "../search/engine.js";
import { canonicalizeUrl } from "../crawl/site-crawler.js";
import { ApiKeys } from "./guards.js";

const SearchQ = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(1000).optional(),
  kind: z.string().regex(/^[a-z]+$/).optional(),
  category: z.coerce.number().int().min(1).max(41).optional(),
  host: z.string().max(253).optional(),
});

/** Questions that recently triggered topical discovery (bounded; avoids re-querying APIs per keystroke). */
const recentTopics = new Map<string, number>();

export function registerCorpusRoutes(app: FastifyInstance, deps: { store: CorpusStore; crawler: AutonomousCrawler | null; keys: ApiKeys }) {
  const { store, crawler, keys } = deps;

  /**
   * Ask a question of the collected corpus. Results are this system's own
   * extracted findings (resources + field-level evidence + gaps). When local
   * coverage is thin, topical discovery is queued in the background: public
   * search APIs are used only to find resources for the crawler to retrieve
   * and inspect — their listings are never returned as answers.
   */
  app.get("/api/v2/search", async (req, reply) => {
    const r = SearchQ.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const res = searchCorpus(store, r.data.q, r.data);
    let discovery: { queued: boolean; reason: string } = { queued: false, reason: "local coverage sufficient" };
    const key = r.data.q.toLowerCase().trim();
    if (crawler && res.total < 5 && (Date.now() - (recentTopics.get(key) ?? 0)) > 30 * 60_000) {
      recentTopics.set(key, Date.now());
      if (recentTopics.size > 2000) recentTopics.delete(recentTopics.keys().next().value!);
      discovery = { queued: true, reason: "few collected resources match; topical discovery queued — new resources will be retrieved, inspected and indexed in the background" };
      void federatedSearch(r.data.q, { limit: 40, perProvider: 6 })
        .then((fs) => {
          const items = fs.results
            .map((x) => canonicalizeUrl(x.url))
            .filter((u): u is string => Boolean(u))
            .map((url, i) => ({ url, priority: 80 - i * 0.5, depth: 0, via: `search_api:${fs.results[i]?.sources[0]?.provider ?? "unknown"}`, purpose: "discovery" as const }));
          const n = store.enqueue(items);
          store.event(null, "topical_discovery", `"${r.data.q.slice(0, 80)}": ${items.length} candidate resources, ${n} new`);
        })
        .catch((err) => store.event(null, "topical_discovery_failed", (err as Error).message.slice(0, 200)));
    }
    return { ...res, discovery, corpus: { indexed: store.stats().byState.indexed ?? 0, crawlerRunning: crawler?.isRunning ?? false } };
  });

  app.get<{ Params: { id: string } }>("/api/v2/resources/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const d = Number.isInteger(id) ? resourceDetail(store, id) : null;
    if (!d) return reply.code(404).send({ error: "NOT_FOUND" });
    return d;
  });

  app.get<{ Querystring: { url?: string } }>("/api/v2/resources", async (req, reply) => {
    const url = req.query.url ? canonicalizeUrl(req.query.url) : null;
    const r = url ? store.byUrl(url) : null;
    if (!r) return reply.code(404).send({ error: "NOT_FOUND", message: "Not in the collected corpus." });
    return resourceDetail(store, r.id);
  });

  app.get<{ Params: { id: string; sid: string } }>("/api/v2/resources/:id/snapshots/:sid", async (req, reply) => {
    const snaps = store.snapshots(Number(req.params.id));
    const s = snaps.find((x) => x.id === Number(req.params.sid));
    if (!s) return reply.code(404).send({ error: "NOT_FOUND" });
    return { snapshot: s, record: store.snapshotRecord(s.id), observations: store.observationsFor(s.id) };
  });

  app.get("/api/v2/crawler/status", async () => ({
    running: crawler?.isRunning ?? false,
    processedSinceStart: crawler?.processed ?? 0,
    frontier: store.frontierSize(),
    systemRetention: SYSTEM_RETENTION,
    ...store.stats(),
  }));

  const admin = (req: { headers: Record<string, unknown> }) => keys.enabled && keys.verify(ApiKeys.tokenFrom(req as never));
  app.post("/api/v2/crawler/pause", async (req, reply) => {
    if (!admin(req as never)) return reply.code(401).send({ error: "UNAUTHORIZED", message: "Requires API_KEYS to be configured and a valid key." });
    await crawler?.stop();
    return { running: false };
  });
  app.post("/api/v2/crawler/resume", async (req, reply) => {
    if (!admin(req as never)) return reply.code(401).send({ error: "UNAUTHORIZED", message: "Requires API_KEYS to be configured and a valid key." });
    crawler?.start();
    return { running: crawler?.isRunning ?? false };
  });
}
