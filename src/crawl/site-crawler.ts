import { analyzeResponse, robotsAllows } from "../metadata/pipeline.js";
import { C } from "../metadata/categories.js";
import { safeFetch, type SafeResponse } from "../net/safe-fetch.js";
import { checkUrl } from "../net/ip-guard.js";
import { mapLimit } from "../util/async.js";

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  includeSitemap?: boolean;
  concurrency?: number;
  /** Minimum ms between requests to the host (raised to robots Crawl-delay). */
  minDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable fetcher (tests use a local server). */
  fetcher?: (url: string) => Promise<SafeResponse>;
  robots?: (url: string) => Promise<{ allowed: boolean | null; crawlDelay: number | null; sitemaps: string[] }>;
}

export interface CrawlPageEvent {
  type: "page";
  url: string;
  finalUrl: string;
  depth: number;
  status: number;
  kind: string;
  title: string | null;
  description: string | null;
  categoriesFound: number[];
  fieldCount: number;
  completeness: number;
  contentHash: string;
  duplicateOf: string | null;
  canonicalUrl: string;
  linksQueued: number;
  ms: number;
  highlights: Record<string, unknown>;
}

export type CrawlEvent =
  | { type: "start"; seed: string; maxPages: number; maxDepth: number; crawlDelayMs: number; robotsAllowed: boolean | null }
  | CrawlPageEvent
  | { type: "skip"; url: string; reason: string }
  | { type: "error"; url: string; error: string }
  | { type: "done"; pages: number; skipped: number; errors: number; duplicates: number; ms: number; stoppedBy: "limit" | "frontier_exhausted" | "cancelled" };

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_eid|mc_cid|ref|ref_src|igshid|_hsenc|_hsmi)$/i;
const SKIP_EXT = /\.(?:jpe?g|png|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|eot|mp4|mp3|webm|zip|gz|tgz|dmg|exe|iso|bin)(?:$|\?)/i;

/** Canonicalise for frontier dedupe: lowercase host, drop fragment/tracking params, sort query, trim trailing slash. */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    u.search = params.length ? `?${new URLSearchParams(params)}` : "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

function sameSite(a: string, b: string): boolean {
  const ha = new URL(a).hostname.replace(/^www\./, "");
  const hb = new URL(b).hostname.replace(/^www\./, "");
  return ha === hb;
}

async function sitemapUrls(origin: string, declared: string[], fetcher: (u: string) => Promise<SafeResponse>, cap: number): Promise<string[]> {
  const queue = declared.length ? declared.slice(0, 5) : [`${origin}/sitemap.xml`];
  const out: string[] = [];
  const seen = new Set<string>();
  while (queue.length && out.length < cap && seen.size < 10) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await fetcher(sm).catch(() => null);
    if (!res || res.status !== 200) continue;
    const xml = res.body.toString("utf8");
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs.slice(0, 5));
    else out.push(...locs);
  }
  return out.slice(0, cap);
}

/**
 * Breadth-first, same-site crawl that streams one metadata summary per page.
 * Nothing is persisted: frontier and dedupe state live for the duration of the request.
 */
