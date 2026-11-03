import { CATEGORIES } from "../metadata/categories.js";
import { CATEGORY_STATES, FIELD_STATUSES } from "./facets.js";
import { IN_FLIGHT_STATES, LEGACY_REASON_SQL, LIFECYCLE_EXPR, LIFECYCLE_STATES } from "./lifecycle.js";

/**
 * Coverage observability (GET /api/v2/coverage). Every number is an aggregate over stored rows —
 * nothing is estimated or padded. Counts are always numbers (0 = measured zero). Values that were
 * not measured are the string "unknown". Averages / timestamps over an empty set are null.
 */

/** Minimal country registry interface. The geography registry (src/geo) will supply all 249 ISO 3166-1 entries. */
export interface CountryEntry {
  code: string; // ISO 3166-1 alpha-2, upper case
  name: string;
}

export interface Dialect {
  /** Seconds since epoch of an ISO-8601 text column. */
  epoch(col: string): string;
  /** Label after the last dot of a host column. */
  tld(col: string): string;
}

export const SQLITE_DIALECT: Dialect = {
  epoch: (c) => `((julianday(${c}) - 2440587.5) * 86400.0)`,
  // rtrim strips the trailing label (all non-dot chars); replace removes the remaining prefix.
  tld: (c) => `lower(replace(${c}, rtrim(${c}, replace(${c}, '.', '')), ''))`,
};

export const PG_DIALECT: Dialect = {
  epoch: (c) => `EXTRACT(EPOCH FROM (${c})::timestamptz)`,
  tld: (c) => `lower(regexp_replace(${c}, '^.*\\.', ''))`,
};

const BASE = `SELECT id, host, via, kind, mime, language, content_hash, retrieved_at, inspected_at, extracted_at, indexed_at, published_at,
  field_count, categories_observed, facets_at, validation_issues, lifecycle_reason, last_error, http_status, state, duplicate_of, ${LIFECYCLE_EXPR} AS lc FROM resources`;

/** One aggregate row per dimension value. Portable across SQLite and Postgres (no parameters). */
export function metricsSql(d: Dialect, dim: string | null, nowMs: number): string {
  const nowS = Math.floor(nowMs / 1000);
  const ep = d.epoch("retrieved_at");
  const st = (s: string) => `SUM(CASE WHEN lc = '${s}' THEN 1 ELSE 0 END)`;
  return `SELECT ${dim ?? "'all'"} AS k,
    COUNT(*) AS discovered,
    SUM(CASE WHEN retrieved_at IS NOT NULL THEN 1 ELSE 0 END) AS fetched,
    SUM(CASE WHEN inspected_at IS NOT NULL THEN 1 ELSE 0 END) AS inspected,
    SUM(CASE WHEN extracted_at IS NOT NULL THEN 1 ELSE 0 END) AS extracted,
    SUM(CASE WHEN validation_issues IS NOT NULL THEN 1 ELSE 0 END) AS validated,
    SUM(CASE WHEN validation_issues IS NOT NULL AND validation_issues <> '' THEN 1 ELSE 0 END) AS validated_with_issues,
    ${st("indexed")} AS indexed, ${st("superseded")} AS superseded, ${st("restricted")} AS restricted, ${st("skipped")} AS skipped,
    ${st("unavailable")} AS unavailable, ${st("failed_retryable")} AS failed_retryable, ${st("permanently_failed")} AS permanently_failed,
    ${st("discovered")} AS awaiting_first_fetch, ${st("scheduled")} AS scheduled,
    SUM(CASE WHEN lc IN (${IN_FLIGHT_STATES.map((s) => `'${s}'`).join(", ")}) THEN 1 ELSE 0 END) AS in_flight,
    COUNT(DISTINCT content_hash) AS unique_hashes,
    SUM(CASE WHEN via = 'archive_entry' AND inspected_at IS NOT NULL THEN 1 ELSE 0 END) AS archive_children_inspected,
    SUM(CASE WHEN facets_at IS NOT NULL THEN 1 ELSE 0 END) AS facets_measured,
    SUM(CASE WHEN facets_at IS NOT NULL THEN field_count ELSE 0 END) AS fields_sum,
    SUM(CASE WHEN facets_at IS NOT NULL THEN COALESCE(categories_observed, 0) ELSE 0 END) AS cats_sum,
    MAX(indexed_at) AS last_indexed_at,
    MAX(retrieved_at) AS last_fetched_at,
    MAX(published_at) AS newest_published,
    SUM(CASE WHEN lc = 'indexed' AND retrieved_at IS NOT NULL THEN ${nowS} - ${ep} ELSE 0 END) AS lag_sum_s,
    MAX(CASE WHEN lc = 'indexed' AND retrieved_at IS NOT NULL THEN ${nowS} - ${ep} END) AS lag_max_s,
    SUM(CASE WHEN lc = 'indexed' AND retrieved_at IS NOT NULL THEN 1 ELSE 0 END) AS lag_n
  FROM (${BASE}) x${dim ? " GROUP BY 1" : ""}`;
}

