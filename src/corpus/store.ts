import Database from "better-sqlite3";
import { isExcludedUrl } from "./host-policy.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { MetadataField, ResourceRecord } from "../metadata/types.js";
import { SYSTEM_RETENTION, TEXT_EXCERPT, profileBoostSql, type CrawlerProfile, type PatternStat, type Corpus, type FrontierItem, type LinkedResource, type ResourceRow, type ResourceState, type SearchCandidate, type SnapshotRow, type StoredRecord } from "./types.js";

export * from "./types.js";

/** SQLite (WAL) corpus for single-node deployments and tests. One writer process. */
// One-time data migrations. "content-text-v1": search text now excludes menus/banners/footers, so web pages
// indexed before it are scheduled for a re-crawl, spread over 24 hours so new crawling keeps going.
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
  fetched_at TEXT NOT NULL, http_status INTEGER, final_url TEXT, content_hash TEXT, bytes INTEGER,
  kind TEXT, mime TEXT, title TEXT, record_gz BLOB NOT NULL, changed_fields TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_res ON snapshots(resource_id, id DESC);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  category INTEGER NOT NULL, field TEXT NOT NULL, value_json TEXT NOT NULL, value_text TEXT NOT NULL,
  original TEXT, status TEXT NOT NULL, evidence_type TEXT NOT NULL, scope TEXT NOT NULL,
  method TEXT NOT NULL, extractor TEXT NOT NULL, evidence TEXT, sensitivity TEXT,
  masked INTEGER NOT NULL DEFAULT 0, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_snap ON observations(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_obs_res_cat ON observations(resource_id, category);
CREATE INDEX IF NOT EXISTS idx_obs_field ON observations(category, field);
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  target_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  type TEXT NOT NULL, purpose TEXT, scope TEXT, evidence TEXT, method TEXT, status TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(source_id, target_url, type)
);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, resource_id INTEGER, type TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_events_res ON events(resource_id, id);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, last_run_at INTEGER, last_count INTEGER, last_error TEXT, runs INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS patterns (key TEXT PRIMARY KEY, host TEXT NOT NULL, fetched INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, fields_sum INTEGER NOT NULL DEFAULT 0, cats_sum INTEGER NOT NULL DEFAULT 0, ms_sum INTEGER NOT NULL DEFAULT 0, last_at TEXT);
CREATE TABLE IF NOT EXISTS extractor_stats (id TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, fields INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(title, description, meta, body, url, tokenize = 'porter unicode61 remove_diacritics 2');
`;

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).replace(/[{}[\]"]/g, " ").replace(/\s+/g, " ").slice(0, 2000);
}

/** Metadata text indexed for search (no masked, restricted or purely operational fields). */
export function metaText(record: ResourceRecord): string {
  return record.fields
    .filter((f) => !f.masked && f.sensitivity !== "restricted" && ![4, 20, 22, 34].includes(f.category))
    .map((f) => `${f.field} ${valueText(f.value)}`)
    .join(" \n ")
    .slice(0, 60_000);
}

export function rowToField(r: Record<string, unknown>): MetadataField {
  return {
    category: Number(r.category),
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

export function recordBlob(record: ResourceRecord): Buffer {
  return gzipSync(JSON.stringify({ categories: record.categories, quality: record.quality, processing: record.processing, robots: record.robots, relationships: record.relationships }));
}

const ftsQuery = (terms: string[], op: "AND" | "OR" = "OR") => terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(` ${op} `);

export class SqliteCorpus implements Corpus {
  readonly backend = "sqlite" as const;
  readonly db: Database.Database;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    this.db.exec(`CREATE TABLE IF NOT EXISTS data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    const now = Date.now();
    if (this.db.prepare(`INSERT OR IGNORE INTO data_migrations (id, applied_at) VALUES ('content-text-v1', ?)`).run(now).changes)
      this.db.prepare(`UPDATE resources SET due_at = ? + (id % 1440) * 60000 WHERE state = 'indexed' AND kind = 'webpage' AND duplicate_of IS NULL`).run(now);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async recoverOnStartup(): Promise<number> {
    return this.recoverLeases(Number.MAX_SAFE_INTEGER);
  }

  async recoverLeases(now: number): Promise<number> {
    const r = this.db.prepare(`UPDATE resources SET state='queued', lease_until=NULL WHERE state='leased' AND (lease_until IS NULL OR lease_until < ?)`).run(now);
    if (r.changes) await this.event(null, "lease_recovery", `${r.changes} abandoned lease(s) returned to the queue`);
    return r.changes;
  }

  async enqueue(items: FrontierItem[], now = Date.now()): Promise<number> {
    items = items.filter((i) => !isExcludedUrl(i.url));
    const insert = this.db.prepare(`INSERT INTO resources (url, url_hash, host, state, priority, depth, via, purpose, parent_id, due_at, discovered_at)
      VALUES (@url, @hash, @host, 'queued', @priority, @depth, @via, @purpose, @parentId, @due, @ts)
      ON CONFLICT(url) DO UPDATE SET priority = MAX(priority, excluded.priority) WHERE state = 'queued'`);
    const exists = this.db.prepare(`SELECT id FROM resources WHERE url = ?`);
    const host = this.db.prepare(`INSERT INTO hosts (host, first_seen, enqueued) VALUES (?, ?, 1) ON CONFLICT(host) DO UPDATE SET enqueued = enqueued + 1`);
    // An edge may already exist from the source's own extraction; merge the discovery purpose into it.
    const rel = this.db.prepare(`INSERT INTO relationships (source_id, target_url, target_id, type, purpose, scope, evidence, method, status, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'crawler reference classification', 'source_declared', ?)
      ON CONFLICT(source_id, target_url, type) DO UPDATE SET purpose = COALESCE(relationships.purpose, excluded.purpose), target_id = COALESCE(relationships.target_id, excluded.target_id),
        scope = CASE WHEN relationships.purpose IS NULL THEN excluded.scope ELSE relationships.scope END`);
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

  async hostStats(host: string) {
    return (this.db.prepare(`SELECT pages, enqueued FROM hosts WHERE host = ?`).get(host) as { pages: number; enqueued: number } | undefined) ?? { pages: 0, enqueued: 0 };
  }

  async frontierSize(): Promise<number> {
    return (this.db.prepare(`SELECT COUNT(*) n FROM resources WHERE state='queued'`).get() as { n: number }).n;
  }

  async dueCount(now: number): Promise<number> {
    return (this.db.prepare(`SELECT COUNT(*) n FROM resources WHERE state='queued' AND due_at <= ?`).get(now) as { n: number }).n;
  }

  async lease(n: number, leaseMs: number, now: number, profile?: CrawlerProfile): Promise<ResourceRow[]> {
    const states = profile === "refresh" ? "('indexed','unavailable')" : "('queued','indexed','unavailable')";
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(`SELECT r.* FROM resources r JOIN hosts h ON h.host = r.host
          WHERE r.state IN ${states} AND r.due_at <= ? AND h.next_allowed_at <= ?
            AND r.host NOT IN (SELECT host FROM resources WHERE state = 'leased')
          ORDER BY (r.state = 'queued') DESC, r.priority + ${profileBoostSql(profile)} DESC, r.id ASC LIMIT ?`)
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

  async touchHost(host: string, delayMs: number, now: number): Promise<void> {
    this.db.prepare(`UPDATE hosts SET next_allowed_at = ?, crawl_delay_ms = ? WHERE host = ?`).run(now + delayMs, delayMs, host);
  }

  async hostResult(host: string, ok: boolean, status: number | null, now: number): Promise<void> {
    if (ok) this.db.prepare(`UPDATE hosts SET pages = pages + 1, consecutive_failures = 0, last_status = ? WHERE host = ?`).run(status, host);
    else {
      this.db.prepare(`UPDATE hosts SET consecutive_failures = consecutive_failures + 1, last_status = ? WHERE host = ?`).run(status, host);
      const f = (this.db.prepare(`SELECT consecutive_failures f FROM hosts WHERE host = ?`).get(host) as { f: number } | undefined)?.f ?? 0;
      // Exponential host back-off after repeated failures (circuit breaker), max 6 h.
      if (f >= 3) this.db.prepare(`UPDATE hosts SET next_allowed_at = ? WHERE host = ?`).run(now + Math.min(6 * 3600_000, 60_000 * 2 ** (f - 3)), host);
    }
  }

  async get(id: number) {
    return this.db.prepare(`SELECT * FROM resources WHERE id = ?`).get(id) as ResourceRow | undefined;
  }

  async byUrl(url: string) {
    return this.db.prepare(`SELECT * FROM resources WHERE url = ?`).get(url) as ResourceRow | undefined;
  }

  async setStage(id: number, patch: Partial<Omit<ResourceRow, "id">>): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE resources SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
  }

  async finish(id: number, state: ResourceState, dueAt: number, patch: Partial<Omit<ResourceRow, "id">> = {}): Promise<void> {
    await this.setStage(id, { ...patch, state, due_at: dueAt, lease_until: null });
  }

  async latestSnapshot(resourceId: number) {
    return this.db.prepare(`SELECT id, content_hash, fetched_at FROM snapshots WHERE resource_id = ? ORDER BY id DESC LIMIT 1`).get(resourceId) as { id: number; content_hash: string | null; fetched_at: string } | undefined;
  }

  async observationsFor(snapshotId: number): Promise<MetadataField[]> {
    return (this.db.prepare(`SELECT * FROM observations WHERE snapshot_id = ? ORDER BY category, id`).all(snapshotId) as Array<Record<string, unknown>>).map(rowToField);
  }

  async saveSnapshot(resourceId: number, record: ResourceRecord, opts: { text: string; changedFields?: string[] | null; index: boolean }): Promise<number> {
    return this.db.transaction(() => {
      const snap = this.db
        .prepare(`INSERT INTO snapshots (resource_id, fetched_at, http_status, final_url, content_hash, bytes, kind, mime, title, record_gz, changed_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(resourceId, record.fetchedAt, record.httpStatus, record.finalUrl, record.contentHash, record.bytes, record.kind, record.mimeType, record.title, recordBlob(record), opts.changedFields ? JSON.stringify(opts.changedFields) : null);
      const sid = Number(snap.lastInsertRowid);
      const ins = this.db.prepare(`INSERT INTO observations (resource_id, snapshot_id, category, field, value_json, value_text, original, status, evidence_type, scope, method, extractor, evidence, sensitivity, masked, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const f of record.fields) ins.run(resourceId, sid, f.category, f.field, JSON.stringify(f.value), valueText(f.value), f.original ?? null, f.status, f.evidenceType, f.scope, f.method, f.extractor, f.evidence ?? null, f.sensitivity ?? null, f.masked ? 1 : 0, f.observedAt);
      const relIns = this.db.prepare(`INSERT INTO relationships (source_id, target_url, target_id, type, purpose, scope, evidence, method, status, observed_at)
        VALUES (?, ?, (SELECT id FROM resources WHERE url = ?), ?, NULL, 'resource', ?, ?, ?, ?)
        ON CONFLICT(source_id, target_url, type) DO UPDATE SET evidence = excluded.evidence, observed_at = excluded.observed_at, target_id = COALESCE(relationships.target_id, excluded.target_id)`);
      for (const r of record.relationships) relIns.run(resourceId, r.target, r.target, r.type, r.evidence, r.method, r.status, record.fetchedAt);
      const old = this.db.prepare(`SELECT id FROM snapshots WHERE resource_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?`).all(resourceId, SYSTEM_RETENTION.snapshotsPerResource) as Array<{ id: number }>;
      for (const o of old) this.db.prepare(`DELETE FROM snapshots WHERE id = ?`).run(o.id);
      this.db.prepare(`UPDATE resources SET snapshot_count = (SELECT COUNT(*) FROM snapshots WHERE resource_id = ?) WHERE id = ?`).run(resourceId, resourceId);
      this.db.prepare(`DELETE FROM corpus_fts WHERE rowid = ?`).run(resourceId);
      if (opts.index) this.db.prepare(`INSERT INTO corpus_fts (rowid, title, description, meta, body, url) VALUES (?, ?, ?, ?, ?, ?)`).run(resourceId, record.title ?? "", record.description ?? "", metaText(record), opts.text.slice(0, TEXT_EXCERPT), record.finalUrl);
      return sid;
    })();
  }

  async linkDuplicates(resourceId: number, contentHash: string): Promise<number | null> {
    const other = this.db.prepare(`SELECT id FROM resources WHERE content_hash = ? AND id != ? AND duplicate_of IS NULL ORDER BY id LIMIT 1`).get(contentHash, resourceId) as { id: number } | undefined;
    return other?.id ?? null;
  }

  async event(resourceId: number | null, type: string, detail?: string): Promise<void> {
    this.db.prepare(`INSERT INTO events (ts, resource_id, type, detail) VALUES (?, ?, ?, ?)`).run(new Date().toISOString(), resourceId, type, detail?.slice(0, 500) ?? null);
  }

  async eventsFor(resourceId: number, limit = 50) {
    return this.db.prepare(`SELECT ts, type, detail FROM events WHERE resource_id = ? ORDER BY id DESC LIMIT ?`).all(resourceId, limit) as Array<{ ts: string; type: string; detail: string | null }>;
  }

  async pruneEvents(now: number): Promise<number> {
    return this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(new Date(now - SYSTEM_RETENTION.eventsDays * 86400_000).toISOString()).changes;
  }

  async claimSource(id: string, intervalMs: number, now: number): Promise<boolean> {
    const r = this.db.prepare(`INSERT INTO sources (id, last_run_at, runs) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at WHERE sources.last_run_at IS NULL OR sources.last_run_at <= ? RETURNING id`).get(id, now, now - intervalMs);
    return Boolean(r);
  }

  async recordSourceRun(id: string, count: number, error: string | null, now: number): Promise<void> {
    this.db.prepare(`INSERT INTO sources (id, last_run_at, last_count, last_error, runs) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_count = excluded.last_count, last_error = excluded.last_error, runs = runs + 1`).run(id, now, count, error);
  }

  async stats() {
    const group = (sql: string) => Object.fromEntries((this.db.prepare(sql).all() as Array<{ k: string; n: number }>).map((r) => [r.k, r.n]));
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      backend: this.backend,
      resources: one(`SELECT COUNT(*) n FROM resources`),
      byState: group(`SELECT state k, COUNT(*) n FROM resources GROUP BY state`) as Record<string, number>,
      byKind: group(`SELECT kind k, COUNT(*) n FROM resources WHERE kind IS NOT NULL GROUP BY kind`),
      byPurpose: group(`SELECT purpose k, COUNT(*) n FROM resources GROUP BY purpose`),
      hosts: one(`SELECT COUNT(*) n FROM hosts`),
      snapshots: one(`SELECT COUNT(*) n FROM snapshots`),
      observations: one(`SELECT COUNT(*) n FROM observations`),
      relationships: one(`SELECT COUNT(*) n FROM relationships`),
      categoriesObserved: one(`SELECT COUNT(DISTINCT category) n FROM observations`),
      sources: this.db.prepare(`SELECT * FROM sources ORDER BY id`).all(),
      recentEvents: this.db.prepare(`SELECT ts, resource_id, type, detail FROM events ORDER BY id DESC LIMIT 25`).all(),
    };
  }

  async snapshotRecord(snapshotId: number): Promise<StoredRecord | null> {
    const row = this.db.prepare(`SELECT record_gz FROM snapshots WHERE id = ?`).get(snapshotId) as { record_gz: Buffer } | undefined;
    return row ? JSON.parse(gunzipSync(row.record_gz).toString("utf8")) : null;
  }

  async snapshots(resourceId: number): Promise<SnapshotRow[]> {
    return this.db.prepare(`SELECT id, fetched_at, http_status, content_hash, bytes, kind, title, changed_fields FROM snapshots WHERE resource_id = ? ORDER BY id DESC`).all(resourceId) as SnapshotRow[];
  }

  async relationshipsOf(resourceId: number) {
    const outgoing = this.db.prepare(`SELECT rel.type, rel.purpose, rel.scope, rel.target_url, rel.target_id, rel.evidence, rel.method, rel.status, t.state AS target_state, t.title AS target_title, t.kind AS target_kind
      FROM relationships rel LEFT JOIN resources t ON t.id = rel.target_id WHERE rel.source_id = ? ORDER BY rel.id LIMIT 500`).all(resourceId);
    const incoming = this.db.prepare(`SELECT rel.type, rel.purpose, rel.scope, s.url AS source_url, s.id AS source_id, s.title AS source_title, rel.evidence
      FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = ? ORDER BY rel.id LIMIT 200`).all(resourceId);
    return { outgoing, incoming };
  }

  async recordPattern(key: string, host: string, o: { indexed: boolean; failed: boolean; fields: number; categories: number; ms: number }): Promise<void> {
    this.db.prepare(`INSERT INTO patterns (key, host, fetched, indexed, failed, fields_sum, cats_sum, ms_sum, last_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET fetched = fetched + 1, indexed = indexed + excluded.indexed, failed = failed + excluded.failed,
        fields_sum = fields_sum + excluded.fields_sum, cats_sum = cats_sum + excluded.cats_sum, ms_sum = ms_sum + excluded.ms_sum, last_at = excluded.last_at`)
      .run(key, host, o.indexed ? 1 : 0, o.failed ? 1 : 0, o.fields, o.categories, Math.round(o.ms), new Date().toISOString());
  }

  async patternStats(keys: string[]): Promise<Map<string, PatternStat>> {
    const out = new Map<string, PatternStat>();
    if (!keys.length) return out;
    const uniq = [...new Set(keys)];
    for (let i = 0; i < uniq.length; i += 500) {
      const chunk = uniq.slice(i, i + 500);
      for (const r of this.db.prepare(`SELECT * FROM patterns WHERE key IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<Record<string, number | string>>) out.set(r.key as string, toPattern(r));
    }
    return out;
  }

  async topPatterns(limit: number, order: "yield" | "failures"): Promise<PatternStat[]> {
    const ord = order === "yield" ? "CAST(cats_sum AS REAL) / MAX(indexed, 1) DESC, indexed DESC" : "CAST(failed AS REAL) / MAX(fetched, 1) DESC, fetched DESC";
    return (this.db.prepare(`SELECT * FROM patterns WHERE fetched >= 1 ORDER BY ${ord} LIMIT ?`).all(limit) as Array<Record<string, number | string>>).map(toPattern);
  }

  async recordExtractorRuns(runs: Array<{ id: string; ms: number; fields: number; error?: string }>): Promise<void> {
    const st = this.db.prepare(`INSERT INTO extractor_stats (id, runs, errors, fields, ms) VALUES (?, 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET runs = runs + 1, errors = errors + excluded.errors, fields = fields + excluded.fields, ms = ms + excluded.ms`);
    this.db.transaction(() => runs.forEach((r) => st.run(r.id, r.error ? 1 : 0, r.fields, Math.round(r.ms))))();
  }

  async extractorStats() {
    return this.db.prepare(`SELECT * FROM extractor_stats ORDER BY id`).all() as Array<{ id: string; runs: number; errors: number; fields: number; ms: number }>;
  }

  async latestSnapshots(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!ids.length) return out;
    const rows = this.db.prepare(`SELECT resource_id, MAX(id) id FROM snapshots WHERE resource_id IN (${ids.map(() => "?").join(",")}) GROUP BY resource_id`).all(...ids) as Array<{ resource_id: number; id: number }>;
    for (const r of rows) out.set(r.resource_id, r.id);
    return out;
  }

  async observationsForSnapshots(sids: number[]): Promise<Map<number, MetadataField[]>> {
    const out = new Map<number, MetadataField[]>();
    if (!sids.length) return out;
    const rows = this.db.prepare(`SELECT * FROM observations WHERE snapshot_id IN (${sids.map(() => "?").join(",")}) ORDER BY category, id`).all(...sids) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const sid = Number(r.snapshot_id);
      if (!out.has(sid)) out.set(sid, []);
      out.get(sid)!.push(rowToField(r));
    }
    return out;
  }

  async snapshotRecords(sids: number[]): Promise<Map<number, StoredRecord>> {
    const out = new Map<number, StoredRecord>();
    if (!sids.length) return out;
    for (const r of this.db.prepare(`SELECT id, record_gz FROM snapshots WHERE id IN (${sids.map(() => "?").join(",")})`).all(...sids) as Array<{ id: number; record_gz: Buffer }>) out.set(r.id, JSON.parse(gunzipSync(r.record_gz).toString("utf8")));
    return out;
  }

  async linksFor(ids: number[]) {
    const from = new Map<number, LinkedResource[]>();
    const to = new Map<number, LinkedResource[]>();
    if (!ids.length) return { from, to };
    const ph = ids.map(() => "?").join(",");
    for (const r of this.db.prepare(`SELECT rel.source_id AS owner, rel.type, rel.purpose, rel.scope, t.id, t.url, t.title, t.kind, t.state FROM relationships rel JOIN resources t ON t.id = rel.target_id
      WHERE rel.source_id IN (${ph}) AND (rel.purpose LIKE 'supporting:%' OR rel.purpose IN ('artifact','contained')) ORDER BY t.state = 'indexed' DESC, rel.id`).all(...ids) as Array<LinkedResource & { owner: number }>) {
      if (!from.has(r.owner)) from.set(r.owner, []);
      if (from.get(r.owner)!.length < 20) from.get(r.owner)!.push(r);
    }
    for (const r of this.db.prepare(`SELECT rel.target_id AS owner, rel.type, rel.purpose, rel.scope, s.id, s.url, s.title, s.kind, s.state FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id IN (${ph}) ORDER BY rel.id`).all(...ids) as Array<LinkedResource & { owner: number }>) {
      if (!to.has(r.owner)) to.set(r.owner, []);
      if (to.get(r.owner)!.length < 10) to.get(r.owner)!.push(r);
    }
    return { from, to };
  }

  async searchResources(q: { terms: string[]; kind?: string; host?: string; hosts?: string[]; category?: number; limit: number; offset: number }) {
    const filters = ["r.duplicate_of IS NULL", "r.state = 'indexed'"];
    const extra: unknown[] = [];
    const kinds = q.kind ? q.kind.split(",").filter(Boolean) : [];
    if (kinds.length) (filters.push(`r.kind IN (${kinds.map(() => "?").join(",")})`), extra.push(...kinds));
    if (q.host) (filters.push("(r.host = ? OR r.host LIKE ?)"), extra.push(q.host, `%.${q.host}`));
    if (q.hosts?.length) (filters.push(`(${q.hosts.map(() => "r.host = ? OR r.host LIKE ?").join(" OR ")})`), extra.push(...q.hosts.flatMap((h) => [h, `%.${h}`])));
    if (q.category) (filters.push("EXISTS (SELECT 1 FROM observations o WHERE o.resource_id = r.id AND o.category = ?)"), extra.push(q.category));
    const where = filters.join(" AND ");
    const run = (match: string, limit: number, offset: number) =>
      this.db
        .prepare(`SELECT r.*, -bm25(corpus_fts, 6.0, 3.0, 2.0, 1.0, 1.5) AS rank,
            COALESCE(NULLIF(snippet(corpus_fts, 3, '«', '»', ' … ', 18), ''), snippet(corpus_fts, 2, '«', '»', ' … ', 14)) AS snippet
          FROM corpus_fts JOIN resources r ON r.id = corpus_fts.rowid WHERE corpus_fts MATCH ? AND ${where}
          ORDER BY rank DESC LIMIT ? OFFSET ?`)
        .all(match, ...extra, limit, offset) as SearchCandidate[];
    const all = run(ftsQuery(q.terms, "AND"), q.limit, q.offset);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM corpus_fts JOIN resources r ON r.id = corpus_fts.rowid WHERE corpus_fts MATCH ? AND ${where} LIMIT 1000)`).get(ftsQuery(q.terms, "AND"), ...extra) as { n: number }).n;
    if (all.length >= q.limit || q.terms.length < 2) return { rows: all, total, totalIsLowerBound: total >= 1000 };
    // Fill with any-term matches, ranked below every all-term match.
    const seen = new Set(all.map((r) => r.id));
    const any = run(ftsQuery(q.terms, "OR"), q.limit * 2, 0).filter((r) => !seen.has(r.id)).slice(0, q.limit - all.length);
    // Keep relative order among any-term matches; place them all below the weakest all-term match.
    const minAll = all.length ? Math.min(...all.map((r) => r.rank)) : Infinity;
    const maxAny = Math.max(1e-9, ...any.map((r) => r.rank));
    const some = any.map((r) => ({ ...r, rank: Number.isFinite(minAll) ? (r.rank / maxAny) * minAll * 0.5 : r.rank }));
    return { rows: [...all, ...some], total: total + some.length, totalIsLowerBound: true };
  }

  async matchObservations(snapshotId: number, terms: string[], categories: number[], limit: number): Promise<MetadataField[]> {
    const like = terms.map((t) => `%${t}%`);
    const matchSql = like.length ? like.map(() => "value_text LIKE ?").join(" OR ") : "0";
    const catSql = categories.length ? ` OR category IN (${categories.map(() => "?").join(",")})` : "";
    const prefer = categories.length ? `category IN (${categories.map((c) => Number(c)).join(",")})` : "0";
    return (this.db
      .prepare(`SELECT * FROM observations WHERE snapshot_id = ? AND masked = 0 AND category NOT IN (20, 22) AND (${matchSql}${catSql}) ORDER BY ${prefer} DESC, id LIMIT ?`)
      .all(snapshotId, ...like, ...categories, limit) as Array<Record<string, unknown>>).map(rowToField);
  }

  async categoryCounts(snapshotId: number) {
    return this.db.prepare(`SELECT category, COUNT(*) n FROM observations WHERE snapshot_id = ? GROUP BY category`).all(snapshotId) as Array<{ category: number; n: number }>;
  }

  async linkedFrom(resourceId: number): Promise<LinkedResource[]> {
    return this.db.prepare(`SELECT rel.type, rel.purpose, rel.scope, t.id, t.url, t.title, t.kind, t.state FROM relationships rel JOIN resources t ON t.id = rel.target_id
      WHERE rel.source_id = ? AND (rel.purpose LIKE 'supporting:%' OR rel.purpose IN ('artifact','contained')) ORDER BY t.state = 'indexed' DESC, rel.id LIMIT 20`).all(resourceId) as LinkedResource[];
  }

  async linkedTo(resourceId: number): Promise<LinkedResource[]> {
    return this.db.prepare(`SELECT rel.type, rel.purpose, rel.scope, s.id, s.url, s.title, s.kind, s.state FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = ? ORDER BY rel.id LIMIT 10`).all(resourceId) as LinkedResource[];
  }
}

export function toPattern(r: Record<string, unknown>): PatternStat {
  return { key: String(r.key), host: String(r.host), fetched: Number(r.fetched), indexed: Number(r.indexed), failed: Number(r.failed), fieldsSum: Number(r.fields_sum), catsSum: Number(r.cats_sum), msSum: Number(r.ms_sum) };
}

/** @deprecated name kept for older imports */
export const CorpusStore = SqliteCorpus;
export type CorpusStore = SqliteCorpus;
