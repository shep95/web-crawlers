import { CATEGORIES, CATEGORY_BY_ID, categoryApplies } from "../metadata/categories.js";
import type { ResourceKind } from "../metadata/types.js";
import { CorpusStore, rowToField } from "./store.js";

const STOP = new Set("a an and are as at be by can do does for from has have how i in is it its me my of on or show that the their there these this to was what when where which who why will with find list about any all get tell give please".split(" "));

/** Words in a question that point at specific metadata categories. */
const CATEGORY_TERMS: Array<[RegExp, number[]]> = [
  [/licen[cs]|copyright|rights|reuse|permission/i, [6]],
  [/author|creator|wrote|made by|who/i, [1, 8]],
  [/publish|publisher|source|origin|provenance/i, [8, 12]],
  [/when|date|updated|modified|created|year/i, [12, 11]],
  [/version|release|changelog|revision|changed/i, [11, 10]],
  [/schema|column|field|variable|structure|format/i, [17, 16, 2, 4]],
  [/constraint|required|allowed|valid/i, [18]],
  [/method|methodology|sample|survey|statistic/i, [19, 36]],
  [/quality|missing|null|complete/i, [20]],
  [/where|location|geo|map|coordinates|region|country/i, [13]],
  [/doi|isbn|orcid|identifier|id\b/i, [14]],
  [/cite|citation|reference|related|link/i, [15, 36]],
  [/image|photo|camera|exif/i, [29, 35]],
  [/audio|song|podcast|sound/i, [30]],
  [/video|film|movie|subtitle|caption/i, [31, 38]],
  [/pdf|document|report|pages/i, [32]],
  [/model|dataset card|training|benchmark|ml\b|ai\b/i, [37, 9]],
  [/privacy|personal|sensitive|gdpr/i, [39]],
  [/retention|delete|expire|archive/i, [40, 5]],
  [/hash|checksum|signature|integrity|authentic/i, [41]],
  [/access|login|restricted|open access|free/i, [7]],
  [/tls|dns|certificate|server|network/i, [34]],
  [/accessib|alt text|wcag/i, [38]],
  [/download|views|stars|popular|usage/i, [23]],
];

export interface CorpusSearchOptions {
  limit?: number;
  offset?: number;
  kind?: string;
  category?: number;
  host?: string;
}

function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
}

export function questionTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.-]/gu, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)))].slice(0, 12);
}

/**
 * Answer an ordinary question from the collected corpus: rank resources by
 * BM25 over contents + metadata, then attach matching observations with their
 * evidence, supporting resources, and the meaningful gaps for the categories
 * the question is about.
 */
