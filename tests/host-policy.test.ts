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

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteCorpus } from "../src/corpus/store.js";
describe("content-text-v1 migration", () => {
  it("schedules already-indexed web pages for one re-crawl, once", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "mig-")), "c.db");
    const first = new SqliteCorpus(path);
    first.db.prepare(`DELETE FROM data_migrations`).run();
    await first.close();
    const raw = new Database(path);
    const far = Date.now() + 30 * 864e5;
    raw.prepare(`INSERT INTO resources (url, url_hash, host, state, kind, due_at, via, purpose, discovered_at) VALUES ('https://a.example/', 'h1', 'a.example', 'indexed', 'webpage', ?, 'test', 'discovery', 'now'), ('https://a.example/x.pdf', 'h2', 'a.example', 'indexed', 'pdf', ?, 'test', 'discovery', 'now')`).run(far, far);
    raw.close();
    const second = new SqliteCorpus(path);
    const rows = second.db.prepare(`SELECT kind, due_at FROM resources ORDER BY id`).all() as { kind: string; due_at: number }[];
    expect(rows[0].due_at).toBeLessThan(Date.now() + 864e5 + 1000);
    expect(rows[1].due_at).toBe(far);
    second.db.prepare(`UPDATE resources SET due_at = ?`).run(far);
    await second.close();
    const third = new SqliteCorpus(path);
    expect((third.db.prepare(`SELECT due_at FROM resources WHERE kind = 'webpage'`).get() as { due_at: number }).due_at).toBe(far);
    await third.close();
  });
});
