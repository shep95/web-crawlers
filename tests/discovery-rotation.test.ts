import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fetched: string[] = [];
vi.mock("../src/net/safe-fetch.js", async (orig) => {
  const actual = await orig<typeof import("../src/net/safe-fetch.js")>();
  return {
    ...actual,
    safeFetchJson: vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.endsWith("collinfo.json")) return [{ id: "CC-MAIN-2026-40", "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-40-index" }];
      throw new Error(`unexpected fetch ${url}`);
    }),
    safeFetchText: vi.fn(async (url: string) => {
      fetched.push(url);
      const u = new URL(url);
      const pattern = u.searchParams.get("url")!; // "*.ke" or "*.africa"
      const tld = pattern.replace(/^\*\./, "");
      // 10 records on one host + 3 on others: the per-host cap must keep the run diverse.
      return [...Array.from({ length: 10 }, (_, i) => `https://big.example.${tld}/f${i}.pdf`), ...[1, 2, 3].map((i) => `https://site${i}.example.${tld}/x.pdf`)].map((x) => JSON.stringify({ url: x, status: "200" })).join("\n");
    }),
  };
});

const { ccTlds, genericTlds, interleavedCcTlds, rotationLanguages, mimeFamilies, DiscoveryRotation } = await import("../src/corpus/rotation.js");
const { commonCrawlSource, partitionSources, BUILTIN_SOURCES, allSourcesWithPolicy } = await import("../src/corpus/bootstrap.js");
const { DEFAULT_EXCLUDED_HOSTS } = await import("../src/corpus/host-policy.js");
const { AutonomousCrawler } = await import("../src/corpus/crawler.js");
const { SqliteCorpus } = await import("../src/corpus/store.js");

describe("rotation dimensions come from data packages, not a hardcoded short list", () => {
  it("covers every IANA ccTLD and the generic TLDs", () => {
    const cc = ccTlds().map((c) => c.tld);
    expect(cc.length).toBeGreaterThanOrEqual(240);
    for (const t of ["ke", "np", "bt", "tv", "pe", "mn", "fj", "is", "uk", "eu"]) expect(cc).toContain(t);
    const g = genericTlds();
    expect(g.length).toBeGreaterThan(1000);
    expect(g.every((t) => !/^[a-z]{2}$/.test(t))).toBe(true);
    expect(g).toEqual(expect.arrayContaining(["org", "africa", "asia", "lat"]));
  });
  it("interleaves ccTLDs across continents so consecutive picks change region", () => {
    const all = interleavedCcTlds();
    for (const start of [0, 100, all.length - 10]) expect(new Set(all.slice(start, start + 10).map((c) => c.continent)).size).toBeGreaterThanOrEqual(5);
    expect(interleavedCcTlds()).toHaveLength(ccTlds().length);
  });
  it("languages are mapped to ISO 639-3 for Common Crawl's languages filter", () => {
    const l = rotationLanguages();
    expect(l.length).toBeGreaterThan(100);
    expect(l.find((x) => x.iso6391 === "am")?.iso6393).toBe("amh");
    expect(l.find((x) => x.iso6391 === "qu")?.iso6393).toBe("que");
  });
  it("MIME families are derived from the format registry", () => {
    const fams = mimeFamilies().map((f) => f.family);
    for (const f of ["document", "data", "geo", "scientific", "subtitle", "web_archive", "audio", "video", "streaming"]) expect(fams).toContain(f);
  });
  it("a full cycle visits every ccTLD exactly once; any window of 20 slots spans ≥ 5 continents", () => {
    const r = new DiscoveryRotation(12345);
    const n = r.dimensions.ccTlds;
    const seen = new Set(Array.from({ length: n }, (_, i) => r.slot(i).ccTld.tld));
    expect(seen.size).toBe(n);
    for (const start of [0, 37, 200]) {
      const cont = new Set(Array.from({ length: 20 }, (_, i) => r.slot(start + i).ccTld.continent));
      expect(cont.size).toBeGreaterThanOrEqual(5);
    }
    const langs = new Set(Array.from({ length: 60 }, (_, i) => r.slot(i).language.iso6393));
    expect(langs.size).toBe(60);
    const mf = new Set(Array.from({ length: r.dimensions.mimeFamilies }, (_, i) => r.slot(i).mimeFamily));
    expect(mf.size).toBe(r.dimensions.mimeFamilies);
  });
});

