import * as cheerio from "cheerio";
import { safeFetchJson, safeFetchText } from "../net/safe-fetch.js";
import { clean, normalizeDate } from "../metadata/normalize.js";

export type ResultType = "encyclopedia" | "paper" | "dataset" | "model" | "repository" | "archive_item" | "web" | "entity" | "package";

export interface Highlight {
  category: number;
  field: string;
  value: unknown;
}

export interface ProviderHit {
  title: string;
  url: string;
  snippet: string | null;
  type: ResultType;
  date: string | null;
  identifiers: { doi?: string; arxiv?: string; wikidata?: string; github?: string; hf?: string; ia?: string };
  highlights: Highlight[];
  /** Position within its provider's result list (0-based). */
  rank: number;
}

export interface Provider {
  id: string;
  name: string;
  homepage: string;
  types: ResultType[];
  /** Build the public API request URL (recorded as provenance). */
  requestUrl(q: string, limit: number): string;
  search(q: string, limit: number): Promise<ProviderHit[]>;
}

type J = Record<string, unknown>;
const enc = encodeURIComponent;
const T = 6500;
const stripTags = (s: unknown) => clean(String(s ?? "").replace(/<[^>]+>/g, ""), 320);
const d = (v: unknown) => normalizeDate(v)?.iso ?? null;