export function coverageQueries(d: Dialect, nowMs: number) {
  return {
    totals: metricsSql(d, null, nowMs),
    byTld: metricsSql(d, d.tld("host"), nowMs),
    byLanguage: metricsSql(d, `CASE WHEN facets_at IS NULL THEN NULL ELSE COALESCE(language, '') END`, nowMs),
    byKind: metricsSql(d, "kind", nowMs),
    // Files no web page links to (found via listings, archives, feeds, APIs): one anti-join, grouped by kind.
    standalone: `SELECT r.kind AS k, COUNT(*) AS n FROM resources r WHERE r.kind IS NOT NULL AND r.kind NOT IN ('webpage', 'feed')
      AND NOT EXISTS (SELECT 1 FROM relationships rel JOIN resources p ON p.id = rel.source_id WHERE rel.target_id = r.id AND p.kind = 'webpage') GROUP BY r.kind`,
    byMime: metricsSql(d, "mime", nowMs),
    byVia: metricsSql(d, "via", nowMs),
    byLifecycle: `SELECT lc AS k, COUNT(*) AS n FROM (${BASE}) x GROUP BY 1`,
    failures: `SELECT lc AS state, COALESCE(lifecycle_reason, ${LEGACY_REASON_SQL}) AS reason, COUNT(*) AS n FROM (${BASE}) x
      WHERE lc IN ('failed_retryable', 'permanently_failed', 'restricted', 'skipped', 'unavailable', 'superseded') GROUP BY 1, 2`,
    issues: `SELECT validation_issues AS k, COUNT(*) AS n FROM resources WHERE validation_issues IS NOT NULL AND validation_issues <> '' GROUP BY 1`,
    categories: `SELECT category, state, COUNT(*) AS resources, SUM(fields) AS fields, ${FIELD_STATUSES.map((s) => `SUM(${s}) AS ${s}`).join(", ")} FROM resource_coverage GROUP BY category, state`,
    progress: `SELECT to_state AS k, COUNT(*) AS n FROM transitions WHERE ts >= '${new Date(nowMs - 86400_000).toISOString()}' GROUP BY 1`,
  };
}

export type Raw = Record<string, unknown>;
export interface CoverageRaw {
  now: number;
  backend: string;
  totals: Raw;
  byTld: Raw[];
  byLanguage: Raw[];
  byKind: Raw[];
  byMime: Raw[];
  byVia: Raw[];
  byLifecycle: Raw[];
  failures: Raw[];
  issues: Raw[];
  categories: Raw[];
  progress: Raw[];
  standalone: Raw[];
}

/** Runs every coverage query with one executor (each backend supplies `all(sql)`). */
export async function collectCoverage(all: (sql: string) => Promise<Raw[]>, d: Dialect, backend: string, nowMs: number): Promise<CoverageRaw> {
  const q = coverageQueries(d, nowMs);
  const keys = Object.keys(q) as Array<keyof typeof q>;
  const results = await Promise.all(keys.map((k) => all(q[k])));
  const out = { now: nowMs, backend } as CoverageRaw;
  keys.forEach((k, i) => ((out as unknown as Record<string, unknown>)[k] = k === "totals" ? results[i][0] ?? {} : results[i]));
  return out;
}

// ---------------------------------------------------------------- report

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const avg = (sum: number, n: number) => (n > 0 ? Number((sum / n).toFixed(2)) : null);
const hours = (s: number) => Number((s / 3600).toFixed(2));

export interface Metrics {
  discovered: number;
  fetched: number;
  inspected: number;
  extracted: number;
  validated: number;
  validatedWithIssues: number;
  indexed: number;
  superseded: number;
  restricted: number;
  skipped: number;
  unavailable: number;
  failedRetryable: number;
  permanentlyFailed: number;
  awaitingFirstFetch: number;
  scheduled: number;
  inFlight: number;
  uniqueContentHashes: number;
  /** Set when groups were summed (a hash present in two groups is counted twice). */
  uniqueContentHashesIsUpperBound?: boolean;
  archiveChildrenInspected: number;
  standaloneFiles?: number;
  facetsMeasured: number;
  facetsUnmeasured: number;
  avgFieldsPerResource: number | null;
  avgCategoriesObservedPerResource: number | null;
  lastSuccessfulCrawlAt: string | null;
  lastFetchAt: string | null;
  newestObservedPublication: string | null;
  freshness: { indexedResources: number; avgHoursSinceRetrieval: number | null; maxHoursSinceRetrieval: number | null };
}

