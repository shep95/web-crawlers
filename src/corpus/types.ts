import type { CategoryCoverage, MetadataField, QualityReport, Relationship, ResourceRecord } from "../metadata/types.js";

export type ResourceState =
  | "queued" // discovered, waiting for retrieval
  | "leased" // a worker is processing it
  | "indexed" // retrieved → inspected → extracted → indexed
  | "unavailable" // retrieved but HTTP error / access restriction
  | "skipped" // robots.txt, trap rule, budget, egress policy
  | "failed"; // retrieval or processing error after retries

export type Purpose =
  | "bootstrap"
  | "discovery"
  | "artifact" // data/document/media file referenced by a resource or listing
  | "contained" // entry inside an archive
  | `supporting:${string}`; // licence, methodology, schema, revision, provenance…

export interface FrontierItem {
  url: string;
  priority: number;
  depth: number;
  via: string; // bootstrap:<source>, reference:<tag>, sitemap, feed, listing, search_api:<provider>…
  purpose: Purpose;
  parentId?: number | null;
  relation?: string | null;
  anchor?: string | null;
  scope?: string | null;
}

export interface ResourceRow {
  id: number;
  url: string;
  host: string;
  state: ResourceState;
  priority: number;
  depth: number;
  via: string;
  purpose: string;
  parent_id: number | null;
  attempts: number;
  lease_until: number | null;
  due_at: number;
  discovered_at: string;
  retrieved_at: string | null;
  inspected_at: string | null;
  extracted_at: string | null;
  indexed_at: string | null;
  http_status: number | null;
  kind: string | null;
  title: string | null;
  description: string | null;
  content_hash: string | null;
  etag: string | null;
  last_modified: string | null;
  field_count: number;
  extractor_errors: number;
  snapshot_count: number;
  change_count: number;
  unchanged_count: number;
  duplicate_of: number | null;
  last_error: string | null;
  final_url: string | null;
}

export interface SnapshotRow {
  id: number;
  fetched_at: string;
  http_status: number;
  content_hash: string;
  bytes: number;
  kind: string;
  title: string;
  changed_fields: string | null;
}

export interface StoredRecord {
  categories: CategoryCoverage[];
  quality: QualityReport;
  relationships: Relationship[];
  processing: unknown;
}

export interface SearchCandidate extends ResourceRow {
  rank: number;
  snippet: string | null;
}

export interface LinkedResource {
  type: string;
  purpose: string | null;
  scope: string | null;
  id: number;
  url: string;
  title: string | null;
  kind: string | null;
  state: string;
}

/** System retention rules (category 40 records these separately from source-declared policies). */
export const SYSTEM_RETENTION = {
  snapshotsPerResource: Number(process.env.SNAPSHOTS_PER_RESOURCE ?? 5),
  eventsDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
  rawBodies: "not stored — only extracted metadata and a capped text excerpt (≤ 100 KB) for search",
  personalData: "PII is never stored as values — only counts and masked forms",
};

export const TEXT_EXCERPT = 100_000;

/** Searchable text stored for an indexed resource (secrets redacted before storage; body capped at TEXT_EXCERPT UTF-16 units). */
export interface StoredText {
  resourceId: number;
  url: string;
  title: string;
  description: string;
  body: string;
}

/**
 * Persistent corpus: crawl frontier, per-stage state, snapshots, field-level
 * observations, relationships, crawler events and a full-text index.
 * Implemented by SQLite (single node) and Postgres (many API + crawler replicas).
 */
export interface Corpus {
  readonly backend: "sqlite" | "postgres";
  close(): Promise<void>;

  // frontier & scheduling
  /** Reclaim leases on worker start. SQLite (single writer) reclaims all; Postgres only expired ones. */
  recoverOnStartup(now: number): Promise<number>;
  recoverLeases(now: number): Promise<number>;
  enqueue(items: FrontierItem[], now?: number): Promise<number>;
  hostStats(host: string): Promise<{ pages: number; enqueued: number }>;
  frontierSize(): Promise<number>;
  dueCount(now: number): Promise<number>;
  /** Lease up to n due resources, at most one in flight per host across all workers. */
  lease(n: number, leaseMs: number, now: number, profile?: CrawlerProfile): Promise<ResourceRow[]>;
  touchHost(host: string, delayMs: number, now: number): Promise<void>;
  hostResult(host: string, ok: boolean, status: number | null, now: number): Promise<void>;
  get(id: number): Promise<ResourceRow | undefined>;
  byUrl(url: string): Promise<ResourceRow | undefined>;
  setStage(id: number, patch: Partial<Omit<ResourceRow, "id">>): Promise<void>;
  /** Final state for this processing round; releases the host lease. */
  finish(id: number, state: ResourceState, dueAt: number, patch?: Partial<Omit<ResourceRow, "id">>): Promise<void>;

