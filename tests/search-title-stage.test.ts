import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends } from "./helpers/backends.js";
import type { PgCorpus } from "../src/corpus/pg-store.js";
import type { ResourceRecord } from "../src/metadata/types.js";

// Production: a common one-word search ranked every body match (tens of thousands of vectors, 12-24 s cold).
// With the title index, pages whose titles contain the terms are ranked first and the full ranking runs only
// when titles do not give enough results.
const pgBackend = backends().map((b) => b()).find((b) => b.name === "postgres");
const suite = pgBackend ? describe : describe.skip;

function record(url: string, title: string, body: string): ResourceRecord {
  return { url, finalUrl: url, title, description: null, kind: "webpage", mimeType: "text/html", httpStatus: 200, fetchedAt: new Date().toISOString(), contentHash: url, fields: [], relationships: [], categories: [], processing: { extractors: [], timings: { extractors: [], totalMs: 0 } }, quality: { extractorErrors: [] } } as unknown as ResourceRecord;
}

suite("search: title stage [postgres]", () => {
  let store: PgCorpus;
  beforeAll(async () => {
    store = (await pgBackend!.open()) as PgCorpus;
    const now = Date.now();
    const docs: Array<[string, string, string]> = [];
    for (let i = 0; i < 30; i++) docs.push([`https://t${i}.example.org/`, `River guide ${i}`, "A page about rivers and water."]);
    for (let i = 0; i < 200; i++) docs.push([`https://b${i}.example.org/`, `Unrelated page ${i}`, "This body mentions a river once among many other words."]);
    for (const [url, title, body] of docs) {
      await store.enqueue([{ url, priority: 50, depth: 0, via: "test", purpose: "discovery" as const }], now);
      const row = (await store.lease(1, 60_000, now, "generalist"))[0];
      if (!row) continue;
      await store.saveSnapshot(row.id, record(url, title, body), { text: body, changedFields: null, index: true });
      await store.finish(row.id, "indexed", now + 86_400_000, { indexed_at: new Date(now).toISOString(), title });
    }
    await store.backfillTitles();
  }, 120_000);
  afterAll(async () => {
    await store?.close();
    await pgBackend?.dispose();
  });
  it("backfills title vectors and marks them ready", () => {
    expect(store.titlesReady).toBe(true);
  });
  it("answers from title matches when there are enough, ranked the same way", async () => {
    const r = await store.searchResources({ terms: ["river"], limit: 10, offset: 0 });
    expect(r.rows).toHaveLength(10);
    expect(r.ms?.titleStage).toBe(1);
    expect(r.rows.every((x) => /River guide/.test(x.title ?? ""))).toBe(true);
    // Title stage counts title matches only, so the total is a lower bound.
    expect(r.total).toBe(30);
    expect(r.totalIsLowerBound).toBe(true);
  });
  it("falls back to the full ranking when titles do not give enough results", async () => {
    const r = await store.searchResources({ terms: ["mentions"], limit: 10, offset: 0 });
    expect(r.ms?.titleStage).toBe(0);
    expect(r.rows.length).toBe(10);
  });
});