export function toMetrics(r: Raw): Metrics {
  const fetched = num(r.fetched);
  const measured = num(r.facets_measured);
  const lagN = num(r.lag_n);
  const m: Metrics = {
    discovered: num(r.discovered),
    fetched,
    inspected: num(r.inspected),
    extracted: num(r.extracted),
    validated: num(r.validated),
    validatedWithIssues: num(r.validated_with_issues),
    indexed: num(r.indexed),
    superseded: num(r.superseded),
    restricted: num(r.restricted),
    skipped: num(r.skipped),
    unavailable: num(r.unavailable),
    failedRetryable: num(r.failed_retryable),
    permanentlyFailed: num(r.permanently_failed),
    awaitingFirstFetch: num(r.awaiting_first_fetch),
    scheduled: num(r.scheduled),
    inFlight: num(r.in_flight),
    uniqueContentHashes: num(r.unique_hashes),
    archiveChildrenInspected: num(r.archive_children_inspected),
    facetsMeasured: measured,
    facetsUnmeasured: Math.max(0, fetched - measured),
    avgFieldsPerResource: avg(num(r.fields_sum), measured),
    avgCategoriesObservedPerResource: avg(num(r.cats_sum), measured),
    lastSuccessfulCrawlAt: (r.last_indexed_at as string) ?? null,
    lastFetchAt: (r.last_fetched_at as string) ?? null,
    newestObservedPublication: (r.newest_published as string) ?? null,
    freshness: { indexedResources: lagN, avgHoursSinceRetrieval: lagN ? hours(num(r.lag_sum_s) / lagN) : null, maxHoursSinceRetrieval: lagN ? hours(num(r.lag_max_s)) : null },
  };
  return m;
}

const ZERO = toMetrics({});

function sumMetrics(list: Metrics[]): Metrics {
  if (!list.length) return { ...ZERO, freshness: { ...ZERO.freshness } };
  const keys = ["discovered", "fetched", "inspected", "extracted", "validated", "validatedWithIssues", "indexed", "superseded", "restricted", "skipped", "unavailable", "failedRetryable", "permanentlyFailed", "awaitingFirstFetch", "scheduled", "inFlight", "archiveChildrenInspected", "facetsMeasured", "facetsUnmeasured"] as const;
  const out = { ...ZERO } as Metrics;
  for (const k of keys) (out as unknown as Record<string, number>)[k] = list.reduce((a, m) => a + m[k], 0);
  // Distinct hashes cannot be summed across groups; the sum is an upper bound.
  out.uniqueContentHashes = list.reduce((a, m) => a + m.uniqueContentHashes, 0);
  if (list.length > 1) out.uniqueContentHashesIsUpperBound = true;
  const wsum = (f: (m: Metrics) => number | null, w: (m: Metrics) => number) => {
    const n = list.reduce((a, m) => a + (f(m) === null ? 0 : w(m)), 0);
    return n ? Number((list.reduce((a, m) => a + (f(m) ?? 0) * w(m), 0) / n).toFixed(2)) : null;
  };
  out.avgFieldsPerResource = wsum((m) => m.avgFieldsPerResource, (m) => m.facetsMeasured);
  out.avgCategoriesObservedPerResource = wsum((m) => m.avgCategoriesObservedPerResource, (m) => m.facetsMeasured);
  const max = (f: (m: Metrics) => string | null) => list.map(f).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  out.lastSuccessfulCrawlAt = max((m) => m.lastSuccessfulCrawlAt);
  out.lastFetchAt = max((m) => m.lastFetchAt);
  out.newestObservedPublication = max((m) => m.newestObservedPublication);
  const n = list.reduce((a, m) => a + m.freshness.indexedResources, 0);
  out.freshness = {
    indexedResources: n,
    avgHoursSinceRetrieval: wsum((m) => m.freshness.avgHoursSinceRetrieval, (m) => m.freshness.indexedResources),
    maxHoursSinceRetrieval: list.reduce<number | null>((a, m) => (m.freshness.maxHoursSinceRetrieval === null ? a : Math.max(a ?? 0, m.freshness.maxHoursSinceRetrieval)), null),
  };
  return out;
}

// ---------------------------------------------------------------- hosting country (weak signal)

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  } catch {
    return null;
  }
})();

