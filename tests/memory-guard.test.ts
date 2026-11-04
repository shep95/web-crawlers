import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetMemoryGuard, admitWork, withBodyBudget, LARGE_BODY_BYTES } from "../src/corpus/memory-guard.js";

// Production crashed with "JavaScript heap out of memory" (5 crawlers x 4 jobs, 20 MB bodies).
describe("memory guard", () => {
  afterEach(() => __resetMemoryGuard());
  it("stops admitting above the high-water mark and resumes only below the low-water mark", () => {
    expect(admitWork(0.5)).toBe(true);
    expect(admitWork(0.71)).toBe(false);
    expect(admitWork(0.65)).toBe(false); // hysteresis: still paused between LOW and HIGH
    expect(admitWork(0.54)).toBe(true);
    expect(admitWork(0.65)).toBe(true);
  });
  it("parses at most two large bodies at a time; small bodies are not limited", async () => {
    let active = 0, peak = 0;
    const job = (bytes: number) => withBodyBudget(bytes, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; });
    await Promise.all(Array.from({ length: 6 }, () => job(LARGE_BODY_BYTES + 1)));
    expect(peak).toBe(2);
    active = 0; peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => job(1024)));
    expect(peak).toBe(6);
  });
  it("a crawler under heap pressure leases nothing", async () => {
    const guard = await import("../src/corpus/memory-guard.js");
    const { AutonomousCrawler } = await import("../src/corpus/crawler.js");
    const { SqliteCorpus } = await import("../src/corpus/store.js");
    const store = new SqliteCorpus(":memory:");
    await store.enqueue([{ url: "https://example.org/a", priority: 50, depth: 0, via: "test", purpose: "discovery" as const }], Date.now());
    const leased = vi.spyOn(store, "lease");
    const c = new AutonomousCrawler({ store, profile: "generalist", fetch: async () => { throw new Error("should not fetch"); } } as never);
    guard.__setPressureSource(() => 0.95);
    expect(await c.tick()).toBe(0);
    expect(leased).not.toHaveBeenCalled();
    guard.__setPressureSource(() => 0.2);
    expect(await c.tick()).toBeGreaterThan(0); // resumes once pressure drops
    await c.stop();
    await store.close();
  });
});
