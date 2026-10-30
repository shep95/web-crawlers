import { CATEGORIES, CATEGORY_BY_ID, categoryApplies } from "../metadata/categories.js";
import type { MetadataField, ResourceKind } from "../metadata/types.js";
import type { Corpus, LinkedResource, SearchCandidate } from "./types.js";
import { isExcludedHost } from "./host-policy.js";

const STOP = new Set("a an and are as at be by can do does for from has have how i in is it its me my of on or show that the their there these this to was what when where which who why will with find list about any all get tell give please".split(" "));

/** Words in a question that point at specific metadata categories. */
const CATEGORY_TERMS: Array<[RegExp, number[]]> = [
  [/licen[cs]|copyright|rights|reuse|permission/i, [6]],
  [/author|creator|wrote|made by|who/i, [1, 8]],
  [/publish|publisher|source|origin|provenance/i, [8, 12]],
  [/when|date|updated|modified|created|year|period/i, [12, 11]],
  [/version|release|changelog|revision|changed/i, [11, 10]],
  [/schema|column|field|variable|structure|format/i, [17, 16, 2, 4]],
  [/constraint|required|allowed|valid/i, [18]],
  [/method|methodology|sample|survey|statistic/i, [19, 36]],
  [/quality|missing|null|complete/i, [20]],
  [/where|location|geo|map|coordinates|region|country|northern|southern|eastern|western|india|africa|europe|asia|america/i, [13]],
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
  [/dataset|data set|datasets|data\b|research/i, [17, 19, 13, 12, 6, 8, 11]],
];

const RESOURCE_TYPE_TERMS: Array<[RegExp, (r: SearchCandidate) => boolean, string]> = [
  [/\bdatasets?\b|\bdata\b|statistics|csv/i, (r) => ["csv", "json", "xml"].includes(r.kind ?? "") || /dataset|data|package_show|records/i.test(r.url), "dataset"],
  [/\bimages?\b|\bphotos?\b|pictures?/i, (r) => r.kind === "image", "image"],
  [/\bvideos?\b|films?/i, (r) => r.kind === "video", "video"],
  [/\baudio\b|recordings?|podcasts?/i, (r) => r.kind === "audio", "audio"],
  [/\breports?\b|\bpapers?\b|\bpdfs?\b|documents?/i, (r) => r.kind === "pdf" || r.kind === "office", "document"],
];

export interface CorpusSearchOptions {
  limit?: number;
  offset?: number;
  kind?: string;
  category?: number;
  host?: string;
}

export function questionTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.-]/gu, " ").split(/\s+/).map((t) => t.replace(/^[.-]+|[.-]+$/g, "")).filter((t) => t.length > 1 && !STOP.has(t)))].slice(0, 12);
}

const hayCache = new WeakMap<MetadataField, string>();
function valueHay(f: MetadataField): string {
  let h = hayCache.get(f);
  if (h === undefined) {
    h = (typeof f.value === "string" ? f.value : JSON.stringify(f.value) ?? "").toLowerCase();
    hayCache.set(f, h);
  }
  return h;
}

type Fact = { value: unknown; field: string; method: string; evidenceType: string; scope: string; via?: string };