/** ccTLDs whose registrations are mostly unrelated to the country (marketed as generic). */
export const GENERIC_USE_CCTLDS = new Set(["io", "co", "tv", "me", "ai", "fm", "ly", "gg", "ws", "cc", "to", "so", "sh", "am", "nu", "tk", "ac", "vc", "la", "is", "im", "xyz"]);
const TLD_EXCEPTIONS: Record<string, string | null> = { uk: "GB", ac: "SH", tp: "TL", eu: null, su: null };

export type TldClass = { type: "cctld"; country: string; genericUse: boolean } | { type: "generic" | "supranational_or_legacy" | "ip_literal" | "unassigned_cctld" | "none" };

export function classifyTld(tld: string | null | undefined): TldClass {
  const t = (tld ?? "").toLowerCase();
  if (!t) return { type: "none" };
  if (/^\d+$/.test(t) || t.includes(":") || t.includes("]")) return { type: "ip_literal" };
  if (!/^[a-z]{2}$/.test(t)) return { type: "generic" };
  if (t in TLD_EXCEPTIONS) {
    const c = TLD_EXCEPTIONS[t];
    return c ? { type: "cctld", country: c, genericUse: GENERIC_USE_CCTLDS.has(t) } : { type: "supranational_or_legacy" };
  }
  const code = t.toUpperCase();
  if (regionNames && !regionNames.of(code)) return { type: "unassigned_cctld" };
  return { type: "cctld", country: code, genericUse: GENERIC_USE_CCTLDS.has(t) };
}

