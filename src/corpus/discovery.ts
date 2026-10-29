import { checkUrl } from "../net/ip-guard.js";
import { canonicalizeUrl } from "../crawl/site-crawler.js";
import type { ResourceRecord } from "../metadata/types.js";
import type { FrontierItem, Purpose } from "./store.js";

export interface Reference {
  url: string;
  text: string;
  rel: string;
  region: string; // main | body | nav | header | footer
  tag: string; // a | link | img | video | audio | source | track | iframe | json:<key> | sitemap | feed | pdf-text | jsonld
  type: string | null;
}

export interface CrawlLimits {
  maxDepth: number;
  hostBudget: number; // max resources enqueued per host
  maxUrlLength: number;
  maxQueryParams: number;
  maxPagination: number;
}

export const DEFAULT_LIMITS: CrawlLimits = {
  maxDepth: Number(process.env.CRAWL_MAX_DEPTH ?? 6),
  hostBudget: Number(process.env.HOST_BUDGET ?? 400),
  maxUrlLength: 400,
  maxQueryParams: 4,
  maxPagination: 25,
};

const ARTIFACT_EXT = /\.(csv|tsv|json|jsonl|geojson|xml|rdf|ttl|parquet|xlsx?|ods|pdf|docx?|odt|pptx?|zip|tar|tgz|gz|jpe?g|png|tiff?|gif|webp|svg|mp3|wav|flac|ogg|m4a|mp4|webm|mkv|mov|eml|md|txt|cff|ya?ml|xsd)(?:$|\?)/i;
const NEVER = /\.(exe|msi|dmg|iso|apk|bin|deb|rpm|woff2?|ttf|eot|css|js|mjs|map|ico)(?:$|\?)/i;
const NEVER_PATH = /\/(?:login|signin|sign-in|logout|register|signup|cart|checkout|account|wp-admin|share|print)(?:\/|$|\?)|\/(?:cgi-bin)\//i;

