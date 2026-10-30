import { afterAll, describe, expect, it } from "vitest";
import { plumbingPenalty } from "../src/corpus/search.js";
import { DEFAULT_EXCLUDED_HOSTS, excludedHosts, isExcludedHost, isExcludedUrl } from "../src/corpus/host-policy.js";
import { backends } from "./helpers/backends.js";
import type { Corpus } from "../src/corpus/types.js";

describe("host policy", () => {
  it("excludes the Wikimedia family by default, including subdomains", () => {
    expect(excludedHosts(undefined)).toEqual(DEFAULT_EXCLUDED_HOSTS);
    for (const h of ["en.wikipedia.org", "wikipedia.org", "upload.wikimedia.org", "commons.wikimedia.org", "www.wikidata.org", "EN.WIKIPEDIA.ORG."]) expect(isExcludedHost(h), h).toBe(true);
    for (const h of ["notwikipedia.org", "wikipedia.org.example.com", "archive.org", "zenodo.org"]) expect(isExcludedHost(h), h).toBe(false);
    expect(isExcludedUrl("https://en.wikipedia.org/wiki/Dorset_dialect")).toBe(true);
    expect(isExcludedUrl("not a url")).toBe(false);
  });

  it("is operator-configurable", () => {
    expect(excludedHosts("none")).toEqual([]);
    expect(excludedHosts(" *.example.com, Other.org ")).toEqual(["example.com", "other.org"]);
    expect(isExcludedHost("a.example.com", excludedHosts("example.com"))).toBe(true);
    expect(isExcludedHost("en.wikipedia.org", excludedHosts("none"))).toBe(false);
  });
});

for (const makeBackend of backends()) {
  const backend = makeBackend();
  describe(`frontier never accepts excluded hosts [${backend.name}]`, () => {
    let store: Corpus;
    afterAll(async () => {
      await store?.close();
      await backend.dispose();
    });
    it("drops excluded URLs at enqueue and keeps the rest", async () => {
      store = await backend.open();
      const added = await store.enqueue([
        { url: "https://en.wikipedia.org/wiki/Dorset_dialect", priority: 80, depth: 0, via: "search_api:wikipedia", purpose: "discovery" },
        { url: "https://upload.wikimedia.org/a.jpg", priority: 80, depth: 0, via: "bootstrap:commons", purpose: "artifact" },
        { url: "https://archive.org/details/grammarglossaryo00barn", priority: 80, depth: 0, via: "search_api:internet_archive", purpose: "discovery" },
      ]);
      expect(added).toBe(1);
      expect(await store.byUrl("https://en.wikipedia.org/wiki/Dorset_dialect")).toBeUndefined();
      expect((await store.byUrl("https://archive.org/details/grammarglossaryo00barn"))?.state).toBe("queued");
      expect(await store.enqueue([{ url: "https://www.wikidata.org/wiki/Q1", priority: 1, depth: 0, via: "x", purpose: "discovery" }])).toBe(0);
    });
  });
}

describe("ranking", () => {
  it("ranks crawl plumbing and untitled files below titled pages", () => {
    expect(plumbingPenalty({ url: "https://techcrunch.com/sitemap-page-201.xml", title: null })).toBe(0.15);
    expect(plumbingPenalty({ url: "https://example.org/robots.txt", title: "robots" })).toBe(0.15);
    expect(plumbingPenalty({ url: "https://example.org/files/25-0507.pdf", title: null })).toBe(0.6);
    expect(plumbingPenalty({ url: "https://example.org/sitemaps-guide", title: "How sitemaps work" })).toBe(1);
  });
});

import { titleMatch } from "../src/corpus/search.js";
describe("match strength", () => {
  it("says whether the title names the query or only the text mentions it", () => {
    expect(titleMatch("Report - Climate Change Committee", ["climate", "change"])).toEqual({ matchedIn: "title", titleTerms: 2 });
    expect(titleMatch("Web crawling explained", ["web", "crawler"])).toEqual({ matchedIn: "title", titleTerms: 2 });
    expect(titleMatch("Privacy Policy | Proton", ["bitcoin", "price"])).toEqual({ matchedIn: "text", titleTerms: 0 });
  });
});
