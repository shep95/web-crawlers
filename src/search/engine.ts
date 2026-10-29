import { createHash } from "node:crypto";
import { PROVIDERS, type Highlight, type Provider, type ProviderHit, type ResultType } from "./providers.js";
import { CATEGORY_BY_ID } from "../metadata/categories.js";
import { DOI_RE } from "../metadata/normalize.js";
import { LruCache } from "../util/async.js";

export interface QueryIntent {
  kind: "url" | "doi" | "arxiv" | "keyword";
  normalized: string;
  /** Provider weights (0 = skip). */
  weights: Record<string, number>;
  /** Metadata categories the query is most likely about. */
  categories: number[];
  reason: string;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string | null;
  type: ResultType;
  date: string | null;
  identifiers: ProviderHit["identifiers"];
  highlights: Array<Highlight & { categoryName: string }>;
  categories: number[];
  score: number;
  scoreBreakdown: { fusion: number; lexical: number; identifier: number; freshness: number };
  sources: Array<{ provider: string; rank: number; apiUrl: string; retrievedAt: string }>;
}

export interface ProviderStatus {
  provider: string;
  name: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
  skipped?: "circuit_open" | "intent";
}

export interface SearchResponse {
  query: string;
  intent: QueryIntent;
  results: SearchResult[];
  providers: ProviderStatus[];
  tookMs: number;
  cache: "hit" | "miss";
  cachedAgeSeconds?: number;
  generatedAt: string;
}

// ------------------------------------------------------------------ intent

const DATA_WORDS = /\b(dataset|datasets|data|statistics|census|survey|csv|open data|indicator)\b/i;
const MODEL_WORDS = /\b(model|llm|transformer|bert|gpt|llama|diffusion|embedding|fine-?tun\w*|checkpoint)\b/i;
const PAPER_WORDS = /\b(paper|study|research|journal|doi|preprint|arxiv|citation|meta-analysis|trial)\b/i;
const CODE_WORDS = /\b(library|framework|sdk|repo|repository|github|package|npm|pypi|crate|open source)\b/i;
const CATEGORY_HINTS: Array<[RegExp, number[]]> = [
  [/\blicen[cs]e|copyright|rights|reuse\b/i, [6]],
  [/\bprivacy|gdpr|personal data|pii\b/i, [39, 40]],
  [/\bversion|release|changelog\b/i, [11, 10]],
  [/\bimage|photo|exif|camera\b/i, [29, 35]],
  [/\bvideo|audio|podcast|codec\b/i, [30, 31]],
  [/\bpdf|document|report\b/i, [32]],
  [/\bmap|geo|location|spatial|coordinates\b/i, [13]],
  [/\bschema|api|openapi|json schema\b/i, [17, 18]],
  [/\baccessib|caption|wcag|alt text\b/i, [38]],
  [/\bchecksum|hash|sha|signature|integrity\b/i, [41]],
];

export function parseIntent(q: string): QueryIntent {
  const query = q.trim();
  const weights: Record<string, number> = Object.fromEntries(PROVIDERS.map((p) => [p.id, 1]));
  const categories = new Set<number>([1, 8, 12, 14]);
  const doi = query.match(new RegExp(`^(?:doi:\\s*|https?://(?:dx\\.)?doi\\.org/)?${DOI_RE.source.replace(/^\\b/, "")}$`, "i"));
  if (doi) {
    return { kind: "doi", normalized: doi[1].toLowerCase(), weights: { crossref: 3, openalex: 2 }, categories: [14, 36, 1, 6], reason: "query is a DOI" };
  }
  if (/^https?:\/\/\S+$/i.test(query)) {
    return { kind: "url", normalized: query, weights: {}, categories: [], reason: "query is a URL — analyze it directly" };
  }
  const arxiv = query.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
  if (arxiv) return { kind: "arxiv", normalized: arxiv[1], weights: { arxiv: 3 }, categories: [14, 36, 11], reason: "query is an arXiv id" };
  const reasons: string[] = [];
  if (DATA_WORDS.test(query)) {
    weights.datagov = 2.2;
    weights.internet_archive = 1.3;
    weights.huggingface = 1.3;
    [3, 17, 19, 13].forEach((c) => categories.add(c));
    reasons.push("dataset terms");
  }
  if (MODEL_WORDS.test(query)) {
    weights.huggingface = 2.4;
    weights.arxiv = 1.5;
    [37, 9, 6].forEach((c) => categories.add(c));
    reasons.push("ML terms");
  }
  if (PAPER_WORDS.test(query)) {
    weights.crossref = 2;
    weights.openalex = 2;
    weights.arxiv = Math.max(weights.arxiv, 1.6);
    [36, 15].forEach((c) => categories.add(c));
    reasons.push("scholarly terms");
  }
  if (CODE_WORDS.test(query)) {
    weights.github = 2.2;
    [10, 11, 6, 23].forEach((c) => categories.add(c));
    reasons.push("software terms");
  }
  for (const [re, cats] of CATEGORY_HINTS) if (re.test(query)) cats.forEach((c) => categories.add(c));
  return { kind: "keyword", normalized: query, weights, categories: [...categories], reason: reasons.length ? reasons.join(", ") : "general keyword query" };
}