/** Supporting-material detectors: what the link is for, by URL + anchor text + rel. */
const SUPPORT: Array<{ purpose: string; relation: string; re: RegExp; rel?: RegExp }> = [
  { purpose: "schema", relation: "references", re: /schema|\.xsd\b|datapackage\.json|data[- _]?dictionary|data[- _]model|field[- _]definitions|openapi|swagger|json-?ld context/i, rel: /describedby/ },
  { purpose: "rights", relation: "licensed_under", re: /\blicen[cs]e|copyright|terms[- _]of[- _]use|rights|creativecommons\.org|opensource\.org\/licenses/i, rel: /license/ },
  { purpose: "methodology", relation: "references", re: /methodolog|methods?\b|codebook|technical[- _]notes?|user[- _]guide|documentation|protocol|sampling|survey[- _]design|readme/i },
  { purpose: "revision", relation: "references", re: /changelog|change[- _]log|release[- _]notes|revision|version[- _]history|errat(a|um)|history\b|what'?s[- _]new/i, rel: /version-history|predecessor-version|latest-version/ },
  { purpose: "provenance", relation: "published_by", re: /\babout\b|about[- _]us|who[- _]we[- _]are|our[- _]organi[sz]ation|publisher|contact/i, rel: /author|publisher/ },
  { purpose: "citation", relation: "cites", re: /citation|cite[- _]this|how[- _]to[- _]cite|bibtex|\.bib\b|ris\b/i, rel: /cite-as/ },
  { purpose: "privacy", relation: "references", re: /privacy|data[- _]protection|retention|gdpr|cookie[- _]policy/i, rel: /privacy-policy/ },
  { purpose: "accessibility", relation: "references", re: /accessibility[- _]statement|\baccessibility\b|vpat/i },
  { purpose: "model_card", relation: "references", re: /model[- _]card|dataset[- _]card|readme\.md$/i },
];

export function trapReason(url: string, limits: CrawlLimits): string | null {
  if (url.length > limits.maxUrlLength) return "url_too_long";
  const u = new URL(url);
  if ([...u.searchParams.keys()].length > limits.maxQueryParams) return "too_many_query_params";
  const segs = u.pathname.split("/").filter(Boolean);
  const counts = new Map<string, number>();
  for (const s of segs) counts.set(s, (counts.get(s) ?? 0) + 1);
  if ([...counts.values()].some((c) => c >= 3)) return "repeating_path_segments";
  if (segs.length > 12) return "path_too_deep";
  for (const k of ["page", "p", "pg", "start", "offset"]) {
    const v = Number(u.searchParams.get(k));
    if (Number.isFinite(v) && v > (k === "offset" || k === "start" ? limits.maxPagination * 50 : limits.maxPagination)) return "pagination_limit";
  }
  const pageSeg = u.pathname.match(/\/page\/(\d+)/i);
  if (pageSeg && Number(pageSeg[1]) > limits.maxPagination) return "pagination_limit";
  if (/\/\d{4}\/\d{1,2}\/\d{1,2}\/\d{1,2}\//.test(u.pathname) || [...u.searchParams.keys()].some((k) => /^(date|day|month|year|cal|calendar|week)$/i.test(k))) return "calendar_trap";
  if (/[?&](sort|order|orderby|filter|view|display)=/i.test(u.search) && segs.length > 2) return "faceted_navigation";
  return null;
}

/** Decide whether and why to follow a reference found while inspecting a resource. */
export function classifyReference(
  ref: Reference,
  parent: { id: number; url: string; depth: number; kind: string; purpose: string },
  limits: CrawlLimits,
  hostLoad: (host: string) => number,
  urlPolicy: (url: string) => { ok: boolean; reason?: string } = checkUrl,
): FrontierItem | { rejected: string; url: string } | null {
  const url = canonicalizeUrl(ref.url);
  if (!url || url === parent.url) return null;
  const chk = urlPolicy(url);
  if (!chk.ok) return { rejected: chk.reason ?? "egress_policy", url };
  if (NEVER.test(url) || NEVER_PATH.test(new URL(url).pathname)) return { rejected: "low_value_or_action_url", url };
  const trap = trapReason(url, limits);
  if (trap) return { rejected: trap, url };

  const host = new URL(url).hostname;
  const sameHost = host === new URL(parent.url).hostname;
  const haystack = `${url} ${ref.text}`;
  const support = SUPPORT.find((s) => (s.rel && s.rel.test(ref.rel)) || s.re.test(haystack));
  const isArtifact = ARTIFACT_EXT.test(url) || ["img", "video", "audio", "source", "track", "embed", "object"].includes(ref.tag) || /^json:(contentUrl|downloadURL|url|path|download_url|accessURL)/i.test(ref.tag) || (ref.tag === "listing" && !url.endsWith("/") && ref.type !== "listing");
  const isFeed = ref.tag === "sitemap" || ref.tag === "feed" || ref.tag === "listing" || /rss|atom|sitemap/i.test(ref.type ?? "");

  let purpose: Purpose;
  let relation: string;
  let priority: number;
  if (support && ref.region !== "nav") {
    purpose = `supporting:${support.purpose}`;
    relation = support.relation;
    priority = 72;
  } else if (isArtifact) {
    purpose = "artifact";
    relation = ref.tag === "img" || ref.tag === "video" || ref.tag === "audio" || ref.tag === "track" ? "has_part" : "references";
    priority = 68;
  } else if (isFeed) {
    purpose = "discovery";
    relation = "references";
    priority = 55;
  } else {
    purpose = "discovery";
    relation = "references";
    priority = ref.region === "main" ? 45 : ref.region === "body" ? 38 : ref.region === "footer" ? 18 : 25;
  }
  // Site-wide links (header/nav/footer) describe the site, not this resource.
  const scope = ["footer", "nav", "header"].includes(ref.region) ? "site" : "resource";

  const load = hostLoad(host);
  if (load >= limits.hostBudget) return { rejected: "host_budget_exhausted", url };
  // Novelty & diversity: new hosts get a boost, busy hosts a penalty.
  priority += load === 0 ? 10 : -Math.min(20, load / 20);
  if (!sameHost && purpose === "discovery") priority += 4; // source diversity
  // Expected metadata yield.
  if (/dataset|data\/|catalog|download|api|record|item|collection/i.test(url)) priority += 5;
  if (/\.(csv|json|xml|pdf|zip|jpe?g|tiff?|mp4|mp3|docx)(?:$|\?)/i.test(url)) priority += 6;
  // Cost: depth and query complexity.
  const depth = parent.depth + 1;
  priority -= depth * 3 + (new URL(url).search ? 4 : 0);
  // Supporting material may go one level deeper than discovery.
  if (depth > limits.maxDepth + (purpose.startsWith("supporting") || purpose === "artifact" ? 1 : 0)) return { rejected: "max_depth", url };
  // Only follow artifacts/supporting refs from non-HTML parents (e.g. PDFs citing URLs) to avoid drift.
  if (parent.kind !== "webpage" && parent.kind !== "feed" && parent.kind !== "xml" && parent.kind !== "json" && purpose === "discovery") priority -= 15;

  return { url, priority: Math.round(priority * 10) / 10, depth, via: ref.tag === "sitemap" ? "sitemap" : ref.tag === "feed" ? "feed" : ref.tag === "listing" ? "storage_listing" : `reference:${ref.tag}`, purpose, parentId: parent.id, relation, anchor: ref.text || null, scope };
}

/** All references an inspected resource exposes, normalised into one list. */
export function collectReferences(record: ResourceRecord, shared: Map<string, unknown>): Reference[] {
  const refs: Reference[] = [...((shared.get("references") as Reference[] | undefined) ?? [])];
  for (const r of record.relationships) {
    if (!/^https?:/.test(r.target)) continue;
    const tag = r.type === "feed" ? "feed" : r.type === "alternate_format" ? "json:contentUrl" : "jsonld";
    refs.push({ url: r.target, text: r.evidence, rel: r.type === "licensed_under" ? "license" : r.type === "authored_by" ? "author" : r.type === "published_by" ? "publisher" : "", region: "main", tag, type: null });
  }
  return refs;
}
