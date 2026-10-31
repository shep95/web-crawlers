import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compactEntry, isoEntries, nonIsoEntries, registryMeta, registrySummary, resolveCode, searchRegistry, subdivision, subdivisionsOf, verifyRegistry } from "../geo/registry.js";

const ListQ = z.object({ q: z.string().trim().min(1).max(100).optional(), limit: z.coerce.number().int().min(1).max(300).optional() });

/** The geography registry: 249 ISO 3166-1 entries, the separate non-ISO layer, and ISO 3166-2 subdivisions. */
export function registerGeographyRoutes(app: FastifyInstance) {
  app.get("/api/v2/geography", async (req, reply) => {
    const r = ListQ.safeParse(req.query);
    if (!r.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    reply.header("cache-control", "public, max-age=3600");
    const base = { registry: registryMeta(), summary: registrySummary(), integrity: { problems: verifyRegistry() } };
    if (!r.data.q) return { ...base, entries: isoEntries().map(compactEntry), nonIso: nonIsoEntries().map((n) => ({ code: n.code, name: n.name, kind: n.kind, aliasOf: n.aliasOf, status: n.status })) };
    const hits = searchRegistry(r.data.q, r.data.limit ?? 50);
    return {
      ...base,
      query: r.data.q,
      matches: hits.map((h) => {
        const e = resolveCode(h.code);
        return e?.layer === "iso" ? { layer: "iso", matched: h.matched, ...compactEntry(e.entry) } : { layer: "non-iso", matched: h.matched, code: h.code, name: e?.entry.name, kind: e?.layer === "non-iso" ? e.entry.kind : undefined, status: e?.layer === "non-iso" ? e.entry.status : undefined };
      }),
    };
  });

  app.get<{ Params: { code: string } }>("/api/v2/geography/:code", async (req, reply) => {
    const code = req.params.code.trim();
    if (!/^[A-Za-z0-9-]{2,7}$/.test(code)) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Use an ISO 3166-1 alpha-2, alpha-3 or numeric code, a non-ISO code (XK, EU, UK, EL) or an ISO 3166-2 code (US-CA)." });
    reply.header("cache-control", "public, max-age=3600");
    if (code.includes("-")) {
      const s = subdivision(code);
      if (!s) return reply.code(404).send({ error: "NOT_FOUND" });
      const country = resolveCode(code.split("-")[0]);
      return { layer: "iso3166-2", subdivision: s, country: country?.layer === "iso" ? compactEntry(country.entry) : null, children: subdivisionsOf(s.code.split("-")[0]).filter((x) => x.parent === s.code) };
    }
    const r = resolveCode(code);
    if (!r) return reply.code(404).send({ error: "NOT_FOUND", message: "Not an ISO 3166-1 entry or a code in the non-ISO layer." });
    if (r.layer === "iso") return { layer: "iso3166-1", entry: r.entry, subdivisions: subdivisionsOf(r.entry.alpha2) };
    return { layer: "non-iso", entry: r.entry, ...(r.aliasOf ? { aliasOf: { layer: "iso3166-1", entry: r.aliasOf, subdivisions: subdivisionsOf(r.aliasOf.alpha2) } } : {}) };
  });
}
