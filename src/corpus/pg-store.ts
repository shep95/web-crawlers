import pg from "pg";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { MetadataField, ResourceRecord } from "../metadata/types.js";
import { metaText, recordBlob, rowToField, toPattern, valueText } from "./store.js";
import { SYSTEM_RETENTION, TEXT_EXCERPT, profileBoostSql, type CrawlerProfile, type PatternStat, type Corpus, type FrontierItem, type LinkedResource, type ResourceRow, type ResourceState, type SearchCandidate, type SnapshotRow, type StoredRecord } from "./types.js";

/**
 * Postgres corpus for multi-service deployments: any number of API replicas
 * read it and any number of crawler replicas write it. Coordination is done
 * with atomic row claims (hosts.leased_until, sources.last_run_at) so two
 * workers never fetch from the same host at once or run the same source.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS resources (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL,
  host TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  priority REAL NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL,
  purpose TEXT NOT NULL,
  parent_id BIGINT REFERENCES resources(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until BIGINT,
  due_at BIGINT NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL,
  retrieved_at TEXT, inspected_at TEXT, extracted_at TEXT, indexed_at TEXT,
  http_status INTEGER, kind TEXT, title TEXT, description TEXT, content_hash TEXT,
  etag TEXT, last_modified TEXT, final_url TEXT,
  field_count INTEGER NOT NULL DEFAULT 0,
  extractor_errors INTEGER NOT NULL DEFAULT 0,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  change_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  duplicate_of BIGINT REFERENCES resources(id) ON DELETE SET NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_queue ON resources (priority DESC, id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS idx_res_revisit ON resources (due_at) WHERE state IN ('indexed','unavailable');
CREATE INDEX IF NOT EXISTS idx_res_host ON resources (host, state);
CREATE INDEX IF NOT EXISTS idx_res_hash ON resources (content_hash);
CREATE INDEX IF NOT EXISTS idx_res_parent ON resources (parent_id);
CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY,
  next_allowed_at BIGINT NOT NULL DEFAULT 0,
  leased_until BIGINT NOT NULL DEFAULT 0,
  crawl_delay_ms INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  enqueued INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  first_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL, http_status INTEGER, final_url TEXT, content_hash TEXT, bytes INTEGER,
  kind TEXT, mime TEXT, title TEXT, record_gz BYTEA NOT NULL, changed_fields TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_res ON snapshots (resource_id, id DESC);
CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  snapshot_id BIGINT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  category SMALLINT NOT NULL, field TEXT NOT NULL, value_json TEXT NOT NULL, value_text TEXT NOT NULL,
  original TEXT, status TEXT NOT NULL, evidence_type TEXT NOT NULL, scope TEXT NOT NULL,
  method TEXT NOT NULL, extractor TEXT NOT NULL, evidence TEXT, sensitivity TEXT,
  masked BOOLEAN NOT NULL DEFAULT FALSE, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_snap ON observations (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_obs_res_cat ON observations (resource_id, category);
CREATE INDEX IF NOT EXISTS idx_obs_field ON observations (category, field);
CREATE TABLE IF NOT EXISTS relationships (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  target_id BIGINT REFERENCES resources(id) ON DELETE SET NULL,
  type TEXT NOT NULL, purpose TEXT, scope TEXT, evidence TEXT, method TEXT, status TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (source_id, target_url, type)
);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships (target_id);
CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, ts TEXT NOT NULL, resource_id BIGINT, type TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_events_res ON events (resource_id, id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, last_run_at BIGINT, last_count INTEGER, last_error TEXT, runs INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS patterns (key TEXT PRIMARY KEY, host TEXT NOT NULL, fetched INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, fields_sum BIGINT NOT NULL DEFAULT 0, cats_sum BIGINT NOT NULL DEFAULT 0, ms_sum BIGINT NOT NULL DEFAULT 0, last_at TEXT);
CREATE TABLE IF NOT EXISTS extractor_stats (id TEXT PRIMARY KEY, runs BIGINT NOT NULL DEFAULT 0, errors BIGINT NOT NULL DEFAULT 0, fields BIGINT NOT NULL DEFAULT 0, ms BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS corpus_docs (
  resource_id BIGINT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  title TEXT, description TEXT, meta TEXT, body TEXT, url TEXT,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(meta, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(left(body, 20000), '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(url, '')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_docs_tsv ON corpus_docs USING GIN (tsv);
`;

const n = (v: unknown) => (v === null || v === undefined ? (v as null) : Number(v));
function toRow(r: Record<string, unknown>): ResourceRow {
  return { ...(r as unknown as ResourceRow), id: Number(r.id), parent_id: n(r.parent_id) as number | null, lease_until: n(r.lease_until) as number | null, due_at: Number(r.due_at), duplicate_of: n(r.duplicate_of) as number | null, priority: Number(r.priority) };
}
/** Terms → safe prefix tsquery (letters/digits only). */
export function pgTsQuery(terms: string[]): string {
  return terms.map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter((t) => t.length > 1).map((t) => `${t}:*`).join(" | ");
}