/** Pick the facts a person asking about a resource most wants, each with its evidence trail. */
function factSheet(fields: MetadataField[], supporting: Array<{ link: LinkedResource; fields: MetadataField[] }>) {
  const pick = (specs: Array<[number, string]>, limit = 4, from: MetadataField[] = fields, via?: string): Fact[] => {
    const out: Fact[] = [];
    for (const [cat, field] of specs) for (const f of from) {
      if (out.length >= limit) break;
      if (f.category === cat && f.field === field && f.status !== "extraction_failed" && !out.some((o) => JSON.stringify(o.value) === JSON.stringify(f.value))) {
        out.push({ value: f.value, field: `${CATEGORY_BY_ID.get(cat)!.key}.${field}`, method: f.method, evidenceType: f.evidenceType, scope: f.scope, via });
      }
    }
    return out;
  };
  const fromSupport = (purposeRe: RegExp, specs: Array<[number, string]>) =>
    supporting.filter((s) => purposeRe.test(s.link.purpose ?? "")).flatMap((s) => pick(specs, 2, s.fields, `${s.link.purpose} #${s.link.id}`));
  return {
    publisher: pick([[8, "publisher"], [8, "registryPublisher"], [8, "siteName"], [21, "organization"], [3, "maintainer"], [3, "custodian"]]),
    creators: pick([[1, "author"], [36, "authors"], [32, "author"]], 3),
    spatialCoverage: pick([[13, "spatialCoverage"], [13, "placename"], [13, "boundingBox"], [13, "coordinates"], [13, "region"], [13, "gps"]]),
    temporalCoverage: pick([[12, "temporalCoverage"]], 2),
    dates: pick([[12, "published"], [12, "modified"], [12, "created"], [12, "lastModifiedHeader"]]),
    formats: pick([[4, "mimeType"], [4, "sniffedType"], [4, "format"], [4, "archiveFormat"]], 3),
    structure: pick([[17, "columns"], [17, "schemaType"], [2, "rowCount"], [2, "pageCount"], [31, "duration"], [29, "width"]], 4),
    methods: [...pick([[19, "measurementTechnique"], [19, "methodologyStatement"], [36, "method"], [19, "variables"], [19, "sampleSize"]]), ...fromSupport(/methodology|gap_statistical|gap_scientific/, [[19, "methodologyStatement"], [36, "method"], [19, "sampleSize"]])],
    license: [...pick([[6, "license"], [6, "licenseUrl"], [6, "rightsStatement"], [6, "copyright"]]), ...fromSupport(/rights|gap_rights/, [[6, "license"], [6, "rightsStatement"]])],
    version: [...pick([[11, "version"], [11, "latestRelease"], [11, "revision"], [11, "changedSinceLastSnapshot"]], 3), ...fromSupport(/revision|gap_version/, [[10, "changeEntries"], [12, "modified"]])],
    identifiers: pick([[14, "doi"], [14, "identifier"], [14, "canonicalUrl"], [14, "isbn"], [14, "arxiv"]], 4),
    access: pick([[7, "accessRequiresAuth"], [7, "isAccessibleForFree"], [7, "gated"]], 2),
  };
}

