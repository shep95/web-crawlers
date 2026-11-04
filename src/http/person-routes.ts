import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Corpus } from "../corpus/types.js";
import { canonicalizeUrl } from "../crawl/site-crawler.js";
import { EXCLUDED_PROVIDERS } from "../corpus/host-policy.js";
import { federatedSearch } from "../search/engine.js";
import { PROVIDERS } from "../search/providers.js";
import { parsePersonQuery } from "../person/parse.js";
import { personSearch } from "../person/search.js";

const Q = z.object({
  q: z.string().trim().max(300).optional(),
  name: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional(),
  born: z.string().trim().max(40).optional(),
  order: z.enum(["published", "events", "relevance"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  show: z.string().regex(/^(match|possible|other)(,(match|possible|other)){0,2}$/).optional(),
});

/**
 * GET /api/v2/person — people search: `q=@human Name (location) (birthday)`, or name/location/born separately.
 * Results are public pages from the collected index that name the person, ordered as a timeline.
 */
export function registerPersonRoutes(app: FastifyInstance, deps: { store: Corpus; topicalDiscovery?: boolean }) {
  const perClient = new Map<string, number[]>();
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const discovered = new Map<string, number>();
  const PER_HOUR = Number(process.env.PERSON_SEARCH_PER_HOUR ?? 60), TTL = 5 * 60_000, MAX_RUNNING = 4;
  let running = 0;

  app.get("/api/v2/person", async (req, reply) => {
    const r = Q.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const d = r.data;
    const pq = parsePersonQuery(d.q ?? "", { name: d.name, location: d.location, born: d.born });
    if (!pq.tokens.length) return reply.code(400).send({ error: "NAME_REQUIRED", message: "Give a name, for example @human Ada Lovelace (London) (1815-12-10).", syntax: "@human Name (location) (birthday)" });
    if (pq.tokens.join("").length < 2) return reply.code(400).send({ error: "NAME_TOO_SHORT", message: "A name needs at least two letters." });

    const key = JSON.stringify([pq.name.toLowerCase(), pq.location?.toLowerCase() ?? "", pq.born?.text ?? "", d.order ?? "", d.dir ?? "", d.limit ?? "", d.show ?? ""]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) {
      reply.header("x-person-cache", "hit").header("cache-control", "private, max-age=60");
      return hit.value;
    }
    // Void relays every visitor from one address and forwards an opaque per-visitor key (never the address).
    const relayKey = String(req.headers["x-void-client"] ?? "");
    const client = /^[a-f0-9]{16,64}$/.test(relayKey) ? `${req.ip}|${relayKey}` : req.ip;
    const times = (perClient.get(client) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (times.length >= PER_HOUR) return reply.code(429).header("retry-after", "600").send({ error: "RATE_LIMITED", message: `At most ${PER_HOUR} people searches per hour.` });
    if (running >= MAX_RUNNING) return reply.code(503).header("retry-after", "5").send({ error: "BUSY", message: "Other people searches are running. Try again in a few seconds." });
    times.push(Date.now());
    perClient.set(client, times);
    if (perClient.size > 5000) perClient.delete(perClient.keys().next().value!);

    running++;
    const value = personSearch(deps.store, pq, { order: d.order, dir: d.dir, limit: d.limit, verdicts: d.show?.split(",") as never }).finally(() => running--);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    let out: Awaited<typeof value>;
    try {
      out = await value;
    } catch (e) {
      cache.delete(key);
      app.log.warn({ err: (e as Error).message }, "person_search_failed");
      return reply.code(500).send({ error: "PERSON_SEARCH_FAILED", message: "The search could not complete. Try again shortly." });
    }

    // Few pages: send the crawlers looking for public pages about this person (quoted name, with the location).
    let discovery: { queued: boolean; queries?: string[]; reason: string } = { queued: false, reason: "enough indexed pages name this person" };
    const dkey = `${pq.name}|${pq.location ?? ""}`.toLowerCase();
    if (deps.topicalDiscovery && out.summary.matching + out.summary.possible < 10 && pq.tokens.length >= 2 && !(Date.now() - (discovered.get(dkey) ?? 0) < 30 * 60_000)) {
      discovered.set(dkey, Date.now());
      if (discovered.size > 5000) discovered.delete(discovered.keys().next().value!);
      const queries = [`"${pq.name}"`, ...(pq.location ? [`"${pq.name}" ${pq.location}`] : []), ...(pq.born ? [`"${pq.name}" ${pq.born.y}`] : [])];
      discovery = { queued: true, queries, reason: "few indexed pages name this person; the crawlers are looking for more public pages — search again in a few minutes" };
      const providers = PROVIDERS.map((p) => p.id).filter((id) => !EXCLUDED_PROVIDERS.has(id));
      void Promise.all(queries.map((x) => federatedSearch(x, { limit: 20, perProvider: 5, providers }).catch(() => ({ results: [] as Array<{ url: string; sources: Array<{ provider: string }> }> }))))
        .then(async (lists) => {
          const items = lists.flatMap((l) => l.results).map((x) => ({ x, url: canonicalizeUrl(x.url) })).filter((y): y is { x: (typeof y)["x"]; url: string } => Boolean(y.url))
            .map(({ x, url }, i) => ({ url, priority: 85 - i * 0.3, depth: 0, via: `person:${x.sources[0]?.provider ?? "unknown"}`, purpose: "discovery" as const }));
          const n = await deps.store.enqueue(items);
          await deps.store.event(null, "person_discovery", `${items.length} candidates, ${n} new`);
        })
        .catch((err) => deps.store.event(null, "person_discovery_failed", (err as Error).message.slice(0, 200)));
    }
    reply.header("cache-control", "private, max-age=60");
    return { ...out, discovery };
  });
}
