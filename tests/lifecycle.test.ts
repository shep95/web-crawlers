import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES } from "../src/metadata/categories.js";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import { SqliteCorpus } from "../src/corpus/store.js";
import { PgCorpus } from "../src/corpus/pg-store.js";
import type { Corpus } from "../src/corpus/types.js";
import {
  IN_FLIGHT_STATES, IllegalTransitionError, LIFECYCLE_STATES, RESTING_STATES, RETRY_POLICY, TRANSITIONS,
  assertTransition, canTransition, classifyError, classifyHttp, lifecycleFromLegacy, retryAfterMs,
} from "../src/corpus/lifecycle.js";
import { FetchBlockedError } from "../src/net/safe-fetch.js";
import { OFFLINE_VERIFIED } from "../src/corpus/capabilities.js";
import { classifyTld, countriesFromObservedTlds } from "../src/corpus/coverage.js";
import { redactSecrets } from "../src/corpus/redact.js";
import { backends } from "./helpers/backends.js";
import { fixtureCorpus } from "./fixtures/corpus.js";

describe("lifecycle transition table and guard", () => {
  it("defines all 15 states, each either resting or in flight, with a declared transition list", () => {
    expect(LIFECYCLE_STATES).toHaveLength(15);
    for (const s of LIFECYCLE_STATES) {
      expect(TRANSITIONS[s], s).toBeDefined();
      expect(RESTING_STATES.has(s) !== IN_FLIGHT_STATES.includes(s), s).toBe(true);
      for (const t of TRANSITIONS[s]) expect(LIFECYCLE_STATES).toContain(t);
    }
  });

  it("allows the real progression and nothing that skips a stage", () => {
    expect(assertTransition("discovered", ["leased", "fetched", "inspected", "extracted", "validated", "indexed"])).toBe("indexed");
    expect(assertTransition("indexed", ["leased", "fetched", "inspected", "change_detected", "extracted", "validated", "indexed"])).toBe("indexed");
    expect(assertTransition("indexed", ["leased", "fetched", "change_detected", "unavailable"])).toBe("unavailable");
    expect(assertTransition("discovered", ["leased", "fetched", "failed_retryable", "leased", "fetched", "inspected"])).toBe("inspected");
    expect(assertTransition("validated", "superseded")).toBe("superseded");
    expect(assertTransition("fetched", "indexed")).toBe("indexed"); // 304 Not Modified keeps the validated snapshot
    // illegal: an HTTP response is not an extraction; a link is not a crawl; a fetch is not an index without inspection
    for (const [from, to] of [["discovered", "indexed"], ["discovered", "fetched"], ["leased", "indexed"], ["fetched", "extracted"], ["inspected", "validated"], ["extracted", "indexed"], ["indexed", "extracted"], ["unavailable", "indexed"], ["permanently_failed", "indexed"], ["restricted", "fetched"]] as const) {
      expect(canTransition(from, to), `${from}→${to}`).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
    expect(() => assertTransition(null, "leased")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("leased", "bogus" as never)).toThrow(/unknown state/);
  });

  it("maps legacy states without losing meaning", () => {
    expect(lifecycleFromLegacy({ state: "queued" })).toBe("discovered");
    expect(lifecycleFromLegacy({ state: "queued", attempts: 2, last_error: "ECONNRESET" })).toBe("failed_retryable");
    expect(lifecycleFromLegacy({ state: "indexed", duplicate_of: 3 })).toBe("superseded");
    expect(lifecycleFromLegacy({ state: "unavailable", http_status: 403 })).toBe("restricted");
    expect(lifecycleFromLegacy({ state: "unavailable", http_status: 404 })).toBe("unavailable");
    expect(lifecycleFromLegacy({ state: "unavailable", http_status: 503 })).toBe("permanently_failed");
    expect(lifecycleFromLegacy({ state: "skipped", last_error: "robots.txt disallow" })).toBe("restricted");
    expect(lifecycleFromLegacy({ state: "skipped", last_error: "EGRESS_BLOCKED: x" })).toBe("skipped");
    expect(lifecycleFromLegacy({ state: "failed" })).toBe("permanently_failed");
  });

  it("classifies retryable vs permanent outcomes", () => {
    expect(["ok", "not_modified", "retryable", "retryable", "retryable", "unavailable", "unavailable", "restricted", "restricted"]).toEqual([200, 304, 429, 503, 408, 404, 410, 403, 451].map(classifyHttp));
    expect(classifyError(new FetchBlockedError("non_public_ip", "http://10.0.0.1/"))).toEqual({ kind: "policy", reason: "egress_policy:non_public_ip" });
    expect(classifyError(new FetchBlockedError("too_many_redirects", "http://x/"))).toEqual({ kind: "permanent", reason: "too_many_redirects" });
    expect(classifyError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })).kind).toBe("retryable");
    expect(classifyError(new Error("The operation was aborted due to timeout")).reason).toBe("timeout");
    expect(RETRY_POLICY.backoffMs(1)).toBe(15 * 60_000);
    expect(RETRY_POLICY.backoffMs(2)).toBe(30 * 60_000);
    expect(RETRY_POLICY.backoffMs(10)).toBe(6 * 3600_000);
    expect(RETRY_POLICY.backoffMs(1, 2 * 3600_000)).toBe(2 * 3600_000); // Retry-After honoured when longer
    expect(retryAfterMs("120", 0)).toBe(120_000);
    expect(retryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
  });
});