export async function* crawlSite(seed: string, opts: CrawlOptions = {}): AsyncGenerator<CrawlEvent> {
  const started = Date.now();
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 20, Number(process.env.CRAWL_MAX_PAGES ?? 100)));
  const maxDepth = Math.max(0, Math.min(opts.maxDepth ?? 2, 5));
  const fetcher = opts.fetcher ?? ((u: string) => safeFetch(u, { maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000, signal: opts.signal }));
  const robots = opts.robots ?? robotsAllows;
  const start = canonicalizeUrl(seed);
  if (!start) {
    yield { type: "error", url: seed, error: "invalid seed URL" };
    return;
  }
  if (!opts.fetcher) {
    const chk = checkUrl(start);
    if (!chk.ok) {
      yield { type: "error", url: seed, error: `EGRESS_BLOCKED: ${chk.reason}` };
      return;
    }
  }
  const r0 = await robots(start).catch(() => ({ allowed: null, crawlDelay: null, sitemaps: [] as string[] }));
  const crawlDelayMs = Math.max(opts.minDelayMs ?? 1000, (r0.crawlDelay ?? 0) * 1000);
  yield { type: "start", seed: start, maxPages, maxDepth, crawlDelayMs, robotsAllowed: r0.allowed };

  const seen = new Set<string>([start]);
  const hashes = new Map<string, string>();
  let frontier: Array<{ url: string; depth: number }> = [{ url: start, depth: 0 }];
  if (opts.includeSitemap !== false) {
    for (const u of await sitemapUrls(new URL(start).origin, r0.sitemaps, fetcher, maxPages * 3)) {
      const c = canonicalizeUrl(u);
      if (c && !seen.has(c) && sameSite(c, start)) {
        seen.add(c);
        frontier.push({ url: c, depth: 1 });
      }
    }
  }

  let pages = 0;
  let skipped = 0;
  let errors = 0;
  let duplicates = 0;
  let lastRequest = 0;
  const politeness = async () => {
    // Serialise request starts on the host to honour crawl-delay even with concurrency > 1.
    const wait = lastRequest + crawlDelayMs - Date.now();
    lastRequest = Math.max(Date.now(), lastRequest + crawlDelayMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  while (frontier.length && pages < maxPages) {
    if (opts.signal?.aborted) break;
    const batch = frontier.splice(0, Math.min(opts.concurrency ?? 2, maxPages - pages));
    const results = await mapLimit(batch, opts.concurrency ?? 2, async (item): Promise<CrawlEvent[]> => {
      const t0 = Date.now();
      if (SKIP_EXT.test(item.url)) return [{ type: "skip", url: item.url, reason: "non-document asset" }];
      const rb = await robots(item.url).catch(() => ({ allowed: null }));
      if (rb.allowed === false) return [{ type: "skip", url: item.url, reason: "robots.txt disallow" }];
      await politeness();
      if (opts.signal?.aborted) return [];
      let res: SafeResponse;
      try {
        res = await fetcher(item.url);
      } catch (err) {
        return [{ type: "error", url: item.url, error: (err as Error).message.slice(0, 200) }];
      }
      if (!sameSite(res.finalUrl, start)) return [{ type: "skip", url: item.url, reason: `redirected off-site to ${new URL(res.finalUrl).hostname}` }];
      let links: string[] = [];
      const record = await analyzeResponse(res, { sourceType: "url", enrich: false, onShared: (sh) => (links = (sh.get("internalLinks") as string[] | undefined) ?? []) });
      const dupOf = hashes.get(record.contentHash!) ?? null;
      if (!dupOf) hashes.set(record.contentHash!, item.url);
      const queued: string[] = [];
      if (item.depth < maxDepth && record.kind === "webpage" && res.status < 400) {
        const nofollow = record.fields.some((f) => f.category === C.discovery && f.field === "robotsDirectives" && Array.isArray(f.value) && f.value.includes("nofollow"));
        if (!nofollow) {
          for (const rel of record.relationships) if (["next", "has_part"].includes(rel.type)) queued.push(rel.target);
          queued.push(...links.slice(0, 500));
        }
      }
      const get = (cat: number, field: string) => record.fields.find((f) => f.category === cat && f.field === field)?.value;
      return [{
        type: "page",
        url: item.url,
        finalUrl: res.finalUrl,
        depth: item.depth,
        status: res.status,
        kind: record.kind,
        title: record.title,
        description: record.description,
        categoriesFound: record.categories.filter((c) => c.state === "observed").map((c) => c.id),
        fieldCount: record.fields.length,
        completeness: record.quality.completeness,
        contentHash: record.contentHash!,
        duplicateOf: dupOf,
        canonicalUrl: record.canonicalUrl,
        linksQueued: queued.length,
        ms: Date.now() - t0,
        highlights: {
          language: get(C.descriptive, "language") ?? null,
          published: get(C.temporal, "published") ?? null,
          modified: get(C.temporal, "modified") ?? get(C.temporal, "lastModifiedHeader") ?? null,
          license: get(C.rights, "license") ?? null,
          structuredData: get(C.semantic, "types") ?? [],
          altCoverage: get(C.accessibility, "altCoverage") ?? null,
          wordCount: get(C.structural, "wordCount") ?? null,
        },
        _queue: queued.map((u) => ({ url: u, depth: item.depth + 1 })),
      } as CrawlPageEvent & { _queue: Array<{ url: string; depth: number }> }];
    });
    for (const evs of results) {
      for (const ev of evs) {
        if (ev.type === "page") {
          const q = (ev as CrawlPageEvent & { _queue?: Array<{ url: string; depth: number }> })._queue ?? [];
          delete (ev as { _queue?: unknown })._queue;
          let added = 0;
          for (const { url, depth } of q) {
            const c = canonicalizeUrl(url);
            if (!c || seen.has(c) || !sameSite(c, start) || SKIP_EXT.test(c)) continue;
            seen.add(c);
            frontier.push({ url: c, depth });
            added++;
          }
          ev.linksQueued = added;
          pages++;
          if (ev.duplicateOf) duplicates++;
        } else if (ev.type === "skip") skipped++;
        else if (ev.type === "error") errors++;
        yield ev;
      }
    }
    // Shallow pages first (BFS) keeps important/hub pages ahead of deep ones.
    frontier = frontier.sort((a, b) => a.depth - b.depth);
  }
  yield {
    type: "done",
    pages,
    skipped,
    errors,
    duplicates,
    ms: Date.now() - started,
    stoppedBy: opts.signal?.aborted ? "cancelled" : pages >= maxPages ? "limit" : "frontier_exhausted",
  };
}