export const PROVIDERS: Provider[] = [
  {
    id: "wikipedia",
    name: "Wikipedia",
    homepage: "https://www.wikipedia.org",
    types: ["encyclopedia"],
    requestUrl: (q, n) => `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=${n}&srprop=snippet|timestamp|wordcount&format=json&formatversion=2`,
    async search(q, n) {
      const data = await safeFetchJson<{ query?: { search?: J[] } }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.query?.search ?? []).map((r, i) => ({
        title: String(r.title),
        url: `https://en.wikipedia.org/wiki/${enc(String(r.title).replace(/ /g, "_"))}`,
        snippet: stripTags(r.snippet),
        type: "encyclopedia" as const,
        date: d(r.timestamp),
        identifiers: {},
        highlights: [
          { category: 12, field: "modified", value: d(r.timestamp) },
          { category: 2, field: "wordCount", value: r.wordcount },
          { category: 6, field: "license", value: "CC BY-SA 4.0 (Wikipedia text)" },
        ],
        rank: i,
      }));
    },
  },
  {
    id: "wikidata",
    name: "Wikidata",
    homepage: "https://www.wikidata.org",
    types: ["entity"],
    requestUrl: (q, n) => `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${enc(q)}&language=en&limit=${n}&format=json`,
    async search(q, n) {
      const data = await safeFetchJson<{ search?: J[] }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.search ?? []).map((r, i) => ({
        title: String(r.label ?? r.id),
        url: `https://www.wikidata.org/wiki/${r.id}`,
        snippet: clean(r.description),
        type: "entity" as const,
        date: null,
        identifiers: { wikidata: String(r.id) },
        highlights: [{ category: 14, field: "identifier", value: `wikidata:${r.id}` }, { category: 16, field: "types", value: ["wikibase:Item"] }],
        rank: i,
      }));
    },
  },
  {
    id: "crossref",
    name: "Crossref",
    homepage: "https://www.crossref.org",
    types: ["paper"],
    requestUrl: (q, n) => `https://api.crossref.org/works?query=${enc(q)}&rows=${n}&select=DOI,title,author,container-title,issued,URL,type,publisher,is-referenced-by-count,license,abstract`,
    async search(q, n) {
      const data = await safeFetchJson<{ message?: { items?: J[] } }>(this.requestUrl(q, n), { timeoutMs: T, headers: { "user-agent": "OmnispiderMetadataBot/2.0 (mailto:metadata-bot@users.noreply.github.com)" } });
      return (data.message?.items ?? []).map((r, i) => {
        const issued = (r.issued as J | undefined)?.["date-parts"] as number[][] | undefined;
        const year = issued?.[0]?.[0];
        const authors = ((r.author ?? []) as J[]).slice(0, 5).map((a) => clean(`${a.given ?? ""} ${a.family ?? a.name ?? ""}`)).filter(Boolean);
        const doi = String(r.DOI).toLowerCase();
        return {
          title: clean(Array.isArray(r.title) ? r.title[0] : r.title) ?? doi,
          url: `https://doi.org/${doi}`,
          snippet: stripTags(r.abstract) ?? clean([authors.join(", "), Array.isArray(r["container-title"]) ? r["container-title"][0] : null].filter(Boolean).join(" — ")),
          type: "paper" as const,
          date: year ? new Date(Date.UTC(year, (issued![0][1] ?? 1) - 1, issued![0][2] ?? 1)).toISOString() : null,
          identifiers: { doi },
          highlights: [
            { category: 14, field: "doi", value: doi },
            { category: 36, field: "journal", value: Array.isArray(r["container-title"]) ? r["container-title"][0] ?? null : null },
            { category: 36, field: "citations", value: r["is-referenced-by-count"] },
            { category: 1, field: "author", value: authors },
            { category: 8, field: "publisher", value: r.publisher },
            { category: 6, field: "licenseUrl", value: ((r.license ?? []) as J[])[0]?.URL ?? null },
          ],
          rank: i,
        };
      });
    },
  },
  {
    id: "openalex",
    name: "OpenAlex",
    homepage: "https://openalex.org",
    types: ["paper"],
    requestUrl: (q, n) => `https://api.openalex.org/works?search=${enc(q)}&per-page=${n}&select=id,doi,display_name,publication_date,cited_by_count,open_access,primary_location,type,authorships`,
    async search(q, n) {
      const data = await safeFetchJson<{ results?: J[] }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.results ?? []).map((r, i) => {
        const doi = typeof r.doi === "string" ? r.doi.replace(/^https?:\/\/doi\.org\//, "").toLowerCase() : undefined;
        const loc = (r.primary_location ?? {}) as J;
        const src = (loc.source ?? {}) as J;
        const oa = (r.open_access ?? {}) as J;
        return {
          title: clean(r.display_name) ?? String(r.id),
          url: doi ? `https://doi.org/${doi}` : String(loc.landing_page_url ?? r.id),
          snippet: clean([((r.authorships ?? []) as J[]).slice(0, 4).map((a) => (a.author as J)?.display_name).join(", "), src.display_name].filter(Boolean).join(" — ")),
          type: "paper" as const,
          date: d(r.publication_date),
          identifiers: { doi },
          highlights: [
            { category: 14, field: "doi", value: doi ?? null },
            { category: 14, field: "identifier", value: `openalex:${String(r.id).split("/").pop()}` },
            { category: 36, field: "citations", value: r.cited_by_count },
            { category: 7, field: "openAccess", value: oa.oa_status ?? null },
            { category: 6, field: "license", value: loc.license ?? null },
          ],
          rank: i,
        };
      });
    },
  },
  {
    id: "arxiv",
    name: "arXiv",
    homepage: "https://arxiv.org",
    types: ["paper"],
    requestUrl: (q, n) => `https://export.arxiv.org/api/query?search_query=all:${enc(q)}&start=0&max_results=${n}`,
    async search(q, n) {
      const xml = await safeFetchText(this.requestUrl(q, n), { timeoutMs: T, accept: "application/atom+xml" });
      const $ = cheerio.load(xml, { xml: true });
      return $("entry").map((i, el) => {
        const e = $(el);
        const absUrl = e.find("id").first().text().trim();
        const id = absUrl.split("/abs/")[1] ?? absUrl;
        const doi = e.find("arxiv\\:doi").text().trim() || undefined;
        return {
          title: clean(e.find("title").first().text()) ?? id,
          url: absUrl.replace(/^http:/, "https:"),
          snippet: clean(e.find("summary").text(), 320),
          type: "paper" as const,
          date: d(e.find("published").text()),
          identifiers: { arxiv: id, doi: doi?.toLowerCase() },
          highlights: [
            { category: 14, field: "arxiv", value: id },
            { category: 1, field: "author", value: e.find("author name").slice(0, 5).map((_, a) => $(a).text()).get() },
            { category: 1, field: "subject", value: e.find("category").map((_, c) => $(c).attr("term")).get().slice(0, 5) },
            { category: 11, field: "version", value: id.match(/v(\d+)$/)?.[1] ?? null },
          ],
          rank: i,
        };
      }).get();
    },
  },
  {
    id: "internet_archive",
    name: "Internet Archive",
    homepage: "https://archive.org",
    types: ["archive_item", "dataset"],
    requestUrl: (q, n) => `https://archive.org/advancedsearch.php?q=${enc(q)}&fl[]=identifier&fl[]=title&fl[]=mediatype&fl[]=date&fl[]=description&fl[]=licenseurl&fl[]=downloads&rows=${n}&output=json`,
    async search(q, n) {
      const data = await safeFetchJson<{ response?: { docs?: J[] } }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.response?.docs ?? []).map((r, i) => ({
        title: clean(Array.isArray(r.title) ? r.title[0] : r.title) ?? String(r.identifier),
        url: `https://archive.org/details/${r.identifier}`,
        snippet: stripTags(Array.isArray(r.description) ? r.description[0] : r.description),
        type: r.mediatype === "data" ? ("dataset" as const) : ("archive_item" as const),
        date: d(r.date),
        identifiers: { ia: String(r.identifier) },
        highlights: [
          { category: 4, field: "format", value: r.mediatype },
          { category: 5, field: "archived", value: true },
          { category: 6, field: "licenseUrl", value: r.licenseurl ?? null },
          { category: 23, field: "downloads", value: r.downloads ?? null },
        ],
        rank: i,
      }));
    },
  },
  {
    id: "github",
    name: "GitHub",
    homepage: "https://github.com",
    types: ["repository"],
    requestUrl: (q, n) => `https://api.github.com/search/repositories?q=${enc(q)}&per_page=${n}`,
    async search(q, n) {
      const headers: Record<string, string> = { accept: "application/vnd.github+json" };
      if (process.env.GITHUB_TOKEN_PUBLIC) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN_PUBLIC}`;
      const data = await safeFetchJson<{ items?: J[] }>(this.requestUrl(q, n), { timeoutMs: T, headers });
      return (data.items ?? []).map((r, i) => ({
        title: String(r.full_name),
        url: String(r.html_url),
        snippet: clean(r.description),
        type: "repository" as const,
        date: d(r.pushed_at),
        identifiers: { github: String(r.full_name) },
        highlights: [
          { category: 23, field: "stars", value: r.stargazers_count },
          { category: 6, field: "license", value: ((r.license ?? {}) as J).spdx_id ?? null },
          { category: 4, field: "primaryLanguage", value: r.language },
          { category: 24, field: "tags", value: r.topics ?? [] },
          { category: 12, field: "modified", value: d(r.pushed_at) },
        ],
        rank: i,
      }));
    },
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    homepage: "https://huggingface.co",
    types: ["model", "dataset"],
    requestUrl: (q, n) => `https://huggingface.co/api/models?search=${enc(q)}&limit=${n}&sort=downloads&direction=-1`,
    async search(q, n) {
      const [models, datasets] = await Promise.all([
        safeFetchJson<J[]>(this.requestUrl(q, n), { timeoutMs: T }).catch(() => [] as J[]),
        safeFetchJson<J[]>(`https://huggingface.co/api/datasets?search=${enc(q)}&limit=${Math.ceil(n / 2)}&sort=downloads&direction=-1`, { timeoutMs: T }).catch(() => [] as J[]),
      ]);
      const map = (r: J, i: number, kind: "model" | "dataset") => ({
        title: String(r.id ?? r.modelId),
        url: `https://huggingface.co/${kind === "dataset" ? "datasets/" : ""}${r.id ?? r.modelId}`,
        snippet: clean([r.pipeline_tag, r.library_name].filter(Boolean).join(" · ")) ?? null,
        type: kind,
        date: d(r.lastModified ?? r.createdAt),
        identifiers: { hf: String(r.id ?? r.modelId) },
        highlights: [
          { category: 37, field: "pipelineTag", value: r.pipeline_tag ?? null },
          { category: 23, field: "downloads", value: r.downloads ?? null },
          { category: 23, field: "likes", value: r.likes ?? null },
          { category: 7, field: "gated", value: r.gated ?? false },
        ],
        rank: i,
      });
      return [...models.map((r, i) => map(r, i, "model")), ...datasets.map((r, i) => map(r, i, "dataset"))];
    },
  },
  {
    id: "datagov",
    name: "Data.gov (CKAN)",
    homepage: "https://catalog.data.gov",
    types: ["dataset"],
    requestUrl: (q, n) => `https://catalog.data.gov/api/3/action/package_search?q=${enc(q)}&rows=${n}`,
    async search(q, n) {
      const data = await safeFetchJson<{ result?: { results?: J[] } }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.result?.results ?? []).map((r, i) => {
        const extras = ((r.extras ?? []) as J[]).reduce<Record<string, unknown>>((a, e) => ((a[String(e.key)] = e.value), a), {});
        return {
          title: clean(r.title) ?? String(r.name),
          url: `https://catalog.data.gov/dataset/${r.name}`,
          snippet: clean(r.notes, 320),
          type: "dataset" as const,
          date: d(r.metadata_modified),
          identifiers: {},
          highlights: [
            { category: 3, field: "maintainer", value: ((r.organization ?? {}) as J).title ?? r.maintainer ?? null },
            { category: 6, field: "license", value: r.license_title ?? null },
            { category: 13, field: "spatialCoverage", value: typeof extras.spatial === "string" ? extras.spatial.slice(0, 120) : null },
            { category: 22, field: "refreshInterval", value: extras.accrualPeriodicity ?? null },
            { category: 2, field: "resourceCount", value: Array.isArray(r.resources) ? r.resources.length : null },
          ],
          rank: i,
        };
      });
    },
  },
  {
    id: "hackernews",
    name: "Hacker News (Algolia)",
    homepage: "https://news.ycombinator.com",
    types: ["web"],
    requestUrl: (q, n) => `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=${n}`,
    async search(q, n) {
      const data = await safeFetchJson<{ hits?: J[] }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.hits ?? [])
        .filter((r) => r.url)
        .map((r, i) => ({
          title: clean(r.title) ?? String(r.url),
          url: String(r.url),
          snippet: clean(`${r.points ?? 0} points · ${r.num_comments ?? 0} comments on Hacker News`),
          type: "web" as const,
          date: d(r.created_at),
          identifiers: {},
          highlights: [
            { category: 24, field: "commentCount", value: r.num_comments ?? null },
            { category: 23, field: "points", value: r.points ?? null },
            { category: 15, field: "discussion", value: `https://news.ycombinator.com/item?id=${r.objectID}` },
          ],
          rank: i,
        }));
    },
  },
];