describe("helpers used by coverage", () => {
  it("classifies hosting TLDs as a weak country signal", () => {
    expect(classifyTld("de")).toEqual({ type: "cctld", country: "DE", genericUse: false });
    expect(classifyTld("uk")).toMatchObject({ type: "cctld", country: "GB" });
    expect(classifyTld("io")).toMatchObject({ type: "cctld", genericUse: true });
    expect(classifyTld("eu").type).toBe("supranational_or_legacy");
    expect(classifyTld("com").type).toBe("generic");
    expect(classifyTld("1").type).toBe("ip_literal");
    expect(countriesFromObservedTlds(["in", "com", "de", "uk"]).map((c) => c.code)).toEqual(["DE", "GB", "IN"]);
  });

  it("redacts credential-like strings but keeps ordinary text", () => {
    const r = redactSecrets("token: " + "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789" + " and Bearer abcdefghijklmnopqrstuvwxyz.123 normal words password=hunter2hunter2 https://u:p4ss@example.org/x");
    expect(r.text).not.toMatch(/ghp_|hunter2|p4ss|abcdefghijklmnopqrstuvwxyz\.123/);
    expect(r.text).toContain("normal words");
    expect(r.counts).toMatchObject({ github_token: 1, bearer_token: 1, secret_assignment: 1, url_credentials: 1 });
    expect(redactSecrets("The password policy requires rotation.").total).toBe(0);
  });

  it("OFFLINE_VERIFIED (the capability matrix's 'tested' claim) matches what the fixtures really yield", async () => {
    const actual: Record<string, Set<number>> = {};
    for (const { res } of await fixtureCorpus()) {
      const r = await analyzeResponse(res, { sourceType: "url", enrich: false });
      for (const c of r.categories) if (c.state === "observed" && r.fields.some((f) => f.category === c.id && f.status !== "extraction_failed")) (actual[r.kind] ??= new Set()).add(c.id);
    }
    for (const [kind, cats] of Object.entries(OFFLINE_VERIFIED)) for (const c of cats!) expect(actual[kind]?.has(c), `${kind} ${c}`).toBe(true);
    expect(new Set(Object.values(OFFLINE_VERIFIED).flat()).size).toBe(CATEGORIES.length);
  });
});