// ------------------------------------------------------------------ circuit breaker

const breaker = new Map<string, { failures: number; openUntil: number }>();
function circuitOpen(id: string): boolean {
  const s = breaker.get(id);
  return Boolean(s && s.openUntil > Date.now());
}
function recordOutcome(id: string, ok: boolean): void {
  const s = breaker.get(id) ?? { failures: 0, openUntil: 0 };
  if (ok) s.failures = 0;
  else if (++s.failures >= 3) {
    s.openUntil = Date.now() + 60_000 * Math.min(10, s.failures - 2);
  }
  breaker.set(id, s);
}
export function providerHealth() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, failures: breaker.get(p.id)?.failures ?? 0, circuitOpen: circuitOpen(p.id) }));
}

// ------------------------------------------------------------------ ranking

function canonicalKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

const tokenize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 1);

function lexicalScore(query: string, title: string, snippet: string | null): number {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return 0;
  const t = new Set(tokenize(title));
  const s = new Set(tokenize(snippet ?? ""));
  let score = 0;
  for (const term of q) score += t.has(term) ? 1 : s.has(term) ? 0.35 : 0;
  const phrase = title.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0;
  return Math.min(1.5, score / q.length + phrase);
}

/**
 * Merge per-provider hits. Duplicates are collapsed ONLY on exact identifier
 * or canonical-URL equality — similar titles are never treated as identical.
 */
