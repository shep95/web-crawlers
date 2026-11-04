import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends } from "./helpers/backends.js";
import type { PgCorpus } from "../src/corpus/pg-store.js";
import type { ResourceRecord } from "../src/metadata/types.js";

// Crawl history is not needed: only the latest snapshot per page is kept, and older ones already stored are removed.
const pgBackend = backends().map((b) => b()).find((b) => b.name === "postgres");
const suite = pgBackend ? describe : describe.skip;
const rec = (url: string, v: number) => ({ url, finalUrl: url, title: `Page ${v}`, description: null, kind: "webpage", mimeType: "text/html", httpStatus: 200, fetchedAt: new Date().toISOString(), contentHash: `${url}#${v}`, fields: [{ category: 1, field: "title", value: `Page ${v}`, original: null, status: "observed", evidenceType: "observed", scope: "resource", method: "test", extractor: "test", evidence: null, sensitivity: null, masked: false, observedAt: new Date().toISOString() }], relationships: [], categories: [], processing: { extractors: [], timings: { extractors: [], totalMs: 0 } }, quality: { extractorErrors: [] } }) as unknown as ResourceRecord;

suite("snapshot retention [postgres]", () => {
  let store: PgCorpus;
  const ids: number[] = [];
  beforeAll(async () => {
    store = (await pgBackend!.open()) as PgCorpus;
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const url = `https://r${i}.example.org/`;
      await store.enqueue([{ url, priority: 50, depth: 0, via: "test", purpose: "discovery" as const }], now);
      const row = (await store.lease(1, 60_000, now, "generalist"))[0];
      ids.push(row.id);
      await store.saveSnapshot(row.id, rec(url, 1), { text: "one", changedFields: null, index: true });
    }
    // Simulate history written by the previous five-snapshot retention.
    const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<unknown> } }).pool;
    for (const id of ids) for (let v = 2; v <= 5; v++) {
      await pool.query(`INSERT INTO snapshots (resource_id, fetched_at, record_gz) SELECT resource_id, fetched_at, record_gz FROM snapshots WHERE resource_id = $1 ORDER BY id LIMIT 1`, [id]);
      await pool.query(`INSERT INTO observations (resource_id, snapshot_id, category, field, value_json, value_text, status, evidence_type, scope, method, extractor, observed_at) VALUES ($1, (SELECT MAX(id) FROM snapshots WHERE resource_id = $1), 1, 'title', '"x"', 'x', 'observed', 'observed', 'resource', 't', 't', now()::text)`, [id]);
    }
  }, 60_000);
  afterAll(async () => {
    await store?.close();
    await pgBackend?.dispose();
  });
  it("a new crawl keeps only the latest snapshot", async () => {
    await store.saveSnapshot(ids[0], rec("https://r0.example.org/", 6), { text: "six", changedFields: ["1.title"], index: true });
    await store.finish(ids[0], "indexed", Date.now() + 86_400_000, { indexed_at: new Date().toISOString(), title: "Page 6" });
    const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<{ n: string }> }> } }).pool;
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM snapshots WHERE resource_id = $1`, [ids[0]])).rows[0].n)).toBe(1);
  });
  it("prunes history already stored, observations included, keeping each page's latest", async () => {
    const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }> } }).pool;
    const latestBefore = await Promise.all(ids.map(async (id) => (await pool.query(`SELECT MAX(id) m FROM snapshots WHERE resource_id = $1`, [id])).rows[0].m));
    const removed = await store.pruneSnapshotHistory(3);
    expect(removed).toBe(8); // 4 extra snapshots on each of the two untouched pages
    for (const [i, id] of ids.entries()) {
      const rows = (await pool.query(`SELECT id FROM snapshots WHERE resource_id = $1`, [id])).rows;
      expect(rows.map((r) => String(r.id))).toEqual([String(latestBefore[i])]);
    }
    expect(Number((await pool.query(`SELECT COUNT(*) n FROM observations o WHERE NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.id = o.snapshot_id)`)).rows[0].n)).toBe(0);
    expect((await pool.query(`SELECT id FROM data_migrations WHERE id = 'snapshot-history-v1'`)).rows).toHaveLength(1);
    // Search still finds the page from its latest snapshot.
    expect((await store.searchResources({ terms: ["six"], limit: 5, offset: 0 })).rows.map((r) => r.id)).toContain(ids[0]);
  });
});