/** Temporary registry until src/geo lands: the countries whose ccTLDs actually appear in the corpus. */
export function countriesFromObservedTlds(tlds: string[]): CountryEntry[] {
  const out = new Map<string, CountryEntry>();
  for (const t of tlds) {
    const c = classifyTld(t);
    if (c.type === "cctld") out.set(c.country, { code: c.country, name: regionNames?.of(c.country) ?? c.country });
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------- build

export interface CoverageOptions {
  /** Full country registry (ISO alpha-2). Omit to use the temporary ccTLD-derived list. */
  countries?: CountryEntry[] | null;
  registrySource?: string;
}

export function buildCoverageReport(raw: CoverageRaw, opts: CoverageOptions = {}) {
  const standalone = new Map(raw.standalone.map((r) => [String(r.k), num(r.n)]));
  const totals = { ...toMetrics(raw.totals), standaloneFiles: [...standalone.values()].reduce((a, b) => a + b, 0) };
  const tldRows = raw.byTld.map((r) => ({ tld: String(r.k ?? ""), m: toMetrics(r) }));
  const registry = opts.countries?.length ? opts.countries : countriesFromObservedTlds(tldRows.map((r) => r.tld));
  const registrySource = opts.countries?.length ? opts.registrySource ?? "provided" : "temporary: derived from ccTLDs observed in the corpus (src/geo registry not available)";
  const perCountry = new Map<string, { tlds: string[]; list: Metrics[]; genericUse: boolean }>();
  const other: Record<string, { tlds: string[]; list: Metrics[] }> = {};
  for (const { tld, m } of tldRows) {
    const c = classifyTld(tld);
    if (c.type === "cctld") {
      const e = perCountry.get(c.country) ?? { tlds: [], list: [], genericUse: false };
      e.tlds.push(tld);
      e.list.push(m);
      e.genericUse ||= c.genericUse;
      perCountry.set(c.country, e);
    } else {
      const e = (other[c.type] ??= { tlds: [], list: [] });
      e.tlds.push(tld);
      e.list.push(m);
    }
  }
  const countries = registry.map((c) => {
    const code = c.code.toUpperCase();
    const hit = perCountry.get(code);
    return {
      code,
      name: c.name,
      hostingTld: {
        // Measured: every stored host was classified by TLD; no host with this ccTLD means 0.
        tlds: hit?.tlds ?? [],
        genericUseCcTld: hit?.genericUse ?? GENERIC_USE_CCTLDS.has(code.toLowerCase()),
        ...sumMetrics(hit?.list ?? []),
      },
      publisherCountry: "unknown" as const,
      subjectCountry: "unknown" as const,
    };
  });
  const unregistered = [...perCountry.keys()].filter((k) => !registry.some((c) => c.code.toUpperCase() === k));

  const dim = (rows: Raw[], label: string, map: (k: string | null) => string = (k) => k ?? "unknown") =>
    rows.map((r) => ({ [label]: map((r.k as string | null) ?? null), ...toMetrics(r) })).sort((a, b) => b.discovered - a.discovered);

  const families = new Map<string, { list: Metrics[]; vias: Array<{ via: string } & Metrics> }>();
  for (const r of raw.byVia) {
    const via = String(r.k ?? "unknown");
    const fam = via.split(":")[0];
    const m = toMetrics(r);
    const e = families.get(fam) ?? { list: [], vias: [] };
    e.list.push(m);
    e.vias.push({ via, ...m });
    families.set(fam, e);
  }

  const measuredResources = totals.facetsMeasured;
  const unmeasuredResources = totals.facetsUnmeasured;
  const byCategory = CATEGORIES.map((c) => {
    const rows = raw.categories.filter((r) => Number(r.category) === c.id);
    const resources = Object.fromEntries(CATEGORY_STATES.map((s) => [s, 0])) as Record<string, number>;
    const fields = Object.fromEntries(FIELD_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    let stored = 0;
    for (const r of rows) {
      resources[String(r.state)] = (resources[String(r.state)] ?? 0) + num(r.resources);
      stored += num(r.resources);
      for (const s of FIELD_STATUSES) fields[s] += num(r[s]);
    }
    // not_applicable rows are not stored (they never carry fields): derived from the measured total.
    resources.not_applicable = Math.max(0, measuredResources - stored);
    return { id: c.id, key: c.key, name: c.name, resources: { ...resources, unknown: unmeasuredResources }, fields, fieldsTotal: Object.values(fields).reduce((a, b) => a + b, 0) };
  });

  const byLifecycle = Object.fromEntries(LIFECYCLE_STATES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of raw.byLifecycle) byLifecycle[String(r.k)] = num(r.n);
  const progressLast24h = Object.fromEntries(LIFECYCLE_STATES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of raw.progress) progressLast24h[String(r.k)] = num(r.n);
  const issueCounts: Record<string, number> = {};
  for (const r of raw.issues) for (const code of String(r.k).split(",").filter(Boolean)) issueCounts[code] = (issueCounts[code] ?? 0) + num(r.n);

  return {
    generatedAt: new Date(raw.now).toISOString(),
    backend: raw.backend,
    semantics: {
      counts: "measured aggregates over stored resources; 0 means measured zero",
      unknown: "the string \"unknown\" marks dimensions this system has not measured",
      nullValues: "averages and timestamps are null when there is nothing to average or no such event",
      stages: "fetched = a transport response arrived (any status); inspected/extracted = content (not an error page) went through the format extractors; validated = record checked; indexed = searchable",
      facets: "language, publication date, category/field-status breakdowns are measured per processing round (facetsMeasured); resources processed before lifecycle-v1 count as facetsUnmeasured until revisited or backfilled",
    },
    totals,
    byLifecycle,
    progressLast24h,
    failures: raw.failures.map((r) => ({ state: String(r.state), reason: (r.reason as string | null) ?? "unrecorded", count: num(r.n) })).sort((a, b) => b.count - a.count),
    validationIssues: issueCounts,
    byCountry: {
      hostingSignal: {
        method: "country-code top-level domain of the resource host",
        strength: "weak",
        caveat: "where a site is registered/hosted says little about who publishes it or what it is about; generic-use ccTLDs (.io, .co, .tv, .ai …) are flagged",
      },
      publisherAndSubjectCountry: "unknown — not measured until the geography registry (src/geo) resolves publisher/spatial facts; never inferred from the TLD",
      registry: { source: registrySource, entries: registry.length },
      countries,
      ccTldsOutsideRegistry: unregistered,
      nonCountryHosts: Object.fromEntries(Object.entries(other).map(([k, v]) => [k, { tlds: v.tlds.slice(0, 50), ...sumMetrics(v.list) }])),
    },
    byLanguage: {
      source: "Descriptive.language observations (primary subtag); '' = inspected, no language declared or detected",
      unmeasuredResources,
      languages: dim(raw.byLanguage.filter((r) => r.k !== null && r.k !== undefined), "language", (k) => k || "none_found"),
    },
    byKind: dim(raw.byKind, "kind", (k) => k ?? "not_inspected").map((k) => ({ ...k, standaloneFiles: standalone.get(String((k as Record<string, unknown>).kind)) ?? 0 })),
    byMime: dim(raw.byMime, "mime", (k) => k ?? "not_inspected"),
    bySourceFamily: [...families].map(([family, e]) => ({ family, ...sumMetrics(e.list), vias: e.vias.sort((a, b) => b.discovered - a.discovered).slice(0, 25) })).sort((a, b) => b.discovered - a.discovered),
    byCategory: {
      resourcesMeasured: measuredResources,
      resourcesUnknown: unmeasuredResources,
      categories: byCategory,
    },
  };
}

export type CoverageReport = ReturnType<typeof buildCoverageReport>;