export function mergeAndRank(query: string, intent: QueryIntent, batches: Array<{ provider: Provider; hits: ProviderHit[]; retrievedAt: string; apiUrl: string }>): SearchResult[] {
  const byKey = new Map<string, SearchResult>();
  const keysFor = (h: ProviderHit) => [
    h.identifiers.doi && `doi:${h.identifiers.doi}`,
    h.identifiers.arxiv && `arxiv:${h.identifiers.arxiv.replace(/v\d+$/, "")}`,
    `url:${canonicalKey(h.url)}`,
  ].filter(Boolean) as string[];

  for (const { provider, hits, retrievedAt, apiUrl } of batches) {
    const w = intent.weights[provider.id] ?? 1;
    for (const h of hits) {
      const keys = keysFor(h);
      const existing = keys.map((k) => byKey.get(k)).find(Boolean);
      const fusion = w / (60 + h.rank); // reciprocal-rank fusion (k=60)
      const src = { provider: provider.id, rank: h.rank, apiUrl, retrievedAt };
      const hl = h.highlights.filter((x) => x.value !== null && x.value !== undefined && !(Array.isArray(x.value) && !x.value.length)).map((x) => ({ ...x, categoryName: CATEGORY_BY_ID.get(x.category)?.name ?? String(x.category) }));
      if (existing) {
        existing.sources.push(src);
        existing.scoreBreakdown.fusion += fusion;
        existing.highlights.push(...hl.filter((x) => !existing.highlights.some((e) => e.category === x.category && e.field === x.field)));
        existing.identifiers = { ...h.identifiers, ...existing.identifiers };
        if (!existing.snippet && h.snippet) existing.snippet = h.snippet;
        if (!existing.date && h.date) existing.date = h.date;
        for (const k of keys) byKey.set(k, existing);
        continue;
      }
      const r: SearchResult = {
        id: createHash("sha1").update(keys[0]).digest("hex").slice(0, 12),
        title: h.title,
        url: h.url,
        snippet: h.snippet,
        type: h.type,
        date: h.date,
        identifiers: h.identifiers,
        highlights: hl,
        categories: [],
        score: 0,
        scoreBreakdown: { fusion, lexical: 0, identifier: 0, freshness: 0 },
        sources: [src],
      };
      for (const k of keys) byKey.set(k, r);
    }
  }
  const results = [...new Set(byKey.values())];
  const now = Date.now();
  for (const r of results) {
    r.scoreBreakdown.lexical = lexicalScore(query, r.title, r.snippet);
    const idq = intent.normalized.toLowerCase();
    r.scoreBreakdown.identifier = intent.kind !== "keyword" && Object.values(r.identifiers).some((v) => v && String(v).toLowerCase() === idq) ? 1 : 0;
    const age = r.date ? (now - Date.parse(r.date)) / (365 * 86400_000) : null;
    r.scoreBreakdown.freshness = age === null ? 0 : Math.max(0, 0.15 - 0.03 * Math.max(0, age));
    // Fusion is ~1/60 per provider; scale so ranking, lexical match and identifiers are comparable.
    r.score = Number((r.scoreBreakdown.fusion * 40 + r.scoreBreakdown.lexical + r.scoreBreakdown.identifier * 3 + r.scoreBreakdown.freshness + (r.sources.length - 1) * 0.15).toFixed(4));
    r.categories = [...new Set(r.highlights.map((h) => h.category))].sort((a, b) => a - b);
  }
  return results.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ orchestration

const searchCache = new LruCache<SearchResponse>(500, Number(process.env.SEARCH_CACHE_TTL_MS ?? 5 * 60_000));

export interface SearchOptions {
  limit?: number;
  perProvider?: number;
  providers?: string[];
  fresh?: boolean;
  signal?: AbortSignal;
  onProvider?: (status: ProviderStatus, partial: SearchResult[]) => void;
}

export async function federatedSearch(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const started = Date.now();
  const intent = parseIntent(query);
  const limit = Math.min(opts.limit ?? 30, 100);
  const per = Math.min(opts.perProvider ?? 8, 20);
  const key = `${intent.normalized.toLowerCase()}|${limit}|${per}|${(opts.providers ?? []).join(",")}`;
  if (!opts.fresh) {
    const hit = searchCache.get(key);
    if (hit) return { ...hit.value, cache: "hit", cachedAgeSeconds: Math.round(hit.ageMs / 1000) };
  }
  const chosen = PROVIDERS.filter((p) => (!opts.providers?.length || opts.providers.includes(p.id)));
  const statuses: ProviderStatus[] = [];
  const batches: Array<{ provider: Provider; hits: ProviderHit[]; retrievedAt: string; apiUrl: string }> = [];
  const searchTerm = intent.kind === "doi" ? intent.normalized : intent.kind === "arxiv" ? intent.normalized : query.trim();

  await Promise.all(
    chosen.map(async (p) => {
      const weight = intent.weights[p.id] ?? 0;
      if (intent.kind !== "keyword" && !weight) {
        statuses.push({ provider: p.id, name: p.name, ok: true, count: 0, ms: 0, skipped: "intent" });
        return;
      }
      if (circuitOpen(p.id)) {
        statuses.push({ provider: p.id, name: p.name, ok: false, count: 0, ms: 0, skipped: "circuit_open", error: "temporarily disabled after repeated failures" });
        return;
      }
      const t0 = Date.now();
      try {
        const hits = await p.search(searchTerm, per);
        if (opts.signal?.aborted) return;
        recordOutcome(p.id, true);
        batches.push({ provider: p, hits, retrievedAt: new Date().toISOString(), apiUrl: p.requestUrl(searchTerm, per) });
        const status = { provider: p.id, name: p.name, ok: true, count: hits.length, ms: Date.now() - t0 };
        statuses.push(status);
        opts.onProvider?.(status, mergeAndRank(query, intent, batches).slice(0, limit));
      } catch (err) {
        recordOutcome(p.id, false);
        const status = { provider: p.id, name: p.name, ok: false, count: 0, ms: Date.now() - t0, error: (err as Error).message.slice(0, 200) };
        statuses.push(status);
        opts.onProvider?.(status, mergeAndRank(query, intent, batches).slice(0, limit));
      }
    }),
  );
  const response: SearchResponse = {
    query,
    intent,
    results: mergeAndRank(query, intent, batches).slice(0, limit),
    providers: statuses.sort((a, b) => a.provider.localeCompare(b.provider)),
    tookMs: Date.now() - started,
    cache: "miss",
    generatedAt: new Date().toISOString(),
  };
  // Only cache when at least one provider answered — never pin an outage.
  if (statuses.some((s) => s.ok && s.count > 0)) searchCache.set(key, response);
  return response;
}