  // evidence
  latestSnapshot(resourceId: number): Promise<{ id: number; content_hash: string | null; fetched_at: string } | undefined>;
  observationsFor(snapshotId: number): Promise<MetadataField[]>;
  saveSnapshot(resourceId: number, record: ResourceRecord, opts: { text: string; changedFields?: string[] | null; index: boolean }): Promise<number>;
  linkDuplicates(resourceId: number, contentHash: string): Promise<number | null>;
  snapshotRecord(snapshotId: number): Promise<StoredRecord | null>;
  snapshots(resourceId: number): Promise<SnapshotRow[]>;
  relationshipsOf(resourceId: number): Promise<{ outgoing: unknown[]; incoming: unknown[] }>;

  // audit & sources
  event(resourceId: number | null, type: string, detail?: string): Promise<void>;
  eventsFor(resourceId: number, limit?: number): Promise<Array<{ ts: string; type: string; detail: string | null }>>;
  pruneEvents(now: number): Promise<number>;
  /** Atomically claim a discovery source run (only one worker runs a source per interval). */
  claimSource(id: string, intervalMs: number, now: number): Promise<boolean>;
  recordSourceRun(id: string, count: number, error: string | null, now: number): Promise<void>;
  stats(): Promise<Record<string, unknown> & { byState: Record<string, number> }>;

  // learning: URL-pattern yield model and extractor reliability
  recordPattern(key: string, host: string, o: { indexed: boolean; failed: boolean; fields: number; categories: number; ms: number }): Promise<void>;
  patternStats(keys: string[]): Promise<Map<string, PatternStat>>;
  topPatterns(limit: number, order: "yield" | "failures"): Promise<PatternStat[]>;
  recordExtractorRuns(runs: Array<{ id: string; ms: number; fields: number; error?: string }>): Promise<void>;
  extractorStats(): Promise<Array<{ id: string; runs: number; errors: number; fields: number; ms: number }>>;

  // batch read primitives (search hot path: constant query count per request)
  latestSnapshots(resourceIds: number[]): Promise<Map<number, number>>;
  observationsForSnapshots(snapshotIds: number[]): Promise<Map<number, MetadataField[]>>;
  snapshotRecords(snapshotIds: number[]): Promise<Map<number, StoredRecord>>;
  linksFor(resourceIds: number[]): Promise<{ from: Map<number, LinkedResource[]>; to: Map<number, LinkedResource[]> }>;

  // search primitives
  /** Ranks resources matching ALL terms first; fills with ANY-term matches. `total` counts all-term matches (capped). */
  searchResources(q: { terms: string[]; kind?: string; host?: string; hosts?: string[]; category?: number; limit: number; offset: number }): Promise<{ rows: SearchCandidate[]; total: number; totalIsLowerBound?: boolean }>;
  matchObservations(snapshotId: number, terms: string[], categories: number[], limit: number): Promise<MetadataField[]>;
  categoryCounts(snapshotId: number): Promise<Array<{ category: number; n: number }>>;
  linkedFrom(resourceId: number): Promise<LinkedResource[]>;
  linkedTo(resourceId: number): Promise<LinkedResource[]>;

  // text intelligence: on-demand scans of the stored text excerpt
  documentTexts(resourceIds: number[]): Promise<Map<number, StoredText>>;
  /** Most recently indexed (non-duplicate) resource ids — bounded fallback when full-text search cannot pick candidates. */
  recentIndexedIds(limit: number): Promise<number[]>;
}

export interface PatternStat {
  key: string;
  host: string;
  fetched: number;
  indexed: number;
  failed: number;
  fieldsSum: number;
  catsSum: number;
  msSum: number;
}

/** Specialised crawler roles; each can run as any number of replicas. */
export type CrawlerProfile = "generalist" | "datasets" | "media" | "documents" | "refresh";

export const PROFILE_URL_HINTS: Record<Exclude<CrawlerProfile, "generalist" | "refresh">, string[]> = {
  datasets: [".csv", ".tsv", ".json", ".geojson", ".xml", ".zip", ".parquet", ".xlsx", "/dataset", "/data/", "/api/", "package_show", "/records/", "datapackage"],
  media: [".jpg", ".jpeg", ".png", ".tif", ".webp", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".flac", ".ogg", "upload.wikimedia.org", "/download/"],
  documents: [".pdf", ".docx", ".doc", ".odt", ".pptx", ".eml", ".md", "/report", "/paper", "/publication"],
};

/** SQL expression (portable SQLite/Postgres) that boosts URLs matching a profile. */
export function profileBoostSql(profile: CrawlerProfile | undefined, col = "r.url"): string {
  if (!profile || profile === "generalist" || profile === "refresh") return "0";
  const hints = PROFILE_URL_HINTS[profile].map((h) => `lower(${col}) LIKE '%${h.replace(/'/g, "")}%'`);
  return `(CASE WHEN ${hints.join(" OR ")} THEN 40 ELSE 0 END)`;
}
