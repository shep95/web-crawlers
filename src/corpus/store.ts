import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { CategoryCoverage, MetadataField, QualityReport, Relationship, ResourceRecord } from "../metadata/types.js";

/**
 * Persistent corpus: crawl frontier, per-stage processing state, snapshots,
 * field-level observations, relationships, the crawler's own audit events and
 * a full-text index over contents + metadata. SQLite (WAL) on a mounted volume.
 */

export type ResourceState =
  | "queued" // discovered, waiting for retrieval
  | "leased" // a worker is processing it
  | "indexed" // retrieved → inspected → extracted → indexed
  | "unavailable" // retrieved but HTTP error / access restriction
  | "skipped" // robots.txt, trap rule, budget
  | "failed"; // retrieval or processing error after retries

export type Purpose =
  | "bootstrap"
  | "discovery"
  | "artifact" // data/document/media file referenced by a resource
  | "contained" // entry inside an archive
  | `supporting:${string}`; // licence, methodology, schema, revision, provenance, about…

export interface FrontierItem {
  url: string;
  priority: number;
  depth: number;
  via: string; // how it was discovered: bootstrap:<source>, link, sitemap, feed, reference, search_api…
  purpose: Purpose;
  parentId?: number | null;
  relation?: string | null; // relationship type from parent
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

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL,
  host TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  priority REAL NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL,
  purpose TEXT NOT NULL,
  parent_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  due_at INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL,
  retrieved_at TEXT, inspected_at TEXT, extracted_at TEXT, indexed_at TEXT,
  http_status INTEGER, kind TEXT, title TEXT, description TEXT, content_hash TEXT,
  etag TEXT, last_modified TEXT, final_url TEXT,
  field_count INTEGER NOT NULL DEFAULT 0,
  extractor_errors INTEGER NOT NULL DEFAULT 0,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  change_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_sched ON resources(state, due_at, priority DESC);
CREATE INDEX IF NOT EXISTS idx_res_host ON resources(host, state);
CREATE INDEX IF NOT EXISTS idx_res_hash ON resources(content_hash);
CREATE INDEX IF NOT EXISTS idx_res_parent ON resources(parent_id);

CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  crawl_delay_ms INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  enqueued INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL,
  http_status INTEGER,
  final_url TEXT,
  content_hash TEXT,
  bytes INTEGER,
  kind TEXT,
  mime TEXT,
  title TEXT,
  record_gz BLOB NOT NULL,
  changed_fields TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_res ON snapshots(resource_id, id DESC);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  category INTEGER NOT NULL,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_text TEXT NOT NULL,
  original TEXT,
  status TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  method TEXT NOT NULL,
  extractor TEXT NOT NULL,
  evidence TEXT,
  sensitivity TEXT,
  masked INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_snap ON observations(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_obs_res_cat ON observations(resource_id, category);
CREATE INDEX IF NOT EXISTS idx_obs_field ON observations(category, field);

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  target_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  purpose TEXT,
  scope TEXT,
  evidence TEXT,
  method TEXT,
  status TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(source_id, target_url, type)
);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  resource_id INTEGER,
  type TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_res ON events(resource_id, id);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_count INTEGER,
  last_error TEXT,
  runs INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
  title, description, meta, body, url,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

/** System retention rules (category 40 records these separately from source-declared policies). */
export const SYSTEM_RETENTION = {
  snapshotsPerResource: Number(process.env.SNAPSHOTS_PER_RESOURCE ?? 5),
  eventsDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
  rawBodies: "not stored — only extracted metadata and a capped text excerpt (≤ 100 KB) for search",
  personalData: "PII is never stored as values — only counts and masked forms",
};

const TEXT_EXCERPT = 100_000;

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).replace(/[{}[\]"]/g, " ").replace(/\s+/g, " ").slice(0, 2000);
}

export class CorpusStore {
  readonly db: Database.Database;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ frontier

  /** Returns leased-but-abandoned work to the queue (restart recovery). */
  recoverLeases(now = Date.now()): number {
    const r = this.db.prepare(`UPDATE resources SET state='queued', lease_until=NULL WHERE state='leased' AND (lease_until IS NULL OR lease_until < ?)`).run(now);
    if (r.changes) this.event(null, "lease_recovery", `${r.changes} abandoned lease(s) returned to the queue`);
    return r.changes;
  }

  /**
   * Insert new frontier items (existing URLs are left alone except for a
   * priority raise). Returns how many were new.
   */
  enqueue(items: FrontierItem[], now = Date.now()): number {
    const insert = this.db.prepare(`INSERT INTO resources (url, url_hash, host, state, priority, depth, via, purpose, parent_id, due_at, discovered_at)
      VALUES (@url, @hash, @host, 'queued', @priority, @depth, @via, @purpose, @parentId, @due, @ts)
      ON CONFLICT(url) DO UPDATE SET priority = MAX(priority, excluded.priority) WHERE state = 'queued'`);
    const exists = this.db.prepare(`SELECT id FROM resources WHERE url = ?`);
    const host = this.db.prepare(`INSERT INTO hosts (host, first_seen, enqueued) VALUES (?, ?, 1) ON CONFLICT(host) DO UPDATE SET enqueued = enqueued + 1`);
    const rel = this.db.prepare(`INSERT OR IGNORE INTO relationships (source_id, target_url, target_id, type, purpose, scope, evidence, method, status, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'crawler reference classification', 'source_declared', ?)`);
    const ts = new Date(now).toISOString();
    let added = 0;
    this.db.transaction(() => {
      for (const it of items) {
        const h = new URL(it.url).hostname;
        const before = exists.get(it.url) as { id: number } | undefined;
        insert.run({ url: it.url, hash: createHash("sha1").update(it.url).digest("hex"), host: h, priority: it.priority, depth: it.depth, via: it.via, purpose: it.purpose, parentId: it.parentId ?? null, due: now, ts });
        const id = before?.id ?? (exists.get(it.url) as { id: number }).id;
        if (!before) {
          added++;
          host.run(h, ts);
        }
        if (it.parentId && it.relation) rel.run(it.parentId, it.url, id, it.relation, it.purpose, it.scope ?? "resource", it.anchor ? `anchor: ${it.anchor}` : it.via, ts);
      }
    })();
    return added;
  }

  hostStats(host: string): { pages: number; enqueued: number } {
    return (this.db.prepare(`SELECT pages, enqueued FROM hosts WHERE host = ?`).get(host) as { pages: number; enqueued: number } | undefined) ?? { pages: 0, enqueued: 0 };
  }

  frontierSize(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM resources WHERE state='queued'`).get() as { n: number }).n;
  }

  /**
   * Lease up to `n` due resources, at most one per host, skipping hosts that
   * are still cooling down (crawl-delay / failure back-off).
   */
  lease(n: number, leaseMs: number, now = Date.now()): ResourceRow[] {
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(`SELECT r.* FROM resources r JOIN hosts h ON h.host = r.host
          WHERE r.state IN ('queued','indexed','unavailable') AND r.due_at <= ? AND h.next_allowed_at <= ?
            AND r.host NOT IN (SELECT host FROM resources WHERE state = 'leased')
          ORDER BY (r.state = 'queued') DESC, r.priority DESC, r.id ASC LIMIT ?`)
        .all(now, now, n * 20) as ResourceRow[];
      const hosts = new Set<string>();
      const picked: ResourceRow[] = [];
      for (const c of candidates) {
        if (hosts.has(c.host)) continue;
        hosts.add(c.host);
        picked.push(c);
        if (picked.length >= n) break;
      }
      const upd = this.db.prepare(`UPDATE resources SET state='leased', lease_until=?, attempts=attempts+1 WHERE id=?`);
      for (const p of picked) upd.run(now + leaseMs, p.id);
      return picked;
    })();
  }

  /** Reserve the host's next request slot (politeness) before fetching. */
  touchHost(host: string, delayMs: number, now = Date.now()): void {
    this.db.prepare(`UPDATE hosts SET next_allowed_at = ?, crawl_delay_ms = ? WHERE host = ?`).run(now + delayMs, delayMs, host);
  }

  hostResult(host: string, ok: boolean, status: number | null, now = Date.now()): void {
    if (ok) this.db.prepare(`UPDATE hosts SET pages = pages + 1, consecutive_failures = 0, last_status = ? WHERE host = ?`).run(status, host);
    else {
      this.db.prepare(`UPDATE hosts SET consecutive_failures = consecutive_failures + 1, last_status = ? WHERE host = ?`).run(status, host);
      const f = (this.db.prepare(`SELECT consecutive_failures f FROM hosts WHERE host = ?`).get(host) as { f: number }).f;
      // Exponential host back-off after repeated failures (circuit breaker), max 6 h.
      if (f >= 3) this.db.prepare(`UPDATE hosts SET next_allowed_at = ? WHERE host = ?`).run(now + Math.min(6 * 3600_000, 60_000 * 2 ** (f - 3)), host);
    }
  }

  get(id: number): ResourceRow | undefined {
    return this.db.prepare(`SELECT * FROM resources WHERE id = ?`).get(id) as ResourceRow | undefined;
  }

  byUrl(url: string): ResourceRow | undefined {
    return this.db.prepare(`SELECT * FROM resources WHERE url = ?`).get(url) as ResourceRow | undefined;
  }

  setStage(id: number, patch: Partial<Omit<ResourceRow, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE resources SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
  }

  finish(id: number, state: ResourceState, dueAt: number, patch: Partial<Omit<ResourceRow, "id">> = {}): void {
    this.setStage(id, { ...patch, state, due_at: dueAt, lease_until: null });
  }

  // ------------------------------------------------------------ evidence

  latestSnapshot(resourceId: number): { id: number; content_hash: string | null; fetched_at: string } | undefined {
    return this.db.prepare(`SELECT id, content_hash, fetched_at FROM snapshots WHERE resource_id = ? ORDER BY id DESC LIMIT 1`).get(resourceId) as { id: number; content_hash: string | null; fetched_at: string } | undefined;
  }

  observationsFor(snapshotId: number): MetadataField[] {
    const rows = this.db.prepare(`SELECT * FROM observations WHERE snapshot_id = ? ORDER BY category, id`).all(snapshotId) as Array<Record<string, unknown>>;
    return rows.map(rowToField);
  }

  /**
   * Persist one retrieval: snapshot, all field observations, relationships,
   * FTS entry. Keeps the most recent N snapshots (older ones pruned with their
   * observations) so version history is preserved but bounded.
   */
  saveSnapshot(resourceId: number, record: ResourceRecord, opts: { text: string; changedFields?: string[] | null; index: boolean }): number {
    return this.db.transaction(() => {
      const snap = this.db
        .prepare(`INSERT INTO snapshots (resource_id, fetched_at, http_status, final_url, content_hash, bytes, kind, mime, title, record_gz, changed_fields)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(resourceId, record.fetchedAt, record.httpStatus, record.finalUrl, record.contentHash, record.bytes, record.kind, record.mimeType, record.title,
          gzipSync(JSON.stringify({ categories: record.categories, quality: record.quality, processing: record.processing, robots: record.robots, relationships: record.relationships })),
          opts.changedFields ? JSON.stringify(opts.changedFields) : null);
      const sid = Number(snap.lastInsertRowid);
      const ins = this.db.prepare(`INSERT INTO observations (resource_id, snapshot_id, category, field, value_json, value_text, original, status, evidence_type, scope, method, extractor, evidence, sensitivity, masked, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const f of record.fields) {
        ins.run(resourceId, sid, f.category, f.field, JSON.stringify(f.value), valueText(f.value), f.original ?? null, f.status, f.evidenceType, f.scope, f.method, f.extractor, f.evidence ?? null, f.sensitivity ?? null, f.masked ? 1 : 0, f.observedAt);
      }
      const relIns = this.db.prepare(`INSERT INTO relationships (source_id, target_url, target_id, type, purpose, scope, evidence, method, status, observed_at)
        VALUES (?, ?, (SELECT id FROM resources WHERE url = ?), ?, NULL, 'resource', ?, ?, ?, ?)
        ON CONFLICT(source_id, target_url, type) DO UPDATE SET evidence = excluded.evidence, observed_at = excluded.observed_at`);
      for (const r of record.relationships) relIns.run(resourceId, r.target, r.target, r.type, r.evidence, r.method, r.status, record.fetchedAt);
      // Prune history beyond the retention window.
      const old = this.db.prepare(`SELECT id FROM snapshots WHERE resource_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?`).all(resourceId, SYSTEM_RETENTION.snapshotsPerResource) as Array<{ id: number }>;
      for (const o of old) this.db.prepare(`DELETE FROM snapshots WHERE id = ?`).run(o.id);
      this.db.prepare(`UPDATE resources SET snapshot_count = (SELECT COUNT(*) FROM snapshots WHERE resource_id = ?) WHERE id = ?`).run(resourceId, resourceId);
      this.db.prepare(`DELETE FROM corpus_fts WHERE rowid = ?`).run(resourceId);
      if (opts.index) {
        const meta = record.fields
          .filter((f) => !f.masked && f.sensitivity !== "restricted" && ![4, 20, 22, 34].includes(f.category))
          .map((f) => `${f.field} ${valueText(f.value)}`)
          .join(" \n ")
          .slice(0, 60_000);
        this.db.prepare(`INSERT INTO corpus_fts (rowid, title, description, meta, body, url) VALUES (?, ?, ?, ?, ?, ?)`).run(resourceId, record.title ?? "", record.description ?? "", meta, opts.text.slice(0, TEXT_EXCERPT), record.finalUrl);
      }
      return sid;
    })();
  }

  linkDuplicates(resourceId: number, contentHash: string): number | null {
    const other = this.db.prepare(`SELECT id FROM resources WHERE content_hash = ? AND id != ? AND duplicate_of IS NULL ORDER BY id LIMIT 1`).get(contentHash, resourceId) as { id: number } | undefined;
    return other?.id ?? null;
  }

  // ------------------------------------------------------------ audit

  event(resourceId: number | null, type: string, detail?: string): void {
    this.db.prepare(`INSERT INTO events (ts, resource_id, type, detail) VALUES (?, ?, ?, ?)`).run(new Date().toISOString(), resourceId, type, detail?.slice(0, 500) ?? null);
  }

  eventsFor(resourceId: number, limit = 50): Array<{ ts: string; type: string; detail: string | null }> {
    return this.db.prepare(`SELECT ts, type, detail FROM events WHERE resource_id = ? ORDER BY id DESC LIMIT ?`).all(resourceId, limit) as Array<{ ts: string; type: string; detail: string | null }>;
  }

  pruneEvents(now = Date.now()): number {
    return this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(new Date(now - SYSTEM_RETENTION.eventsDays * 86400_000).toISOString()).changes;
  }

  sourceRun(id: string): { last_run_at: number | null } | undefined {
    return this.db.prepare(`SELECT last_run_at FROM sources WHERE id = ?`).get(id) as { last_run_at: number | null } | undefined;
  }

  recordSourceRun(id: string, count: number, error: string | null, now = Date.now()): void {
    this.db.prepare(`INSERT INTO sources (id, last_run_at, last_count, last_error, runs) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_count = excluded.last_count, last_error = excluded.last_error, runs = runs + 1`).run(id, now, count, error);
  }

  // ------------------------------------------------------------ read models

  stats() {
    const byState = Object.fromEntries((this.db.prepare(`SELECT state, COUNT(*) n FROM resources GROUP BY state`).all() as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
    const byKind = Object.fromEntries((this.db.prepare(`SELECT kind, COUNT(*) n FROM resources WHERE kind IS NOT NULL GROUP BY kind`).all() as Array<{ kind: string; n: number }>).map((r) => [r.kind, r.n]));
    const byPurpose = Object.fromEntries((this.db.prepare(`SELECT purpose, COUNT(*) n FROM resources GROUP BY purpose`).all() as Array<{ purpose: string; n: number }>).map((r) => [r.purpose, r.n]));
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      resources: one(`SELECT COUNT(*) n FROM resources`),
      byState,
      byKind,
      byPurpose,
      hosts: one(`SELECT COUNT(*) n FROM hosts`),
      snapshots: one(`SELECT COUNT(*) n FROM snapshots`),
      observations: one(`SELECT COUNT(*) n FROM observations`),
      relationships: one(`SELECT COUNT(*) n FROM relationships`),
      categoriesObserved: one(`SELECT COUNT(DISTINCT category) n FROM observations`),
      sources: this.db.prepare(`SELECT * FROM sources ORDER BY id`).all(),
      recentEvents: this.db.prepare(`SELECT ts, resource_id, type, detail FROM events ORDER BY id DESC LIMIT 25`).all(),
    };
  }

  snapshotRecord(snapshotId: number): { categories: CategoryCoverage[]; quality: QualityReport; relationships: Relationship[]; processing: unknown } | null {
    const row = this.db.prepare(`SELECT record_gz FROM snapshots WHERE id = ?`).get(snapshotId) as { record_gz: Buffer } | undefined;
    return row ? JSON.parse(gunzipSync(row.record_gz).toString("utf8")) : null;
  }

  snapshots(resourceId: number) {
    return this.db.prepare(`SELECT id, fetched_at, http_status, content_hash, bytes, kind, title, changed_fields FROM snapshots WHERE resource_id = ? ORDER BY id DESC`).all(resourceId) as Array<{ id: number; fetched_at: string; http_status: number; content_hash: string; bytes: number; kind: string; title: string; changed_fields: string | null }>;
  }

  relationshipsOf(resourceId: number) {
    const out = this.db.prepare(`SELECT rel.type, rel.purpose, rel.scope, rel.target_url, rel.target_id, rel.evidence, rel.method, rel.status, t.state AS target_state, t.title AS target_title, t.kind AS target_kind
      FROM relationships rel LEFT JOIN resources t ON t.id = rel.target_id WHERE rel.source_id = ? ORDER BY rel.id LIMIT 500`).all(resourceId);
    const incoming = this.db.prepare(`SELECT rel.type, rel.purpose, rel.scope, s.url AS source_url, s.id AS source_id, s.title AS source_title, rel.evidence
      FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = ? ORDER BY rel.id LIMIT 200`).all(resourceId);
    return { outgoing: out, incoming };
  }
}

export function rowToField(r: Record<string, unknown>): MetadataField {
  return {
    category: r.category as number,
    field: r.field as string,
    value: JSON.parse(r.value_json as string),
    status: r.status as MetadataField["status"],
    evidenceType: r.evidence_type as MetadataField["evidenceType"],
    scope: r.scope as MetadataField["scope"],
    method: r.method as string,
    extractor: r.extractor as string,
    evidence: (r.evidence as string) ?? undefined,
    original: (r.original as string) ?? undefined,
    sensitivity: (r.sensitivity as MetadataField["sensitivity"]) ?? undefined,
    masked: Boolean(r.masked) || undefined,
    observedAt: r.observed_at as string,
  };
}
