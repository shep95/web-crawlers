import { beforeEach, describe, expect, it, vi } from "vitest";

// Recorded-shape payloads from each public API (trimmed). Providers must parse these without network.
const payloads: Record<string, unknown> = {
  "en.wikipedia.org": { query: { search: [{ title: "Web crawler", snippet: 'A <span class="searchmatch">Web crawler</span> is a bot', timestamp: "2025-09-01T10:00:00Z", wordcount: 5000 }] } },
  "www.wikidata.org": { search: [{ id: "Q180854", label: "web crawler", description: "Internet bot", concepturi: "http://www.wikidata.org/entity/Q180854" }] },
  "api.crossref.org": { message: { items: [{ DOI: "10.1000/CRAWL.1", title: ["Focused web crawling"], author: [{ given: "Ann", family: "Lee" }], "container-title": ["Computer Networks"], issued: { "date-parts": [[2019, 5, 2]] }, "is-referenced-by-count": 42, publisher: "Elsevier", license: [{ URL: "https://creativecommons.org/licenses/by/4.0/" }] }] } },
  "api.openalex.org": { results: [{ id: "https://openalex.org/W1", doi: "https://doi.org/10.1000/crawl.1", display_name: "Focused Web Crawling", publication_date: "2019-05-02", cited_by_count: 50, open_access: { oa_status: "gold" }, primary_location: { source: { display_name: "Computer Networks" }, license: "cc-by" }, authorships: [{ author: { display_name: "Ann Lee" } }] }, { id: "https://openalex.org/W2", doi: "https://doi.org/10.1000/other", display_name: "Focused web crawling", publication_date: "2001-01-01", primary_location: {}, authorships: [] }] },
  "api.github.com": { items: [{ full_name: "scrapy/scrapy", html_url: "https://github.com/scrapy/scrapy", description: "Fast crawling framework", stargazers_count: 55000, license: { spdx_id: "BSD-3-Clause" }, language: "Python", topics: ["crawler"], pushed_at: "2026-10-01T00:00:00Z" }] },
  "huggingface.co": [{ id: "org/crawler-model", pipeline_tag: "text-classification", downloads: 10, likes: 2, lastModified: "2025-01-01T00:00:00Z" }],
  "catalog.data.gov": { result: { results: [{ name: "web-crawl-stats", title: "Web crawl statistics", notes: "Counts", metadata_modified: "2024-01-01T00:00:00", license_title: "Public Domain", organization: { title: "Agency" }, extras: [{ key: "accrualPeriodicity", value: "R/P1M" }], resources: [{}, {}] }] } },
  "archive.org": { response: { docs: [{ identifier: "crawl-2015", title: "Crawl 2015", mediatype: "data", date: "2015-01-01T00:00:00Z", downloads: 99 }] } },
  "hn.algolia.com": { hits: [{ objectID: "1", title: "Show HN: crawler", url: "https://github.com/scrapy/scrapy?utm_source=hn", points: 100, num_comments: 20, created_at: "2024-01-01T00:00:00Z" }, { objectID: "2", title: "Ask HN", url: null }] },
};
const arxivXml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/2101.00001v2</id><title>Crawling at scale</title><summary>We study crawling.</summary><published>2021-01-01T00:00:00Z</published><author><name>Bo Chen</name></author><category term="cs.IR"/><arxiv:doi>10.1000/CRAWL.1</arxiv:doi></entry></feed>`;

vi.mock("../src/net/safe-fetch.js", async (orig) => {
  const actual = await orig<typeof import("../src/net/safe-fetch.js")>();
  return {
    ...actual,
    safeFetchJson: vi.fn(async (url: string) => {
      const host = new URL(url).hostname;
      if (host === "huggingface.co" && url.includes("/datasets")) return [];
      if (!(host in payloads)) throw new Error(`HTTP 503 from ${host}`);
      return payloads[host];
    }),
    safeFetchText: vi.fn(async () => arxivXml),
  };
});

const { federatedSearch, mergeAndRank, parseIntent } = await import("../src/search/engine.js");
const { PROVIDERS } = await import("../src/search/providers.js");

describe("intent", () => {
  it("routes URLs, DOIs and arXiv ids", () => {
    expect(parseIntent("https://example.com/x").kind).toBe("url");
    expect(parseIntent("10.1038/nature14539")).toMatchObject({ kind: "doi", normalized: "10.1038/nature14539" });
    expect(parseIntent("https://doi.org/10.1038/NATURE14539").kind).toBe("doi");
    expect(parseIntent("arXiv:2101.00001v2")).toMatchObject({ kind: "arxiv", normalized: "2101.00001v2" });
  });
  it("weights providers and categories by vocabulary", () => {
    const i = parseIntent("climate dataset licence");
    expect(i.weights.datagov).toBeGreaterThan(1);
    expect(i.categories).toEqual(expect.arrayContaining([6, 17, 19]));
    expect(parseIntent("bert language model").weights.huggingface).toBeGreaterThan(2);
  });
});

describe("providers parse their API payloads", () => {
  it.each(PROVIDERS.map((p) => [p.id, p] as const))("%s", async (_id, p) => {
    const hits = await p.search("web crawler", 5);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.title).toBeTruthy();
      expect(h.url).toMatch(/^https:\/\//);
      expect(h.rank).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("federated search", () => {
  beforeEach(() => vi.clearAllMocks());
  it("merges duplicates only on identical identifiers/URLs and keeps provenance", async () => {
    const res = await federatedSearch("focused web crawling", { fresh: true });
    expect(res.providers.filter((p) => p.ok).length).toBe(PROVIDERS.length);
    const doiHit = res.results.find((r) => r.identifiers.doi === "10.1000/crawl.1")!;
    // Crossref + OpenAlex + arXiv (via arxiv:doi) describe the same DOI → one result, three sources.
    expect(doiHit.sources.map((s) => s.provider).sort()).toEqual(["arxiv", "crossref", "openalex"]);
    expect(doiHit.sources.every((s) => s.apiUrl.startsWith("https://"))).toBe(true);
    // Same title, different DOI → NOT merged (similar names are not identity).
    expect(res.results.some((r) => r.identifiers.doi === "10.1000/other")).toBe(true);
    // HN link with tracking params collapses into the GitHub repository result.
    const repo = res.results.find((r) => r.url === "https://github.com/scrapy/scrapy")!;
    expect(repo.sources.map((s) => s.provider).sort()).toEqual(["github", "hackernews"]);
    // Ranked by score, descending.
    const scores = res.results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(res.results[0].identifiers.doi).toBe("10.1000/crawl.1");
  });
  it("reports failing providers without failing the search, and opens the circuit after repeats", async () => {
    const { safeFetchJson } = await import("../src/net/safe-fetch.js");
    const impl = (safeFetchJson as unknown as { getMockImplementation: () => (u: string) => Promise<unknown> }).getMockImplementation();
    vi.mocked(safeFetchJson).mockImplementation(async (url: string, o?: unknown) => {
      if (url.includes("wikidata")) throw new Error("HTTP 503 from www.wikidata.org");
      return impl(url, o as never);
    });
    for (let i = 0; i < 3; i++) await federatedSearch(`q${i}`, { fresh: true });
    const res = await federatedSearch("after", { fresh: true });
    const wd = res.providers.find((p) => p.provider === "wikidata")!;
    expect(wd.ok).toBe(false);
    expect(wd.skipped).toBe("circuit_open");
    expect(res.results.length).toBeGreaterThan(0);
  });
  it("caches and labels cache age", async () => {
    await federatedSearch("cache me");
    const second = await federatedSearch("cache me");
    expect(second.cache).toBe("hit");
    expect(typeof second.cachedAgeSeconds).toBe("number");
  });
  it("mergeAndRank prefers exact identifier matches for identifier queries", () => {
    const intent = parseIntent("10.1234/a1");
    const p = PROVIDERS[0];
    const results = mergeAndRank("10.1234/a1", intent, [{ provider: p, apiUrl: "https://x", retrievedAt: "t", hits: [
      { title: "Other", url: "https://doi.org/10.1234/b2", snippet: null, type: "paper", date: null, identifiers: { doi: "10.1234/b2" }, highlights: [], rank: 0 },
      { title: "Target", url: "https://doi.org/10.1234/a1", snippet: null, type: "paper", date: null, identifiers: { doi: "10.1234/a1" }, highlights: [], rank: 1 },
    ] }]);
    expect(results[0].title).toBe("Target");
  });
});
