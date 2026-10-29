import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { safeFetchJson, safeFetchText } from "../net/safe-fetch.js";
import { canonicalizeUrl } from "../crawl/site-crawler.js";
import type { FrontierItem } from "./store.js";

/**
 * Bootstrap discovery sources: public catalogs, directories, feeds and
 * sitemaps that seed and continually refresh the frontier. Users never have
 * to supply URLs; everything below is fetched on a schedule.
 */
export interface DiscoverySource {
  id: string;
  description: string;
  intervalMs: number;
  run(): Promise<FrontierItem[]>;
}

type J = Record<string, unknown>;
const item = (url: string, source: string, priority: number, purpose: FrontierItem["purpose"] = "bootstrap"): FrontierItem | null => {
  const c = canonicalizeUrl(url);
  return c ? { url: c, priority, depth: 0, via: `bootstrap:${source}`, purpose } : null;
};
const compact = (xs: Array<FrontierItem | null>) => xs.filter((x): x is FrontierItem => Boolean(x));
const H = 3600_000;

export const BUILTIN_SOURCES: DiscoverySource[] = [
  {
    id: "datagov_ckan",
    description: "Data.gov CKAN catalog — most recently modified datasets, their landing pages and distribution files",
    intervalMs: 6 * H,
    async run() {
      const d = await safeFetchJson<{ result: { results: J[] } }>("https://catalog.data.gov/api/3/action/package_search?rows=40&sort=metadata_modified%20desc", { timeoutMs: 20_000 });
      return compact(
        d.result.results.flatMap((p) => [
          item(`https://catalog.data.gov/api/3/action/package_show?id=${p.name}`, "datagov_ckan", 70),
          item(`https://catalog.data.gov/dataset/${p.name}`, "datagov_ckan", 66),
          ...((p.resources as J[] | undefined) ?? []).slice(0, 4).map((r) => (typeof r.url === "string" ? item(r.url, "datagov_ckan", 64, "artifact") : null)),
        ]),
      );
    },
  },
  {
    id: "zenodo",
    description: "Zenodo — recently published open research records (datasets, papers, software) with files and DOIs",
    intervalMs: 6 * H,
    async run() {
      const d = await safeFetchJson<{ hits: { hits: J[] } }>("https://zenodo.org/api/records?sort=mostrecent&size=40&access_status=open", { timeoutMs: 20_000 });
      return compact(
        d.hits.hits.flatMap((r) => {
          const links = (r.links ?? {}) as J;
          const files = ((r.files ?? []) as J[]).filter((f) => Number(f.size ?? 0) < 20_000_000).slice(0, 3);
          return [
            typeof links.self_html === "string" ? item(links.self_html, "zenodo", 68) : null,
            typeof links.self === "string" ? item(links.self, "zenodo", 66) : null,
            ...files.map((f) => item(String(((f.links ?? {}) as J).self ?? ""), "zenodo", 62, "artifact")),
          ];
        }),
      );
    },
  },
  {
    id: "huggingface",
    description: "Hugging Face Hub — recently updated models and datasets (card pages + raw model cards)",
    intervalMs: 12 * H,
    async run() {
      const [models, datasets] = await Promise.all([
        safeFetchJson<J[]>("https://huggingface.co/api/models?sort=lastModified&direction=-1&limit=30", { timeoutMs: 20_000 }),
        safeFetchJson<J[]>("https://huggingface.co/api/datasets?sort=lastModified&direction=-1&limit=20", { timeoutMs: 20_000 }),
      ]);
      return compact([
        ...models.flatMap((m) => [item(`https://huggingface.co/${m.id}`, "huggingface", 62), item(`https://huggingface.co/${m.id}/raw/main/README.md`, "huggingface", 64, "supporting:model_card")]),
        ...datasets.flatMap((m) => [item(`https://huggingface.co/datasets/${m.id}`, "huggingface", 62), item(`https://huggingface.co/datasets/${m.id}/raw/main/README.md`, "huggingface", 64, "supporting:model_card")]),
      ]);
    },
  },
  {
    id: "commons",
    description: "Wikimedia Commons — newest uploaded media files (EXIF/IPTC/XMP-bearing images, audio, video) and their description pages",
    intervalMs: 6 * H,
    async run() {
      const d = await safeFetchJson<{ query: { allimages: J[] } }>("https://commons.wikimedia.org/w/api.php?action=query&list=allimages&aisort=timestamp&aidir=descending&ailimit=30&aiprop=url|size|mime&format=json&formatversion=2", { timeoutMs: 20_000 });
      return compact(d.query.allimages.filter((i) => Number(i.size ?? 0) < 15_000_000).flatMap((i) => [item(String(i.url), "commons", 63, "artifact"), item(String(i.descriptionurl), "commons", 58)]));
    },
  },
  {
    id: "internet_archive",
    description: "Internet Archive — recently added public-domain/open items with their metadata records",
    intervalMs: 12 * H,
    async run() {
      const d = await safeFetchJson<{ response: { docs: J[] } }>("https://archive.org/advancedsearch.php?q=licenseurl%3A*creativecommons*%20AND%20mediatype%3A(texts%20OR%20audio%20OR%20movies%20OR%20data)&fl[]=identifier&sort[]=addeddate%20desc&rows=25&output=json", { timeoutMs: 20_000 });
      return compact(d.response.docs.flatMap((x) => [item(`https://archive.org/details/${x.identifier}`, "internet_archive", 60), item(`https://archive.org/metadata/${x.identifier}`, "internet_archive", 62)]));
    },
  },
  {
    id: "arxiv_feed",
    description: "arXiv RSS — new submissions in digital libraries and information retrieval",
    intervalMs: 12 * H,
    async run() {
      const xml = await safeFetchText("https://rss.arxiv.org/rss/cs.DL+cs.IR", { timeoutMs: 20_000, accept: "application/rss+xml" });
      return compact([...xml.matchAll(/<link>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/link>/g)].slice(0, 30).map((m) => item(m[1], "arxiv_feed", 60)));
    },
  },
  {
    id: "hackernews",
    description: "Hacker News front page — currently discussed public web resources across many sites",
    intervalMs: 3 * H,
    async run() {
      const d = await safeFetchJson<{ hits: J[] }>("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40", { timeoutMs: 20_000 });
      return compact(d.hits.map((h) => (typeof h.url === "string" ? item(h.url, "hackernews", 50) : null)));
    },
  },
];

/** Extra feed/sitemap/page seeds from config/discovery.yaml (operator-managed, not user input). */
export function configuredSources(): DiscoverySource[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const path = process.env.DISCOVERY_CONFIG ?? join(root, "config", "discovery.yaml");
  if (!existsSync(path)) return [];
  const cfg = yaml.load(readFileSync(path, "utf8")) as { seeds?: Array<{ id: string; url: string; type?: string; interval_hours?: number; priority?: number }> };
  return (cfg.seeds ?? []).map((s) => ({
    id: s.id,
    description: `${s.type ?? "page"} seed: ${s.url}`,
    intervalMs: (s.interval_hours ?? 24) * H,
    async run() {
      const it = item(s.url, s.id, s.priority ?? 60);
      return it ? [it] : [];
    },
  }));
}

export function allSources(): DiscoverySource[] {
  const enabled = (process.env.BOOTSTRAP_SOURCES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const all = [...BUILTIN_SOURCES, ...configuredSources()];
  return enabled.length ? all.filter((s) => enabled.includes(s.id)) : all;
}