describe("Common Crawl rotation source", () => {
  it("issues a fixed number of bounded queries over ccTLD / gTLD / language slots, caps per host, records coverage", async () => {
    fetched.length = 0;
    const src = commonCrawlSource({ rotation: true, perHost: 2 }, 6, new DiscoveryRotation(0));
    const items = await src.run();
    const cdx = fetched.filter((u) => u.includes("-index?"));
    expect(cdx).toHaveLength(6); // finite budget: exactly pairsPerRun index queries
    expect(cdx.every((u) => /limit=25/.test(u))).toBe(true);
    const cov = src.lastCoverage!()!;
    expect(cov.queries.map((q) => q.dimension)).toEqual(["ccTld", "gTld", "language", "ccTld", "gTld", "language"]);
    expect(cdx.filter((u) => u.includes("languages")).length).toBe(2);
    // per-host cap: 2 from the big host + 3 others per query
    expect(cov.queries.every((q) => q.items === 5)).toBe(true);
    expect(items).toHaveLength(30);
    expect(cov.totals.distinctTlds).toBeGreaterThanOrEqual(4);
    expect(new Set(items.map((i) => new URL(i.url).hostname)).size).toBe(cov.totals.distinctHosts);
  });
  it("rotation is the deployed default and is not limited to 12 fixed domains", () => {
    const cc = allSourcesWithPolicy().enabled.find((s) => s.id === "commoncrawl_files")!;
    expect(cc.description).toMatch(/rotating ccTLD/);
  });
  it("no queries at all when rotation is off and nothing is pinned", async () => {
    fetched.length = 0;
    expect(await commonCrawlSource({ rotation: false }, 4).run()).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe("host policy vs discovery sources (Wikimedia Commons)", () => {
  it("Commons is disabled under the default exclusion and re-enabled when the operator lifts it", () => {
    const def = partitionSources(BUILTIN_SOURCES, DEFAULT_EXCLUDED_HOSTS);
    expect(def.disabled.map((d) => d.id)).toEqual(["commons"]);
    expect(def.disabled[0].reason).toMatch(/excluded by host policy/);
    expect(def.enabled.some((s) => s.id === "commons")).toBe(false);
    expect(partitionSources(BUILTIN_SOURCES, []).disabled).toEqual([]);
    expect(allSourcesWithPolicy().disabled.map((d) => d.id)).toContain("commons");
  });
  it("the crawler never runs an excluded source and records why", async () => {
    const store = new SqliteCorpus(join(mkdtempSync(join(tmpdir(), "rot-")), "c.db"));
    const run = vi.fn(async () => []);
    const ok = vi.fn(async () => []);
    const events: Array<[string, string | undefined]> = [];
    const orig = store.event.bind(store);
    store.event = async (id, type, detail) => {
      events.push([type, detail]);
      return orig(id, type, detail);
    };
    const crawler = new AutonomousCrawler({ store, sources: [{ id: "commons", description: "c", intervalMs: 1, hosts: ["commons.wikimedia.org"], run }, { id: "ok", description: "o", intervalMs: 1, hosts: ["data.example.ng"], run: ok }], enrich: false });
    expect(crawler.disabledSources.map((d) => d.id)).toEqual(["commons"]);
    await crawler.reportDisabledSources();
    await crawler.runDueSources(Date.now(), true);
    expect(run).not.toHaveBeenCalled();
    expect(ok).toHaveBeenCalledOnce();
    expect(events.find(([t]) => t === "bootstrap_source_disabled")?.[1]).toMatch(/^commons: all source hosts \(commons\.wikimedia\.org\) are excluded/);
    await store.close();
  });
});