/** A preview image for result cards: the resource itself when it is an image, else its declared share image. */
export function thumbnailFor(r: Pick<SearchCandidate, "kind" | "url" | "final_url">, fields: MetadataField[]): string | null {
  const candidates = r.kind === "image" ? [r.final_url ?? r.url] : fields.filter((f) => f.field === "previewImage" || f.field === "thumbnailUrl").map((f) => f.value);
  for (const v of candidates) {
    if (typeof v !== "string") continue;
    try {
      const u = new URL(v, r.final_url ?? r.url);
      if (u.protocol === "https:" || u.protocol === "http:") return u.href;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/** The site icon a page declares (link rel=icon), if any. */
export function iconFor(fields: MetadataField[]): string | null {
  const f = fields.find((x) => x.field === "siteIcon" && typeof x.value === "string");
  return f && /^https?:\/\//.test(String(f.value)) ? String(f.value) : null;
}

/**
 * Answer an ordinary question from the collected corpus: rank resources by
 * full-text relevance over contents + metadata, boost resource types the
 * question asks for, then attach a fact sheet, matching evidence, supporting
 * resources (and their facts), and the gaps for the categories asked about.
 */
export async function searchCorpus(store: Corpus, q: string, opts: CorpusSearchOptions = {}) {
  const started = Date.now();
  const terms = questionTerms(q);
  const intentCats = [...new Set(CATEGORY_TERMS.filter(([re]) => re.test(q)).flatMap(([, c]) => c))];
  const wantTypes = RESOURCE_TYPE_TERMS.filter(([re]) => re.test(q));
  const limit = Math.min(opts.limit ?? 10, 50);
  const base = { query: q, terms, intentCategories: intentCats.map((c) => ({ id: c, name: CATEGORY_BY_ID.get(c)!.name })), resourceTypes: wantTypes.map(([, , n]) => n) };
  if (!terms.length) return { ...base, total: 0, results: [], tookMs: 0 };

  // Over-fetch, then re-rank with type intent and term coverage.
  // Words that say what *kind* of resource is wanted are handled by the type boost, not required as text.
  const TYPE_WORDS = /^(research|dataset|datasets|data|report|reports|paper|papers|document|documents|image|images|photo|photos|video|videos|audio|recordings?|files?|records?|about|information|resources?)$/i;
  const contentTerms = terms.filter((t) => !TYPE_WORDS.test(t));
  const searchTerms = contentTerms.length ? contentTerms : terms;
  const found = await store.searchResources({ terms: searchTerms, kind: opts.kind, host: opts.host, category: opts.category, limit: Math.min(limit * 3, 100), offset: opts.offset ?? 0 });
  const { total } = found;
  const rows = found.rows.filter((r) => !isExcludedHost(r.host));
  const scored = rows.map((r) => {
    const hay = `${r.title ?? ""} ${r.description ?? ""} ${r.url} ${r.snippet ?? ""}`.toLowerCase();
    const coverageRatio = searchTerms.filter((t) => hay.includes(t)).length / searchTerms.length;
    const typeBoost = wantTypes.some(([, test]) => test(r)) ? 1.5 : 1;
    return { r, score: r.rank * typeBoost * (0.6 + coverageRatio) };
  });
  scored.sort((a, b) => b.score - a.score);

  // Batched loading: a constant number of queries per search, regardless of how many results.
  const top = scored.slice(0, limit);
  const ids = top.map(({ r }) => r.id);
  const [latest, links] = await Promise.all([store.latestSnapshots(ids), store.linksFor(ids)]);
  const supportIds = [...new Set(ids.flatMap((id) => (links.from.get(id) ?? []).filter((l) => l.state === "indexed").slice(0, 6).map((l) => l.id)))];
  const supportLatest = await store.latestSnapshots(supportIds);
  const snapIds = [...latest.values()];
  const [obsBySnap, records] = await Promise.all([store.observationsForSnapshots([...snapIds, ...supportLatest.values()]), store.snapshotRecords(snapIds)]);
  const intentSet = new Set(intentCats);
  const results = [];
  for (const { r, score } of top) {
    const sid = latest.get(r.id);
    if (!sid) continue;
    const all = obsBySnap.get(sid) ?? [];
    const observed = new Set(all.map((f) => f.category));
    const evidenceFields = all
      .filter((f) => !f.masked && f.category !== 20 && f.category !== 22 && (intentSet.has(f.category) || terms.some((t) => valueHay(f).includes(t))))
      .sort((a, b) => Number(intentSet.has(b.category)) - Number(intentSet.has(a.category)))
      .slice(0, 14);
    const supportingLinks = links.from.get(r.id) ?? [];
    const supporting = supportingLinks.filter((l) => supportLatest.has(l.id)).slice(0, 6).map((link) => ({ link, fields: obsBySnap.get(supportLatest.get(link.id)!) ?? [] }));
    const coverage = records.get(sid)?.categories ?? [];
    const gaps = intentCats
      .map((c) => ({ category: c, name: CATEGORY_BY_ID.get(c)!.name, state: observed.has(c) ? "observed" : !categoryApplies(c, (r.kind as ResourceKind) ?? "binary") ? "not_applicable" : coverage.find((x) => x.id === c)?.state ?? "not_found_after_inspection" }))
      .filter((g) => g.state !== "observed");
    results.push({
      resourceId: r.id,
      url: r.url,
      finalUrl: r.final_url,
      title: r.title,
      description: r.description,
      kind: r.kind,
      host: r.host,
      score: Number(score.toFixed(4)),
      snippet: r.snippet,
      retrievedAt: r.retrieved_at,
      indexedAt: r.indexed_at,
      snapshots: r.snapshot_count,
      changes: r.change_count,
      categoriesObserved: [...observed].sort((a, b) => a - b),
      thumbnail: thumbnailFor(r, all),
      icon: iconFor(all),
      facts: factSheet(all, supporting),
      evidence: evidenceFields.map((f) => ({ category: f.category, categoryName: CATEGORY_BY_ID.get(f.category)!.name, field: f.field, value: f.value, original: f.original, status: f.status, evidenceType: f.evidenceType, scope: f.scope, method: f.method, extractor: f.extractor, evidence: f.evidence, observedAt: f.observedAt })),
      gaps,
      supportingResources: supportingLinks,
      referencedBy: links.to.get(r.id) ?? [],
    });
  }
  return { ...base, total, totalIsLowerBound: Boolean(found.totalIsLowerBound), results, tookMs: Date.now() - started };
}

/** Full evidence view of one collected resource. */
export async function resourceDetail(store: Corpus, id: number) {
  const r = await store.get(id);
  if (!r) return null;
  const snap = await store.latestSnapshot(id);
  const [fields, rec, relationships, snapshots, events] = await Promise.all([
    snap ? store.observationsFor(snap.id) : Promise.resolve([]),
    snap ? store.snapshotRecord(snap.id) : Promise.resolve(null),
    store.relationshipsOf(id),
    store.snapshots(id),
    store.eventsFor(id, 50),
  ]);
  return {
    resource: r,
    stages: { discovered: r.discovered_at, retrieved: r.retrieved_at, inspected: r.inspected_at, extracted: r.extracted_at, indexed: r.indexed_at, state: r.state, lastError: r.last_error },
    categories: rec?.categories ?? CATEGORIES.map((c) => ({ id: c.id, key: c.key, name: c.name, state: "unavailable", fieldCount: 0, note: "not yet retrieved" })),
    quality: rec?.quality ?? null,
    processing: rec?.processing ?? null,
    observations: fields,
    relationships,
    snapshots,
    events,
  };
}