PROVIDERS.push(
  {
    id: "zenodo",
    name: "Zenodo",
    homepage: "https://zenodo.org",
    types: ["dataset", "paper"],
    requestUrl: (q, n) => `https://zenodo.org/api/records?q=${enc(q)}&size=${n}&sort=bestmatch`,
    async search(q, n) {
      const data = await safeFetchJson<{ hits?: { hits?: J[] } }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.hits?.hits ?? []).map((r, i) => {
        const md = (r.metadata ?? {}) as J;
        const links = (r.links ?? {}) as J;
        return {
          title: clean(md.title) ?? String(r.id),
          url: String(links.self_html ?? `https://zenodo.org/records/${r.id}`),
          snippet: stripTags(md.description),
          type: (((md.resource_type ?? {}) as J).type === "dataset" ? "dataset" : "paper") as "dataset" | "paper",
          date: d(md.publication_date),
          identifiers: { doi: typeof r.doi === "string" ? r.doi.toLowerCase() : undefined },
          highlights: [{ category: 14, field: "doi", value: r.doi ?? null }, { category: 6, field: "license", value: ((md.license ?? {}) as J).id ?? null }],
          rank: i,
        };
      });
    },
  },
  {
    id: "dataverse",
    name: "Harvard Dataverse",
    homepage: "https://dataverse.harvard.edu",
    types: ["dataset"],
    requestUrl: (q, n) => `https://dataverse.harvard.edu/api/search?q=${enc(q)}&type=dataset&per_page=${n}`,
    async search(q, n) {
      const data = await safeFetchJson<{ data?: { items?: J[] } }>(this.requestUrl(q, n), { timeoutMs: T });
      return (data.data?.items ?? []).map((r, i) => ({
        title: clean(r.name) ?? String(r.global_id),
        url: String(r.url),
        snippet: clean(r.description, 320),
        type: "dataset" as const,
        date: d(r.published_at),
        identifiers: { doi: typeof r.global_id === "string" && r.global_id.startsWith("doi:") ? r.global_id.slice(4).toLowerCase() : undefined },
        highlights: [{ category: 8, field: "publisher", value: r.publisher ?? null }, { category: 1, field: "subject", value: r.subjects ?? [] }],
        rank: i,
      }));
    },
  },
);

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