export class PgCorpus implements Corpus {
  readonly backend = "postgres" as const;
  readonly pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string, opts: { max?: number; migrate?: boolean } = {}): Promise<PgCorpus> {
    const pool = new pg.Pool({
      connectionString,
      max: opts.max ?? Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000),
      ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", () => undefined); // idle-client errors must not crash the process
    const c = new PgCorpus(pool);
    if (opts.migrate !== false) {
      // Advisory lock: concurrent replicas booting together run migrations once.
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(424242)");
        await client.query(SCHEMA);
      } finally {
        await client.query("SELECT pg_advisory_unlock(424242)").catch(() => undefined);
        client.release();
      }
    }
    return c;
  }

  private q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T & pg.QueryResultRow>> {
    return this.pool.query<T & pg.QueryResultRow>(sql, params);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async recoverOnStartup(now: number): Promise<number> {
    // Other replicas may be alive: only expired leases are abandoned.
    return this.recoverLeases(now);
  }

  async recoverLeases(now: number): Promise<number> {
    const r = await this.q(`UPDATE resources SET state='queued', lease_until=NULL WHERE state='leased' AND (lease_until IS NULL OR lease_until < $1)`, [now]);
    await this.q(`UPDATE hosts SET leased_until = 0 WHERE leased_until > 0 AND leased_until < $1`, [now]);
    if (r.rowCount) await this.event(null, "lease_recovery", `${r.rowCount} abandoned lease(s) returned to the queue`);
    return r.rowCount ?? 0;
  }

  async enqueue(items: FrontierItem[], now = Date.now()): Promise<number> {
    if (!items.length) return 0;
    const ts = new Date(now).toISOString();
    const uniq = [...new Map(items.map((i) => [i.url, i])).values()];
    const res = await this.q<{ id: string; url: string; inserted: boolean }>(
      `INSERT INTO resources (url, url_hash, host, state, priority, depth, via, purpose, parent_id, due_at, discovered_at)
       SELECT x.url, x.hash, x.host, 'queued', x.priority, x.depth, x.via, x.purpose, x.parent_id, $2, $3
       FROM json_to_recordset($1::json) AS x(url text, hash text, host text, priority real, depth int, via text, purpose text, parent_id bigint)
       ON CONFLICT (url) DO UPDATE SET priority = GREATEST(resources.priority, EXCLUDED.priority)
       RETURNING id, url, (xmax = 0) AS inserted`,
      [JSON.stringify(uniq.map((i) => ({ url: i.url, hash: createHash("sha1").update(i.url).digest("hex"), host: new URL(i.url).hostname, priority: i.priority, depth: i.depth, via: i.via, purpose: i.purpose, parent_id: i.parentId ?? null }))), now, ts],
    );
    const ids = new Map(res.rows.map((r) => [r.url, Number(r.id)]));
    const added = res.rows.filter((r) => r.inserted);
    if (added.length) {
      const perHost = new Map<string, number>();
      for (const r of added) perHost.set(new URL(r.url).hostname, (perHost.get(new URL(r.url).hostname) ?? 0) + 1);
      await this.q(
        `INSERT INTO hosts (host, first_seen, enqueued) SELECT h, $2, c FROM json_to_recordset($1::json) AS x(h text, c int)
         ON CONFLICT (host) DO UPDATE SET enqueued = hosts.enqueued + EXCLUDED.enqueued`,
        [JSON.stringify([...perHost].map(([h, c]) => ({ h, c }))), ts],
      );
    }
    const rels = uniq.filter((i) => i.parentId && i.relation).map((i) => ({ s: i.parentId, u: i.url, t: ids.get(i.url) ?? null, ty: i.relation, p: i.purpose, sc: i.scope ?? "resource", e: i.anchor ? `anchor: ${i.anchor}` : i.via }));
    if (rels.length) {
      await this.q(
        `INSERT INTO relationships (source_id, target_url, target_id, type, purpose, scope, evidence, method, status, observed_at)
         SELECT s, u, t, ty, p, sc, e, 'crawler reference classification', 'source_declared', $2 FROM json_to_recordset($1::json) AS x(s bigint, u text, t bigint, ty text, p text, sc text, e text)
         ON CONFLICT (source_id, target_url, type) DO UPDATE SET purpose = COALESCE(relationships.purpose, EXCLUDED.purpose), target_id = COALESCE(relationships.target_id, EXCLUDED.target_id),
           scope = CASE WHEN relationships.purpose IS NULL THEN EXCLUDED.scope ELSE relationships.scope END`,
        [JSON.stringify(rels), ts],
      );
    }
    return added.length;
  }

  async hostStats(host: string) {
    const r = await this.q<{ pages: number; enqueued: number }>(`SELECT pages, enqueued FROM hosts WHERE host = $1`, [host]);
    return r.rows[0] ?? { pages: 0, enqueued: 0 };
  }

  async frontierSize(): Promise<number> {
    return Number((await this.q<{ n: string }>(`SELECT COUNT(*) n FROM resources WHERE state='queued'`)).rows[0].n);
  }

  async dueCount(now: number): Promise<number> {
    return Number((await this.q<{ n: string }>(`SELECT COUNT(*) n FROM resources WHERE state='queued' AND due_at <= $1`, [now])).rows[0].n);
  }

  async lease(n: number, leaseMs: number, now: number, profile?: CrawlerProfile): Promise<ResourceRow[]> {
    // New work first (partial index on queued), then due revisits. The refresh profile only revisits.
    const cand = await this.q(
      `(SELECT r.id, r.host, r.priority + ${profileBoostSql(profile)} AS priority, 1 AS fresh FROM resources r JOIN hosts h ON h.host = r.host
         WHERE r.state = 'queued' AND ${profile === "refresh" ? "FALSE" : "TRUE"} AND r.due_at <= $1 AND h.next_allowed_at <= $1 AND h.leased_until <= $1
         ORDER BY r.priority + ${profileBoostSql(profile)} DESC, r.id LIMIT $2)
       UNION ALL
       (SELECT r.id, r.host, r.priority, 0 AS fresh FROM resources r JOIN hosts h ON h.host = r.host
         WHERE r.state IN ('indexed','unavailable') AND r.due_at <= $1 AND h.next_allowed_at <= $1 AND h.leased_until <= $1
         ORDER BY r.due_at LIMIT $3)`,
      [now, n * 30, n * 5],
    );
    const picked: ResourceRow[] = [];
    const tried = new Set<string>();
    for (const c of cand.rows.sort((a, b) => Number(b.fresh) - Number(a.fresh) || Number(b.priority) - Number(a.priority))) {
      if (picked.length >= n) break;
      const host = c.host as string;
      if (tried.has(host)) continue;
      tried.add(host);
      // Atomic host claim: exactly one worker (in any replica) wins this host.
      const claim = await this.q(`UPDATE hosts SET leased_until = $2 WHERE host = $1 AND leased_until <= $3 RETURNING host`, [host, now + leaseMs, now]);
      if (!claim.rowCount) continue;
      const got = await this.q(`UPDATE resources SET state='leased', lease_until=$2, attempts=attempts+1 WHERE id=$1 AND state IN ('queued','indexed','unavailable') RETURNING *`, [c.id, now + leaseMs]);
      if (!got.rowCount) {
        await this.q(`UPDATE hosts SET leased_until = 0 WHERE host = $1`, [host]);
        continue;
      }
      picked.push(toRow(got.rows[0]));
    }
    return picked;
  }

  async touchHost(host: string, delayMs: number, now: number): Promise<void> {
    await this.q(`UPDATE hosts SET next_allowed_at = $2, crawl_delay_ms = $3 WHERE host = $1`, [host, now + delayMs, delayMs]);
  }

  async hostResult(host: string, ok: boolean, status: number | null, now: number): Promise<void> {
    if (ok) {
      await this.q(`UPDATE hosts SET pages = pages + 1, consecutive_failures = 0, last_status = $2 WHERE host = $1`, [host, status]);
      return;
    }
    await this.q(
      `UPDATE hosts SET consecutive_failures = consecutive_failures + 1, last_status = $2,
         next_allowed_at = CASE WHEN consecutive_failures + 1 >= 3 THEN $3 + LEAST(21600000, 60000 * POWER(2, consecutive_failures - 2))::bigint ELSE next_allowed_at END
       WHERE host = $1`,
      [host, status, now],
    );
  }

  async get(id: number) {
    const r = await this.q(`SELECT * FROM resources WHERE id = $1`, [id]);
    return r.rows[0] ? toRow(r.rows[0]) : undefined;
  }

  async byUrl(url: string) {
    const r = await this.q(`SELECT * FROM resources WHERE url = $1`, [url]);
    return r.rows[0] ? toRow(r.rows[0]) : undefined;
  }

  async setStage(id: number, patch: Partial<Omit<ResourceRow, "id">>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => /^[a-z_]+$/.test(k));
    if (!keys.length) return;
    await this.q(`UPDATE resources SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...keys.map((k) => (patch as Record<string, unknown>)[k])]);
  }

  async finish(id: number, state: ResourceState, dueAt: number, patch: Partial<Omit<ResourceRow, "id">> = {}): Promise<void> {
    await this.setStage(id, { ...patch, state, due_at: dueAt, lease_until: null });
    await this.q(`UPDATE hosts SET leased_until = 0 WHERE host = (SELECT host FROM resources WHERE id = $1)`, [id]);
  }

  async latestSnapshot(resourceId: number) {
    const r = await this.q<{ id: string; content_hash: string | null; fetched_at: string }>(`SELECT id, content_hash, fetched_at FROM snapshots WHERE resource_id = $1 ORDER BY id DESC LIMIT 1`, [resourceId]);
    return r.rows[0] ? { ...r.rows[0], id: Number(r.rows[0].id) } : undefined;
  }

  async observationsFor(snapshotId: number): Promise<MetadataField[]> {
    return (await this.q(`SELECT * FROM observations WHERE snapshot_id = $1 ORDER BY category, id`, [snapshotId])).rows.map(rowToField);
  }

  async saveSnapshot(resourceId: number, record: ResourceRecord, opts: { text: string; changedFields?: string[] | null; index: boolean }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const snap = await client.query<{ id: string }>(
        `INSERT INTO snapshots (resource_id, fetched_at, http_status, final_url, content_hash, bytes, kind, mime, title, record_gz, changed_fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [resourceId, record.fetchedAt, record.httpStatus, record.finalUrl, record.contentHash, record.bytes, record.kind, record.mimeType, record.title, recordBlob(record), opts.changedFields ? JSON.stringify(opts.changedFields) : null],
      );
      const sid = Number(snap.rows[0].id);
      if (record.fields.length) {
        await client.query(
          `INSERT INTO observations (resource_id, snapshot_id, category, field, value_json, value_text, original, status, evidence_type, scope, method, extractor, evidence, sensitivity, masked, observed_at)
           SELECT $1, $2, x.category, x.field, x.value_json, x.value_text, x.original, x.status, x.evidence_type, x.scope, x.method, x.extractor, x.evidence, x.sensitivity, x.masked, x.observed_at
           FROM json_to_recordset($3::json) AS x(category smallint, field text, value_json text, value_text text, original text, status text, evidence_type text, scope text, method text, extractor text, evidence text, sensitivity text, masked boolean, observed_at text)`,
          [resourceId, sid, JSON.stringify(record.fields.map((f) => ({ category: f.category, field: f.field, value_json: JSON.stringify(f.value), value_text: valueText(f.value), original: f.original ?? null, status: f.status, evidence_type: f.evidenceType, scope: f.scope, method: f.method, extractor: f.extractor, evidence: f.evidence ?? null, sensitivity: f.sensitivity ?? null, masked: Boolean(f.masked), observed_at: f.observedAt })))],
        );
      }
      if (record.relationships.length) {
        await client.query(
          `INSERT INTO relationships (source_id, target_url, target_id, type, purpose, scope, evidence, method, status, observed_at)
           SELECT $1, x.target, (SELECT id FROM resources WHERE url = x.target), x.type, NULL, 'resource', x.evidence, x.method, x.status, $2
           FROM json_to_recordset($3::json) AS x(target text, type text, evidence text, method text, status text)
           ON CONFLICT (source_id, target_url, type) DO UPDATE SET evidence = EXCLUDED.evidence, observed_at = EXCLUDED.observed_at, target_id = COALESCE(relationships.target_id, EXCLUDED.target_id)`,
          [resourceId, record.fetchedAt, JSON.stringify(record.relationships.map((r) => ({ target: r.target, type: r.type, evidence: r.evidence, method: r.method, status: r.status })))],
        );
      }
      await client.query(`DELETE FROM snapshots WHERE resource_id = $1 AND id NOT IN (SELECT id FROM snapshots WHERE resource_id = $1 ORDER BY id DESC LIMIT $2)`, [resourceId, SYSTEM_RETENTION.snapshotsPerResource]);
      await client.query(`UPDATE resources SET snapshot_count = (SELECT COUNT(*) FROM snapshots WHERE resource_id = $1) WHERE id = $1`, [resourceId]);
      if (opts.index) {
        await client.query(
          `INSERT INTO corpus_docs (resource_id, title, description, meta, body, url) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (resource_id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, meta = EXCLUDED.meta, body = EXCLUDED.body, url = EXCLUDED.url`,
          [resourceId, record.title ?? "", record.description ?? "", metaText(record), opts.text.slice(0, TEXT_EXCERPT).replace(/\u0000/g, ""), record.finalUrl],
        );
      } else await client.query(`DELETE FROM corpus_docs WHERE resource_id = $1`, [resourceId]);
      await client.query("COMMIT");
      return sid;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async linkDuplicates(resourceId: number, contentHash: string): Promise<number | null> {
    const r = await this.q<{ id: string }>(`SELECT id FROM resources WHERE content_hash = $1 AND id != $2 AND duplicate_of IS NULL ORDER BY id LIMIT 1`, [contentHash, resourceId]);
    return r.rows[0] ? Number(r.rows[0].id) : null;
  }

  async event(resourceId: number | null, type: string, detail?: string): Promise<void> {
    await this.q(`INSERT INTO events (ts, resource_id, type, detail) VALUES ($1, $2, $3, $4)`, [new Date().toISOString(), resourceId, type, detail?.slice(0, 500).replace(/\u0000/g, "") ?? null]);
  }

  async eventsFor(resourceId: number, limit = 50) {
    return (await this.q<{ ts: string; type: string; detail: string | null }>(`SELECT ts, type, detail FROM events WHERE resource_id = $1 ORDER BY id DESC LIMIT $2`, [resourceId, limit])).rows;
  }

  async pruneEvents(now: number): Promise<number> {
    return (await this.q(`DELETE FROM events WHERE ts < $1`, [new Date(now - SYSTEM_RETENTION.eventsDays * 86400_000).toISOString()])).rowCount ?? 0;
  }

  async claimSource(id: string, intervalMs: number, now: number): Promise<boolean> {
    const r = await this.q(`INSERT INTO sources (id, last_run_at, runs) VALUES ($1, $2, 0) ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at WHERE sources.last_run_at IS NULL OR sources.last_run_at <= $3 RETURNING id`, [id, now, now - intervalMs]);
    return Boolean(r.rowCount);
  }

  async recordSourceRun(id: string, count: number, error: string | null, now: number): Promise<void> {
    await this.q(`INSERT INTO sources (id, last_run_at, last_count, last_error, runs) VALUES ($1,$2,$3,$4,1)
      ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_count = EXCLUDED.last_count, last_error = EXCLUDED.last_error, runs = sources.runs + 1`, [id, now, count, error]);
  }

  async stats() {
    const group = async (sql: string) => Object.fromEntries((await this.q<{ k: string; n: string }>(sql)).rows.map((r) => [r.k, Number(r.n)]));
    const one = async (sql: string) => Number((await this.q<{ n: string }>(sql)).rows[0].n);
    // Large-table counts use planner estimates to stay O(1) under load.
    const est = async (table: string) => Number((await this.q<{ n: string }>(`SELECT GREATEST(reltuples, 0)::bigint n FROM pg_class WHERE relname = $1`, [table])).rows[0]?.n ?? 0);
    return {
      backend: this.backend,
      resources: await one(`SELECT COUNT(*) n FROM resources`),
      byState: (await group(`SELECT state k, COUNT(*) n FROM resources GROUP BY state`)) as Record<string, number>,
      byKind: await group(`SELECT kind k, COUNT(*) n FROM resources WHERE kind IS NOT NULL GROUP BY kind`),
      byPurpose: await group(`SELECT purpose k, COUNT(*) n FROM resources GROUP BY purpose`),
      hosts: await one(`SELECT COUNT(*) n FROM hosts`),
      snapshots: await one(`SELECT COUNT(*) n FROM snapshots`),
      observations: Math.max(await est("observations"), 0) || (await one(`SELECT COUNT(*) n FROM observations`)),
      relationships: await one(`SELECT COUNT(*) n FROM relationships`),
      categoriesObserved: await one(`SELECT COUNT(DISTINCT category) n FROM observations`),
      sources: (await this.q(`SELECT * FROM sources ORDER BY id`)).rows,
      recentEvents: (await this.q(`SELECT ts, resource_id, type, detail FROM events ORDER BY id DESC LIMIT 25`)).rows,
    };
  }

  async snapshotRecord(snapshotId: number): Promise<StoredRecord | null> {
    const r = await this.q<{ record_gz: Buffer }>(`SELECT record_gz FROM snapshots WHERE id = $1`, [snapshotId]);
    return r.rows[0] ? JSON.parse(gunzipSync(r.rows[0].record_gz).toString("utf8")) : null;
  }

  async snapshots(resourceId: number): Promise<SnapshotRow[]> {
    return (await this.q<SnapshotRow>(`SELECT id, fetched_at, http_status, content_hash, bytes, kind, title, changed_fields FROM snapshots WHERE resource_id = $1 ORDER BY id DESC`, [resourceId])).rows.map((s) => ({ ...s, id: Number(s.id) }));
  }

  async relationshipsOf(resourceId: number) {
    const outgoing = (await this.q(`SELECT rel.type, rel.purpose, rel.scope, rel.target_url, rel.target_id, rel.evidence, rel.method, rel.status, t.state AS target_state, t.title AS target_title, t.kind AS target_kind
      FROM relationships rel LEFT JOIN resources t ON t.id = rel.target_id WHERE rel.source_id = $1 ORDER BY rel.id LIMIT 500`, [resourceId])).rows;
    const incoming = (await this.q(`SELECT rel.type, rel.purpose, rel.scope, s.url AS source_url, s.id AS source_id, s.title AS source_title, rel.evidence
      FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = $1 ORDER BY rel.id LIMIT 200`, [resourceId])).rows;
    return { outgoing, incoming };
  }

  async recordPattern(key: string, host: string, o: { indexed: boolean; failed: boolean; fields: number; categories: number; ms: number }): Promise<void> {
    await this.q(`INSERT INTO patterns (key, host, fetched, indexed, failed, fields_sum, cats_sum, ms_sum, last_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (key) DO UPDATE SET fetched = patterns.fetched + 1, indexed = patterns.indexed + EXCLUDED.indexed, failed = patterns.failed + EXCLUDED.failed,
        fields_sum = patterns.fields_sum + EXCLUDED.fields_sum, cats_sum = patterns.cats_sum + EXCLUDED.cats_sum, ms_sum = patterns.ms_sum + EXCLUDED.ms_sum, last_at = EXCLUDED.last_at`,
      [key, host, o.indexed ? 1 : 0, o.failed ? 1 : 0, o.fields, o.categories, Math.round(o.ms), new Date().toISOString()]);
  }

  async patternStats(keys: string[]): Promise<Map<string, PatternStat>> {
    const out = new Map<string, PatternStat>();
    if (!keys.length) return out;
    for (const r of (await this.q(`SELECT * FROM patterns WHERE key = ANY($1::text[])`, [[...new Set(keys)]])).rows) out.set(String(r.key), toPattern(r));
    return out;
  }

  async topPatterns(limit: number, order: "yield" | "failures"): Promise<PatternStat[]> {
    const ord = order === "yield" ? "cats_sum::float / GREATEST(indexed, 1) DESC, indexed DESC" : "failed::float / GREATEST(fetched, 1) DESC, fetched DESC";
    return (await this.q(`SELECT * FROM patterns WHERE fetched >= 1 ORDER BY ${ord} LIMIT $1`, [limit])).rows.map(toPattern);
  }

  async recordExtractorRuns(runs: Array<{ id: string; ms: number; fields: number; error?: string }>): Promise<void> {
    if (!runs.length) return;
    await this.q(`INSERT INTO extractor_stats (id, runs, errors, fields, ms) SELECT id, 1, e, f, m FROM json_to_recordset($1::json) AS x(id text, e int, f int, m int)
      ON CONFLICT (id) DO UPDATE SET runs = extractor_stats.runs + 1, errors = extractor_stats.errors + EXCLUDED.errors, fields = extractor_stats.fields + EXCLUDED.fields, ms = extractor_stats.ms + EXCLUDED.ms`,
      [JSON.stringify(runs.map((r) => ({ id: r.id, e: r.error ? 1 : 0, f: r.fields, m: Math.round(r.ms) })))]);
  }

  async extractorStats() {
    return (await this.q(`SELECT * FROM extractor_stats ORDER BY id`)).rows.map((r) => ({ id: String(r.id), runs: Number(r.runs), errors: Number(r.errors), fields: Number(r.fields), ms: Number(r.ms) }));
  }

  async latestSnapshots(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!ids.length) return out;
    for (const r of (await this.q(`SELECT resource_id, MAX(id) id FROM snapshots WHERE resource_id = ANY($1::bigint[]) GROUP BY resource_id`, [ids])).rows) out.set(Number(r.resource_id), Number(r.id));
    return out;
  }

  async observationsForSnapshots(sids: number[]): Promise<Map<number, MetadataField[]>> {
    const out = new Map<number, MetadataField[]>();
    if (!sids.length) return out;
    for (const r of (await this.q(`SELECT * FROM observations WHERE snapshot_id = ANY($1::bigint[]) ORDER BY category, id`, [sids])).rows) {
      const sid = Number(r.snapshot_id);
      if (!out.has(sid)) out.set(sid, []);
      out.get(sid)!.push(rowToField(r));
    }
    return out;
  }

  async snapshotRecords(sids: number[]): Promise<Map<number, StoredRecord>> {
    const out = new Map<number, StoredRecord>();
    if (!sids.length) return out;
    for (const r of (await this.q<{ id: string; record_gz: Buffer }>(`SELECT id, record_gz FROM snapshots WHERE id = ANY($1::bigint[])`, [sids])).rows) out.set(Number(r.id), JSON.parse(gunzipSync(r.record_gz).toString("utf8")));
    return out;
  }

  async linksFor(ids: number[]) {
    const from = new Map<number, LinkedResource[]>();
    const to = new Map<number, LinkedResource[]>();
    if (!ids.length) return { from, to };
    const [a, b] = await Promise.all([
      this.q(`SELECT rel.source_id AS owner, rel.type, rel.purpose, rel.scope, t.id, t.url, t.title, t.kind, t.state FROM relationships rel JOIN resources t ON t.id = rel.target_id
        WHERE rel.source_id = ANY($1::bigint[]) AND (rel.purpose LIKE 'supporting:%' OR rel.purpose IN ('artifact','contained')) ORDER BY (t.state = 'indexed') DESC, rel.id`, [ids]),
      this.q(`SELECT rel.target_id AS owner, rel.type, rel.purpose, rel.scope, s.id, s.url, s.title, s.kind, s.state FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = ANY($1::bigint[]) ORDER BY rel.id`, [ids]),
    ]);
    for (const r of a.rows) {
      const o = Number(r.owner);
      if (!from.has(o)) from.set(o, []);
      if (from.get(o)!.length < 20) from.get(o)!.push({ ...(r as unknown as LinkedResource), id: Number(r.id) });
    }
    for (const r of b.rows) {
      const o = Number(r.owner);
      if (!to.has(o)) to.set(o, []);
      if (to.get(o)!.length < 10) to.get(o)!.push({ ...(r as unknown as LinkedResource), id: Number(r.id) });
    }
    return { from, to };
  }

  async searchResources(q: { terms: string[]; kind?: string; host?: string; category?: number; limit: number; offset: number }) {
    const andQ = pgTsQuery(q.terms).replace(/ \| /g, " & ");
    const orQ = pgTsQuery(q.terms);
    if (!orQ) return { rows: [], total: 0 };
    const filters = ["r.duplicate_of IS NULL", "r.state = 'indexed'"];
    const extra: unknown[] = [];
    if (q.kind) (extra.push(q.kind), filters.push(`r.kind = $${extra.length + 1}`));
    if (q.host) (extra.push(q.host), filters.push(`r.host = $${extra.length + 1}`));
    if (q.category) (extra.push(q.category), filters.push(`EXISTS (SELECT 1 FROM observations o WHERE o.resource_id = r.id AND o.category = $${extra.length + 1})`));
    const where = filters.join(" AND ");
    const run = async (tsq: string, limit: number, offset: number) => {
      const n = extra.length + 1;
      const res = await this.q(
        `WITH hits AS (
           SELECT d.resource_id, ts_rank(d.tsv, query) AS rank, query
           FROM corpus_docs d JOIN resources r ON r.id = d.resource_id, to_tsquery('english', $1) query
           WHERE d.tsv @@ query AND ${where} ORDER BY rank DESC LIMIT $${n + 1} OFFSET $${n + 2})
         SELECT r.*, hits.rank,
           COALESCE(NULLIF(ts_headline('english', left(d.body, 4000), hits.query, 'StartSel=«,StopSel=»,MaxWords=30,MinWords=12,MaxFragments=2,FragmentDelimiter= … '), left(d.body, 0)),
                    ts_headline('english', left(d.meta, 2000), hits.query, 'StartSel=«,StopSel=»,MaxWords=24,MinWords=8')) AS snippet
         FROM hits JOIN resources r ON r.id = hits.resource_id JOIN corpus_docs d ON d.resource_id = hits.resource_id
         ORDER BY hits.rank DESC`,
        [tsq, ...extra, limit, offset],
      );
      return res.rows.map((r) => ({ ...toRow(r), rank: Number(r.rank), snippet: (r.snippet as string) || null }) as SearchCandidate);
    };
    const all = await run(andQ, q.limit, q.offset);
    const total = Number((await this.q<{ n: string }>(`SELECT COUNT(*) n FROM (SELECT 1 FROM corpus_docs d WHERE d.tsv @@ to_tsquery('english', $1) LIMIT 1000) s`, [andQ])).rows[0].n);
    if (all.length >= q.limit || q.terms.length < 2) return { rows: all, total, totalIsLowerBound: total >= 1000 };
    const seen = new Set(all.map((r) => r.id));
    const any = (await run(orQ, q.limit * 2, 0)).filter((r) => !seen.has(r.id)).slice(0, q.limit - all.length);
    const minAll = all.length ? Math.min(...all.map((r) => r.rank)) : Infinity;
    const maxAny = Math.max(1e-9, ...any.map((r) => r.rank));
    const some = any.map((r) => ({ ...r, rank: Number.isFinite(minAll) ? (r.rank / maxAny) * minAll * 0.5 : r.rank }));
    return { rows: [...all, ...some], total: total + some.length, totalIsLowerBound: true };
  }

  async matchObservations(snapshotId: number, terms: string[], categories: number[], limit: number): Promise<MetadataField[]> {
    const params: unknown[] = [snapshotId, terms.map((t) => `%${t}%`), categories.length ? categories : [0], limit];
    return (await this.q(
      `SELECT * FROM observations WHERE snapshot_id = $1 AND NOT masked AND category NOT IN (20, 22)
         AND (value_text ILIKE ANY($2::text[]) OR category = ANY($3::smallint[]))
       ORDER BY (category = ANY($3::smallint[])) DESC, id LIMIT $4`,
      params,
    )).rows.map(rowToField);
  }

  async categoryCounts(snapshotId: number) {
    return (await this.q<{ category: number; n: string }>(`SELECT category, COUNT(*) n FROM observations WHERE snapshot_id = $1 GROUP BY category`, [snapshotId])).rows.map((r) => ({ category: Number(r.category), n: Number(r.n) }));
  }

  async linkedFrom(resourceId: number): Promise<LinkedResource[]> {
    return (await this.q<LinkedResource>(`SELECT rel.type, rel.purpose, rel.scope, t.id, t.url, t.title, t.kind, t.state FROM relationships rel JOIN resources t ON t.id = rel.target_id
      WHERE rel.source_id = $1 AND (rel.purpose LIKE 'supporting:%' OR rel.purpose IN ('artifact','contained')) ORDER BY (t.state = 'indexed') DESC, rel.id LIMIT 20`, [resourceId])).rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async linkedTo(resourceId: number): Promise<LinkedResource[]> {
    return (await this.q<LinkedResource>(`SELECT rel.type, rel.purpose, rel.scope, s.id, s.url, s.title, s.kind, s.state FROM relationships rel JOIN resources s ON s.id = rel.source_id WHERE rel.target_id = $1 ORDER BY rel.id LIMIT 10`, [resourceId])).rows.map((r) => ({ ...r, id: Number(r.id) }));
  }
}

/** Open the configured corpus: Postgres when DATABASE_URL is set, otherwise SQLite on DATA_DIR. */
export async function openCorpus(opts: { databaseUrl?: string | null; sqlitePath?: string } = {}): Promise<Corpus> {
  const url = opts.databaseUrl === undefined ? process.env.DATABASE_URL : opts.databaseUrl;
  if (url) return PgCorpus.connect(url);
  const { SqliteCorpus } = await import("./store.js");
  const { join } = await import("node:path");
  return new SqliteCorpus(opts.sqlitePath ?? join(process.env.DATA_DIR ?? "./data", "corpus.db"));
}
