import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { safeFetchJson, safeFetchText } from "../net/safe-fetch.js";
import { canonicalizeUrl } from "../crawl/site-crawler.js";
import type { FrontierItem } from "./store.js";
import { excludedHosts, isExcludedHost } from "./host-policy.js";
import { DiscoveryRotation, SOURCE_FAMILIES, type RotationCoverage } from "./rotation.js";
import { loadConfig } from "../core/config.js";

/**
 * Bootstrap discovery sources: public catalogs, directories, feeds and
 * sitemaps that seed and continually refresh the frontier. Users never have
 * to supply URLs; everything below is fetched on a schedule.
 */
export interface DiscoverySource {
  id: string;
  description: string;
  intervalMs: number;
  /** Hosts this source fetches from. A source whose hosts are all excluded is disabled (never fetched). */
  hosts?: string[];
  /** Kind of discovery input, used to rotate which family runs first. */
  family?: (typeof SOURCE_FAMILIES)[number];
  run(): Promise<FrontierItem[]>;
  /** Coverage of the last run (rotation sources), recorded by the crawler as an event. */
  lastCoverage?(): RotationCoverage | null;
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
    hosts: ["catalog.data.gov"],
    family: "catalog",
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
    hosts: ["zenodo.org"],
    family: "repository",
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
    hosts: ["huggingface.co"],
    family: "repository",
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
    hosts: ["commons.wikimedia.org", "upload.wikimedia.org"],
    family: "repository",
    description: "Wikimedia Commons — newest uploaded media files (EXIF/IPTC/XMP-bearing images, audio, video) and their description pages",
    intervalMs: 6 * H,
    async run() {
      const d = await safeFetchJson<{ query: { allimages: J[] } }>("https://commons.wikimedia.org/w/api.php?action=query&list=allimages&aisort=timestamp&aidir=descending&ailimit=30&aiprop=url|size|mime&format=json&formatversion=2", { timeoutMs: 20_000 });
      return compact(d.query.allimages.filter((i) => Number(i.size ?? 0) < 15_000_000).flatMap((i) => [item(String(i.url), "commons", 63, "artifact"), item(String(i.descriptionurl), "commons", 58)]));
    },
  },
  {
    id: "internet_archive",
    hosts: ["archive.org"],
    family: "archive",
    description: "Internet Archive — recently added public-domain/open items with their metadata records",
    intervalMs: 12 * H,
    async run() {
      const d = await safeFetchJson<{ response: { docs: J[] } }>("https://archive.org/advancedsearch.php?q=licenseurl%3A*creativecommons*%20AND%20mediatype%3A(texts%20OR%20audio%20OR%20movies%20OR%20data)&fl[]=identifier&sort[]=addeddate%20desc&rows=25&output=json", { timeoutMs: 20_000 });
      return compact(d.response.docs.flatMap((x) => [item(`https://archive.org/details/${x.identifier}`, "internet_archive", 60), item(`https://archive.org/metadata/${x.identifier}`, "internet_archive", 62)]));
    },
  },
  {
    id: "arxiv_feed",
    hosts: ["rss.arxiv.org", "arxiv.org"],
    family: "feed",
    description: "arXiv RSS — new submissions in digital libraries and information retrieval",
    intervalMs: 12 * H,
    async run() {
      const xml = await safeFetchText("https://rss.arxiv.org/rss/cs.DL+cs.IR", { timeoutMs: 20_000, accept: "application/rss+xml" });
      return compact([...xml.matchAll(/<link>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/link>/g)].slice(0, 30).map((m) => item(m[1], "arxiv_feed", 60)));
    },
  },
  {
    id: "hackernews",
    hosts: ["hn.algolia.com"],
    family: "feed",
    description: "Hacker News front page — currently discussed public web resources across many sites",
    intervalMs: 3 * H,
    async run() {
      const d = await safeFetchJson<{ hits: J[] }>("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40", { timeoutMs: 20_000 });
      return compact(d.hits.map((h) => (typeof h.url === "string" ? item(h.url, "hackernews", 50) : null)));
    },
  },
];

/** Common Crawl sampling config. `domains` are optional operator pins; the rotation supplies TLDs/languages/MIME types. */
export interface CommonCrawlConfig {
  domains?: string[];
  mimes?: string[];
  /** Sample by rotating ccTLD / gTLD / language / MIME family (default for the deployed source). */
  rotation?: boolean;
  /** Max frontier items per host per run (diversity guard). */
  perHost?: number;
}