for (const makeBackend of backends()) {
  const backend = makeBackend();
  describe(`lifecycle persistence [${backend.name}]`, () => {
    let store: Corpus;
    afterAll(async () => {
      await store?.close();
      await backend.dispose();
    });

    it("records every transition with a timestamp; compare-and-set rejects stale writers", async () => {
      store = await backend.open();
      await store.enqueue([{ url: "https://example.org/a", priority: 1, depth: 0, via: "test", purpose: "discovery" }], Date.now());
      const r = (await store.byUrl("https://example.org/a"))!;
      expect(r.lifecycle).toBe("discovered");
      const [leased] = await store.lease(1, 60_000, Date.now());
      expect(leased.lifecycle).toBe("leased");
      await store.transition(r.id, "leased", "fetched", "http_200", "HTTP 200", { http_status: 200 });
      expect((await store.get(r.id))!.http_status).toBe(200);
      await expect(store.transition(r.id, "leased", "fetched")).rejects.toThrow(/row is in fetched, expected leased/);
      await expect(store.transition(r.id, "fetched", "validated")).rejects.toThrow(IllegalTransitionError);
      await store.transition(r.id, "fetched", ["inspected", "extracted", "validated", "indexed"], "test");
      const t = (await store.transitionsFor(r.id)).reverse();
      expect(t.map((x) => `${x.from ?? "∅"}→${x.to}`)).toEqual(["∅→discovered", "discovered→leased", "leased→fetched", "fetched→inspected", "inspected→extracted", "extracted→validated", "validated→indexed"]);
      expect(t.every((x) => !Number.isNaN(Date.parse(x.ts)))).toBe(true);
      expect((await store.stats()).byLifecycle).toMatchObject({ indexed: 1 });
    });

    it("an abandoned in-flight item is rescheduled (→ scheduled) on lease recovery", async () => {
      await store.enqueue([{ url: "https://example.net/b", priority: 1, depth: 0, via: "test", purpose: "discovery" }], 1000);
      const [b] = await store.lease(1, 10, 1000);
      await store.transition(b.id, "leased", "fetched");
      expect(await store.recoverLeases(5000)).toBe(1);
      const row = (await store.get(b.id))!;
      expect(row).toMatchObject({ state: "queued", lifecycle: "scheduled", lifecycle_reason: "lease_expired" });
      expect((await store.transitionsFor(b.id))[0]).toMatchObject({ from: "fetched", to: "scheduled" });
    });

    it("migrates rows written before lifecycle-v1 (data_migrations) and keeps old state names readable", async () => {
      await store.enqueue([
        { url: "https://example.org/old-dup", priority: 1, depth: 0, via: "test", purpose: "discovery" },
        { url: "https://example.org/old-robots", priority: 1, depth: 0, via: "test", purpose: "discovery" },
      ]);
      const dup = (await store.byUrl("https://example.org/old-dup"))!;
      const rob = (await store.byUrl("https://example.org/old-robots"))!;
      // Simulate pre-migration rows: legacy columns only.
      await store.setStage(dup.id, { state: "indexed", duplicate_of: 1, lifecycle: null, lifecycle_reason: null });
      await store.setStage(rob.id, { state: "skipped", last_error: "robots.txt disallow", lifecycle: null, lifecycle_reason: null });
      if (backend.name === "sqlite") {
        await store.close();
        const db = new Database((store as SqliteCorpus).path);
        db.prepare(`DELETE FROM data_migrations WHERE id = 'lifecycle-v1'`).run();
        db.close();
        store = await backend.reopen();
      } else await (store as PgCorpus).backfill();
      // Readers see the mapped lifecycle even before/without the backfill (COALESCE fallback) — and after it, stored.
      expect((await store.get(dup.id))!).toMatchObject({ state: "indexed", lifecycle: "superseded", lifecycle_reason: "duplicate_content" });
      expect((await store.get(rob.id))!).toMatchObject({ state: "skipped", lifecycle: "restricted", lifecycle_reason: "robots_disallow" });
      expect((await store.transitionsFor(rob.id))[0]).toMatchObject({ from: "legacy:skipped", to: "restricted", reason: "migration:lifecycle-v1" });
    });
  });
}

// SQLite: an on-disk database created by the previous schema (no lifecycle columns at all) opens and migrates.
describe("schema upgrade from a pre-lifecycle SQLite file", () => {
  it("adds the columns and backfills lifecycle from legacy state", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "omni-old-")), "corpus.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE resources (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, url_hash TEXT NOT NULL, host TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      priority REAL NOT NULL DEFAULT 0, depth INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL, purpose TEXT NOT NULL, parent_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER, due_at INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL, retrieved_at TEXT, inspected_at TEXT, extracted_at TEXT, indexed_at TEXT,
      http_status INTEGER, kind TEXT, title TEXT, description TEXT, content_hash TEXT, etag TEXT, last_modified TEXT, final_url TEXT, field_count INTEGER NOT NULL DEFAULT 0,
      extractor_errors INTEGER NOT NULL DEFAULT 0, snapshot_count INTEGER NOT NULL DEFAULT 0, change_count INTEGER NOT NULL DEFAULT 0, unchanged_count INTEGER NOT NULL DEFAULT 0,
      duplicate_of INTEGER, last_error TEXT)`);
    db.prepare(`INSERT INTO resources (url, url_hash, host, state, via, purpose, discovered_at, http_status) VALUES ('https://e.org/x', 'h', 'e.org', 'unavailable', 't', 'discovery', '2026-01-01T00:00:00Z', 404)`).run();
    db.close();
    const store = new SqliteCorpus(path);
    const r = (await store.byUrl("https://e.org/x"))!;
    expect(r).toMatchObject({ state: "unavailable", lifecycle: "unavailable", lifecycle_reason: "http_404", failures: 0 });
    const cov = await store.coverageRaw(Date.now());
    expect(Number(cov.totals.discovered)).toBe(1);
    await store.close();
  });
});