export function searchCorpus(store: CorpusStore, q: string, opts: CorpusSearchOptions = {}) {
  const started = Date.now();
  const terms = questionTerms(q);
  const intentCats = [...new Set(CATEGORY_TERMS.filter(([re]) => re.test(q)).flatMap(([, c]) => c))];
  const limit = Math.min(opts.limit ?? 10, 50);
  if (!terms.length) return { query: q, terms, intentCategories: intentCats, total: 0, results: [], tookMs: 0 };

  const filters: string[] = ["r.duplicate_of IS NULL", "r.state = 'indexed'"];
  const params: unknown[] = [ftsQuery(terms)];
  if (opts.kind) {
    filters.push("r.kind = ?");
    params.push(opts.kind);
  }
  if (opts.host) {
    filters.push("r.host = ?");
    params.push(opts.host);
  }
  if (opts.category) {
    filters.push("EXISTS (SELECT 1 FROM observations o WHERE o.resource_id = r.id AND o.category = ?)");
    params.push(opts.category);
  }
  const where = filters.join(" AND ");
  const db = store.db;
  const rows = db
    .prepare(`SELECT r.*, bm25(corpus_fts, 6.0, 3.0, 2.0, 1.0, 1.5) AS rank,
        snippet(corpus_fts, 3, '«', '»', ' … ', 18) AS body_snippet,
        snippet(corpus_fts, 2, '«', '»', ' … ', 14) AS meta_snippet
      FROM corpus_fts JOIN resources r ON r.id = corpus_fts.rowid
      WHERE corpus_fts MATCH ? AND ${where}
      ORDER BY rank LIMIT ? OFFSET ?`)
    .all(...params, limit, opts.offset ?? 0) as Array<Record<string, unknown>>;
  const total = (db.prepare(`SELECT COUNT(*) n FROM corpus_fts JOIN resources r ON r.id = corpus_fts.rowid WHERE corpus_fts MATCH ? AND ${where}`).get(...params) as { n: number }).n;

  const likeTerms = terms.map((t) => `%${t}%`);
  const results = rows.map((r) => {
    const id = r.id as number;
    const snap = store.latestSnapshot(id)!;
    // Observations matching the question text, plus everything in the categories it asks about.
    const matchSql = likeTerms.map(() => "o.value_text LIKE ?").join(" OR ");
    const catSql = intentCats.length ? ` OR o.category IN (${intentCats.map(() => "?").join(",")})` : "";
    const obs = db
      .prepare(`SELECT o.* FROM observations o WHERE o.snapshot_id = ? AND o.masked = 0 AND o.category NOT IN (20, 22) AND (${matchSql}${catSql}) ORDER BY (${intentCats.length ? `o.category IN (${intentCats.join(",")})` : "0"}) DESC, o.id LIMIT 14`)
      .all(snap.id, ...likeTerms, ...intentCats)
      .map((x) => rowToField(x as Record<string, unknown>));
    const counts = db.prepare(`SELECT category, COUNT(*) n FROM observations WHERE snapshot_id = ? GROUP BY category`).all(snap.id) as Array<{ category: number; n: number }>;
    const observed = new Set(counts.map((c) => c.category));
    const coverage = store.snapshotRecord(snap.id)?.categories ?? [];
    const gaps = (intentCats.length ? intentCats : []).map((c) => {
      const cov = coverage.find((x) => x.id === c);
      const applicable = categoryApplies(c, (r.kind as ResourceKind) ?? "binary");
      return { category: c, name: CATEGORY_BY_ID.get(c)!.name, state: observed.has(c) ? "observed" : !applicable ? "not_applicable" : cov?.state ?? "not_found_after_inspection" };
    }).filter((g) => g.state !== "observed");
    const supporting = db
      .prepare(`SELECT rel.type, rel.purpose, rel.scope, t.id, t.url, t.title, t.kind, t.state FROM relationships rel JOIN resources t ON t.id = rel.target_id
        WHERE rel.source_id = ? AND (rel.purpose LIKE 'supporting:%' OR rel.purpose IN ('artifact','contained')) ORDER BY t.state = 'indexed' DESC LIMIT 12`)
      .all(id);
    const parents = db.prepare(`SELECT rel.type, rel.purpose, s.id, s.url, s.title FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = ? LIMIT 5`).all(id);
    return {
      resourceId: id,
      url: r.url,
      finalUrl: r.final_url,
      title: r.title,
      description: r.description,
      kind: r.kind,
      host: r.host,
      score: Number((-(r.rank as number)).toFixed(4)),
      snippet: (r.body_snippet as string) || (r.meta_snippet as string) || null,
      retrievedAt: r.retrieved_at,
      indexedAt: r.indexed_at,
      snapshots: r.snapshot_count,
      changes: r.change_count,
      categoriesObserved: [...observed].sort((a, b) => a - b),
      evidence: obs.map((f) => ({ category: f.category, categoryName: CATEGORY_BY_ID.get(f.category)!.name, field: f.field, value: f.value, original: f.original, status: f.status, evidenceType: f.evidenceType, scope: f.scope, method: f.method, extractor: f.extractor, evidence: f.evidence, observedAt: f.observedAt })),
      gaps,
      supportingResources: supporting,
      referencedBy: parents,
    };
  });
  return { query: q, terms, intentCategories: intentCats.map((c) => ({ id: c, name: CATEGORY_BY_ID.get(c)!.name })), total, results, tookMs: Date.now() - started };
}

/** Full evidence view of one collected resource. */
export function resourceDetail(store: CorpusStore, id: number) {
  const r = store.get(id);
  if (!r) return null;
  const snap = store.latestSnapshot(id);
  const fields = snap ? store.observationsFor(snap.id) : [];
  const rec = snap ? store.snapshotRecord(snap.id) : null;
  return {
    resource: r,
    stages: {
      discovered: r.discovered_at,
      retrieved: r.retrieved_at,
      inspected: r.inspected_at,
      extracted: r.extracted_at,
      indexed: r.indexed_at,
      state: r.state,
      lastError: r.last_error,
    },
    categories: rec?.categories ?? CATEGORIES.map((c) => ({ id: c.id, key: c.key, name: c.name, state: "unavailable", fieldCount: 0, note: "not yet retrieved" })),
    quality: rec?.quality ?? null,
    processing: rec?.processing ?? null,
    observations: fields,
    relationships: store.relationshipsOf(id),
    snapshots: store.snapshots(id),
    events: store.eventsFor(id, 50),
  };
}