const CC_INDEX_LIMIT = 25;

/**
 * Common Crawl's public URL index: finds standalone files (PDFs, CSVs, images, video,
 * archives, geo/scientific data…) that no webpage presents. With rotation on, each run
 * issues a fixed number of bounded queries (limit 25 each, 45 s timeout) for the next
 * rotation slots: `*.<ccTLD>` × MIME, `*.<gTLD>` × MIME and `*.<ccTLD>` HTML pages in a
 * rotating language. Operator-pinned domains (if any) take turns with rotation slots.
 */
export function commonCrawlSource(cfg: CommonCrawlConfig = { rotation: true }, pairsPerRun = 4, rotation = new DiscoveryRotation()): DiscoverySource {
  const pinned = cfg.domains ?? [];
  const mimes = cfg.mimes?.length ? cfg.mimes : null;
  const perHost = cfg.perHost ?? 6;
  let cursor = Math.floor(Date.now() / (6 * H));
  let slotIndex = 0;
  let coverage: RotationCoverage | null = null;
  return {
    id: "commoncrawl_files",
    family: "web_index",
    hosts: ["index.commoncrawl.org"],
    description: cfg.rotation ? "Common Crawl index — rotating ccTLD × gTLD × language × MIME-family samples (diversity-first, bounded)" : "Common Crawl index — standalone files by MIME type for operator-pinned domains",
    intervalMs: 6 * H,
    lastCoverage: () => coverage,
    async run() {
      if (!cfg.rotation && !pinned.length) return []; // rotation disabled and nothing pinned: no queries at all
      const coll = await safeFetchJson<Array<{ id: string; "cdx-api": string }>>("https://index.commoncrawl.org/collinfo.json", { timeoutMs: 20_000 });
      const api = coll[0]?.["cdx-api"];
      if (!api) return [];
      const queries: Array<{ dimension: RotationCoverage["queries"][number]["dimension"]; value: string; url: string; mime: string; filters: string[] }> = [];
      for (let i = 0; i < pairsPerRun; i++) {
        const usePinned = pinned.length > 0 && (!cfg.rotation || i % 2 === 1);
        if (usePinned) {
          const domain = pinned[cursor % pinned.length];
          const mime = (mimes ?? DEFAULT_PINNED_MIMES)[Math.floor(cursor / pinned.length) % (mimes ?? DEFAULT_PINNED_MIMES).length];
          cursor++;
          queries.push({ dimension: "pinned_domain", value: domain, url: domain, mime, filters: [`mime:${mime}`] });
          continue;
        }
        const slot = rotation.slot(slotIndex++);
        const mime = mimes ? mimes[slot.index % mimes.length] : slot.mime;
        const pick = slot.index % 3;
        if (pick === 0) queries.push({ dimension: "ccTld", value: slot.ccTld.tld, url: `*.${slot.ccTld.tld}`, mime, filters: [`mime:${mime}`] });
        else if (pick === 1) queries.push({ dimension: "gTld", value: slot.gTld, url: `*.${slot.gTld}`, mime, filters: [`mime:${mime}`] });
        else queries.push({ dimension: "language", value: `${slot.language.iso6393}@.${slot.ccTld.tld}`, url: `*.${slot.ccTld.tld}`, mime: "text/html", filters: ["mime:text/html", `~languages:${slot.language.iso6393}`] });
      }
      const out: FrontierItem[] = [];
      const hostCount = new Map<string, number>();
      const cov: RotationCoverage = { source: "commoncrawl_files", at: new Date().toISOString(), queries: [], totals: { queries: 0, items: 0, distinctTlds: 0, distinctHosts: 0 } };
      for (const q of queries) {
        const params = [`url=${encodeURIComponent(q.url)}`, ...(q.url.startsWith("*.") ? [] : ["matchType=domain"]), ...q.filters.map((f) => `filter=${encodeURIComponent(f)}`), "filter=status:200", "output=json", `limit=${CC_INDEX_LIMIT}`];
        let text = "";
        let error: string | undefined;
        try {
          text = await safeFetchText(`${api}?${params.join("&")}`, { timeoutMs: 45_000, accept: "application/json" });
        } catch (err) {
          error = (err as Error).message.slice(0, 120);
        }
        let n = 0;
        for (const line of text.split("\n").slice(0, CC_INDEX_LIMIT)) {
          try {
            const rec = JSON.parse(line) as { url?: string };
            const it = rec.url ? item(rec.url, "commoncrawl_files", q.mime === "text/html" ? 58 : 64, q.mime === "text/html" ? "discovery" : "artifact") : null;
            if (!it) continue;
            const host = new URL(it.url).hostname;
            if ((hostCount.get(host) ?? 0) >= perHost || isExcludedHost(host)) continue;
            hostCount.set(host, (hostCount.get(host) ?? 0) + 1);
            out.push(it);
            n++;
          } catch {
            /* skip non-JSON lines */
          }
        }
        cov.queries.push({ dimension: q.dimension, value: q.value, mime: q.mime, items: n, ...(error ? { error } : {}) });
      }
      const hosts = [...hostCount.keys()];
      cov.totals = { queries: queries.length, items: out.length, distinctTlds: new Set(hosts.map((h) => h.split(".").pop())).size, distinctHosts: hosts.length };
      coverage = cov;
      return out;
    },
  };
}

const DEFAULT_PINNED_MIMES = ["application/pdf", "text/csv", "image/jpeg", "video/mp4", "application/json", "application/zip", "audio/mpeg"];

/** Extra feed/sitemap/page seeds from config/discovery.yaml (operator-managed, not user input). */
interface DiscoveryConfig {
  seeds?: Array<{ id: string; url: string; type?: string; interval_hours?: number; priority?: number }>;
  commoncrawl?: { domains?: string[]; mimes?: string[]; rotation?: boolean; pairs_per_run?: number; per_host?: number };
}

function loadDiscoveryConfig(): DiscoveryConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const path = process.env.DISCOVERY_CONFIG ?? join(root, "config", "discovery.yaml");
  return existsSync(path) ? ((yaml.load(readFileSync(path, "utf8")) as DiscoveryConfig) ?? {}) : {};
}

export function configuredSources(): DiscoverySource[] {
  const cfg = loadDiscoveryConfig();
  return (cfg.seeds ?? []).map((s) => ({
    id: s.id,
    family: "operator_seed" as const,
    hosts: (() => {
      try {
        return [new URL(s.url).hostname];
      } catch {
        return [];
      }
    })(),
    description: `${s.type ?? "page"} seed: ${s.url}`,
    intervalMs: (s.interval_hours ?? 24) * H,
    async run() {
      const it = item(s.url, s.id, s.priority ?? 60);
      return it ? [it] : [];
    },
  }));
}

export interface DisabledSource {
  id: string;
  reason: string;
}

/**
 * Split sources into those allowed to run and those disabled by host policy. A source
 * whose every host is excluded (e.g. Wikimedia Commons under the default Wikimedia
 * exclusion) would only produce URLs that enqueue() drops — fetching it wastes budget.
 */
export function partitionSources(sources: DiscoverySource[], list = excludedHosts()): { enabled: DiscoverySource[]; disabled: DisabledSource[] } {
  const enabled: DiscoverySource[] = [];
  const disabled: DisabledSource[] = [];
  for (const s of sources) {
    const hosts = s.hosts ?? [];
    if (hosts.length && hosts.every((h) => isExcludedHost(h, list))) disabled.push({ id: s.id, reason: `all source hosts (${hosts.join(", ")}) are excluded by host policy (EXCLUDED_HOSTS); source disabled so no budget is spent fetching it` });
    else enabled.push(s);
  }
  return { enabled, disabled };
}

/** Rotation is on unless explicitly disabled (DISCOVERY_ROTATION=off, discovery.yaml commoncrawl.rotation: false, or default.yaml discovery.cc_tld_seeds: false). */
function rotationEnabled(cc: DiscoveryConfig["commoncrawl"]): boolean {
  if (process.env.DISCOVERY_ROTATION === "off") return false;
  if (cc?.rotation === false) return false;
  try {
    return loadConfig().discovery.ccTldSeeds !== false;
  } catch {
    return true;
  }
}

export function allSources(): DiscoverySource[] {
  return allSourcesWithPolicy().enabled;
}

export function allSourcesWithPolicy(): { enabled: DiscoverySource[]; disabled: DisabledSource[] } {
  const enabledIds = (process.env.BOOTSTRAP_SOURCES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const cc = loadDiscoveryConfig().commoncrawl;
  const all = [...BUILTIN_SOURCES, commonCrawlSource({ domains: cc?.domains ?? [], mimes: cc?.mimes, rotation: rotationEnabled(cc), perHost: cc?.per_host }, cc?.pairs_per_run ?? 4), ...configuredSources()];
  return partitionSources(enabledIds.length ? all.filter((s) => enabledIds.includes(s.id)) : all);
}
