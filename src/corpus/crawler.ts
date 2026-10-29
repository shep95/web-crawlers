import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import pino from "pino";
import { analyzeResponse, coverage, robotsAllows } from "../metadata/pipeline.js";
import { C, CATEGORY_BY_ID, CATEGORY_EXTENSIONS, categoryApplies } from "../metadata/categories.js";
import type { MetadataField, ResourceKind, ResourceRecord } from "../metadata/types.js";
import { safeFetch, type SafeResponse, FetchBlockedError } from "../net/safe-fetch.js";
import { checkUrl } from "../net/ip-guard.js";
import { collectReferences, classifyReference, DEFAULT_LIMITS, type CrawlLimits, type Reference } from "./discovery.js";
import { allSources, type DiscoverySource } from "./bootstrap.js";
import { SYSTEM_RETENTION, type Corpus, type CrawlerProfile, type FrontierItem, type ResourceRow } from "./types.js";
import { learnedAdjustment, patternKey } from "./patterns.js";
import type { NestedEntry } from "../metadata/extractors/archive.js";

const log = pino({ name: "crawler" });

export interface Renderer {
  /** Render a JS-dependent page; returns rendered HTML or null when unavailable. */
  render(url: string): Promise<string | null>;
}

export interface CrawlerDeps {
  store: Corpus;
  /** Retrieval function (defaults to SSRF-safe fetch). Receives conditional headers for revisits. */
  fetch?: (url: string, headers: Record<string, string>) => Promise<SafeResponse>;
  robots?: (url: string) => Promise<{ allowed: boolean | null; crawlDelay: number | null; sitemaps: string[] }>;
  sources?: DiscoverySource[];
  limits?: Partial<CrawlLimits>;
  concurrency?: number;
  hostDelayMs?: number;
  enrich?: boolean;
  tickMs?: number;
  now?: () => number;
  urlPolicy?: (url: string) => { ok: boolean; reason?: string };
  /** Specialised role of this crawler instance. */
  profile?: CrawlerProfile;
  /** Optional selective JS renderer (Playwright) for pages that need it. */
  renderer?: Renderer | null;
  /** Name shown in events/status, e.g. "datasets-1". */
  name?: string;
}

/** Fields compared between snapshots to report meaningful version changes (category 11). */
const TRACKED = [
  [C.descriptive, "title"], [C.descriptive, "description"], [C.descriptive, "author"], [C.web_seo, "canonical"],
  [C.temporal, "published"], [C.temporal, "modified"], [C.rights, "license"], [C.version, "version"], [C.version, "etag"],
  [C.identifiers, "doi"], [C.schema, "columns"], [C.schema, "properties"], [C.structural, "rowCount"], [C.structural, "pageCount"],
  [C.document, "pageCount"], [C.structural, "headingOutline"], [C.semantic, "types"],
] as const;

const DAY = 86400_000;
const GAP_PURSUIT_PER_RESOURCE = 4;

/** Heuristic: HTML whose visible text is tiny and has no structured data likely needs rendering. */
export function looksJsDependent(record: ResourceRecord, text: string): boolean {
  if (record.kind !== "webpage" || (record.httpStatus ?? 200) >= 400) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  const hasLd = record.fields.some((f) => f.category === C.semantic && f.field === "types");
  return words < 40 && !hasLd;
}

export class AutonomousCrawler extends EventEmitter {
  private store: Corpus;
  private deps: Required<Omit<CrawlerDeps, "limits" | "store" | "renderer">> & { limits: CrawlLimits; renderer: Renderer | null };
  private running = false;
  private stopping = false;
  private inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<unknown> | null = null;
  private lastBootstrapCheck = 0;
  readonly id: string;
  processed = 0;
  startedAt: number | null = null;

  constructor(deps: CrawlerDeps) {
    super();
    this.store = deps.store;
    const profile = deps.profile ?? ((process.env.CRAWLER_PROFILE as CrawlerProfile) || "generalist");
    this.deps = {
      fetch: deps.fetch ?? ((url, headers) => safeFetch(url, { headers, maxBytes: Number(process.env.CRAWL_MAX_BYTES ?? 20 * 1024 * 1024), timeoutMs: 30_000 })),
      robots: deps.robots ?? robotsAllows,
      sources: deps.sources ?? allSources(),
      limits: { ...DEFAULT_LIMITS, ...deps.limits },
      concurrency: deps.concurrency ?? Number(process.env.CRAWL_CONCURRENCY ?? 4),
      hostDelayMs: deps.hostDelayMs ?? Number(process.env.HOST_DELAY_MS ?? 2000),
      enrich: deps.enrich ?? process.env.CRAWL_ENRICH !== "off",
      tickMs: deps.tickMs ?? 500,
      now: deps.now ?? Date.now,
      urlPolicy: deps.urlPolicy ?? checkUrl,
      profile,
      renderer: deps.renderer ?? null,
      name: deps.name ?? `${profile}-${randomBytes(3).toString("hex")}`,
    };
    this.id = this.deps.name;
  }

  get profile(): CrawlerProfile {
    return this.deps.profile;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.startedAt = this.deps.now();
    const loop = () => {
      if (!this.running) return;
      this.ticking = this.tick().catch((err) => log.error({ err }, "tick_failed")).finally(() => {
        if (this.running) this.timer = setTimeout(loop, this.deps.tickMs);
      });
    };
    // Reclaim abandoned leases before the first lease of this process.
    this.ticking = this.store
      .recoverOnStartup(this.deps.now())
      .then(() => this.store.event(null, "crawler_started", `${this.id} profile=${this.deps.profile} concurrency=${this.deps.concurrency}`))
      .catch((err) => log.error({ err }, "startup_recovery_failed"))
      .finally(loop);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.ticking;
    await Promise.allSettled([...this.inFlight]);
    await this.store.event(null, "crawler_stopped", this.id).catch(() => undefined);
  }

  /** One scheduling step: refresh due discovery sources, then lease and process due resources. */
  async tick(): Promise<number> {
    const now = this.deps.now();
    if (now - this.lastBootstrapCheck > 60_000 || (await this.store.frontierSize()) === 0) {
      this.lastBootstrapCheck = now;
      await this.store.recoverLeases(now);
      if (this.deps.profile !== "refresh") await this.runDueSources(now);
    }
    const free = this.deps.concurrency - this.inFlight.size;
    if (free <= 0 || this.stopping) return 0;
    const batch = await this.store.lease(free, 5 * 60_000, now, this.deps.profile);
    for (const r of batch) {
      const p = this.process(r).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return batch.length;
  }

  /** Process until nothing is due (tests / one-shot runs). */
  async drain(maxResources = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxResources * 4 && total < maxResources; i++) {
      const n = await this.tick();
      await Promise.allSettled([...this.inFlight]);
      total += n;
      if (n === 0 && this.inFlight.size === 0) {
        if (!(await this.store.dueCount(this.deps.now()))) break;
        await new Promise((r) => setTimeout(r, Math.min(this.deps.hostDelayMs, 50)));
      }
    }
    return total;
  }

  async runDueSources(now = this.deps.now(), force = false): Promise<number> {
    let added = 0;
    for (const src of this.deps.sources) {
      // Atomic claim: with many replicas, exactly one runs each source per interval.
      if (!(await this.store.claimSource(src.id, force ? 0 : src.intervalMs, now))) continue;
      try {
        const items = await src.run();
        const n = await this.store.enqueue(items, now);
        added += n;
        await this.store.recordSourceRun(src.id, n, null, now);
        await this.store.event(null, "bootstrap_source", `${src.id}: ${items.length} references, ${n} new`);
      } catch (err) {
        await this.store.recordSourceRun(src.id, 0, (err as Error).message.slice(0, 200), now);
        await this.store.event(null, "bootstrap_source_failed", `${src.id}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    return added;
  }

  // ---------------------------------------------------------------- per-resource processing

  private async process(row: ResourceRow): Promise<void> {
    const store = this.store;
    const now = this.deps.now();
    const t0 = Date.now();
    const revisit = row.snapshot_count > 0;
    const pattern = patternKey(row.url.split("#")[0]);
    try {
      const rb = await this.deps.robots(row.url).catch((err) => {
        if (err instanceof FetchBlockedError) throw err;
        return { allowed: null, crawlDelay: null, sitemaps: [] as string[] };
      });
      if (rb.allowed === false) {
        await store.finish(row.id, "skipped", now + 30 * DAY, { last_error: "robots.txt disallow" });
        await store.event(row.id, "robots_disallowed");
        return;
      }
      const delay = Math.max(this.deps.hostDelayMs, (rb.crawlDelay ?? 0) * 1000);
      await store.touchHost(row.host, delay, now);
      if (!revisit && rb.sitemaps.length && (await store.hostStats(row.host)).pages === 0) {
        await store.enqueue(rb.sitemaps.slice(0, 3).map((s) => ({ url: s, priority: 50, depth: row.depth + 1, via: "robots_sitemap", purpose: "discovery" as const, parentId: row.id, relation: "sitemap", scope: "site" })), now);
      }

      // ---------------- path 1: evidence & metadata processing
      const conditional: Record<string, string> = {};
      if (row.etag) conditional["if-none-match"] = row.etag;
      if (row.last_modified) conditional["if-modified-since"] = row.last_modified;
      await store.event(row.id, revisit ? "revisit" : "retrieve", `${this.id}: ${row.url}`);
      let res = await this.deps.fetch(row.url, conditional);
      await store.setStage(row.id, { retrieved_at: new Date(this.deps.now()).toISOString(), http_status: res.status, final_url: res.finalUrl });
      await store.event(row.id, "retrieved", `HTTP ${res.status}, ${res.body.length} bytes${res.redirects.length ? `, ${res.redirects.length} redirect(s)` : ""}`);

      if (res.status === 304) {
        await store.hostResult(row.host, true, 304, now);
        const unchanged = row.unchanged_count + 1;
        await store.finish(row.id, "indexed", now + this.revisitInterval(row.change_count, unchanged), { unchanged_count: unchanged });
        await store.event(row.id, "not_modified", "conditional request: unchanged since last snapshot");
        return;
      }
      if (new URL(res.finalUrl).origin !== new URL(row.url.split("#")[0]).origin) {
        const rb2 = await this.deps.robots(res.finalUrl).catch(() => ({ allowed: null }));
        if (rb2.allowed === false) {
          await store.finish(row.id, "skipped", now + 30 * DAY, { last_error: `robots.txt disallows redirect target ${res.finalUrl}` });
          return;
        }
      }

      let shared = new Map<string, unknown>();
      let record = await analyzeResponse(res, { sourceType: "url", enrich: this.deps.enrich && !revisit, onShared: (s) => (shared = s) });
      // Selective rendering: only when the delivered HTML is an empty app shell.
      if (this.deps.renderer && looksJsDependent(record, String(shared.get("plainText") ?? ""))) {
        const html = await this.deps.renderer.render(res.finalUrl).catch(() => null);
        if (html) {
          res = { ...res, body: Buffer.from(html, "utf8"), headers: { ...res.headers, "content-type": "text/html; charset=utf-8" } };
          delete res.headers["content-encoding"];
          record = await analyzeResponse(res, { sourceType: "url", enrich: false, onShared: (s) => (shared = s) });
          record.fields.push(crawlerField(record, C.technical, "renderedWithBrowser", true, "selective headless rendering", "delivered HTML had almost no text and no structured data; rendered once"));
          await store.event(row.id, "rendered", "JS-dependent page rendered with headless Chromium");
        }
      }
      await store.setStage(row.id, { inspected_at: new Date(this.deps.now()).toISOString(), kind: record.kind });
      await store.event(row.id, "inspected", `format ${record.kind} (${record.mimeType ?? "unknown"}), extractors: ${record.processing.extractors.map((e) => e.id.split("@")[0]).join(",")}`);
      await store.recordExtractorRuns(record.processing.extractors);

      const unavailable = res.status >= 400;
      await store.hostResult(row.host, !unavailable || res.status === 404 || res.status === 410, res.status, now);

      const prev = await store.latestSnapshot(row.id);
      let changedFields: string[] | null = null;
      if (prev && prev.content_hash !== record.contentHash) changedFields = diffFields(await store.observationsFor(prev.id), record.fields);
      const dupOf = record.contentHash ? await store.linkDuplicates(row.id, record.contentHash) : null;

      await addCrawlerObservations(record, row, { revisit, changedFields, prevFetchedAt: prev?.fetched_at ?? null, dupOf, store, crawlerId: this.id, pattern });
      record.categories = coverage(record.fields, record.kind, record.processing.extractors, record.httpStatus);
      await store.setStage(row.id, { extracted_at: new Date(this.deps.now()).toISOString(), field_count: record.fields.length, extractor_errors: record.quality.extractorErrors.length });

      const text = String(shared.get("plainText") ?? (["text", "csv", "json", "xml", "feed"].includes(record.kind) ? res.body.toString("utf8") : ""));
      const ocr = shared.get("ocrText");
      const index = !unavailable && !dupOf;
      await store.saveSnapshot(row.id, record, { text: ocr ? `${text}\n${ocr}` : text, changedFields, index });
      const changed = Boolean(prev && changedFields);
      await store.finish(row.id, unavailable ? "unavailable" : "indexed", now + (unavailable ? 7 * DAY : this.revisitInterval(row.change_count + (changed ? 1 : 0), changed ? 0 : row.unchanged_count + (prev ? 1 : 0))), {
        indexed_at: index ? new Date(this.deps.now()).toISOString() : null,
        title: record.title,
        description: record.description,
        content_hash: record.contentHash,
        etag: res.headers.etag ?? null,
        last_modified: res.headers["last-modified"] ?? null,
        change_count: row.change_count + (changed ? 1 : 0),
        unchanged_count: changed ? 0 : row.unchanged_count + (prev && !changedFields ? 1 : 0),
        duplicate_of: dupOf,
        last_error: unavailable ? `HTTP ${res.status}` : null,
      });
      const observedCats = record.categories.filter((c) => c.state === "observed").length;
      await store.recordPattern(pattern, row.host, { indexed: index, failed: unavailable, fields: record.fields.length, categories: observedCats, ms: Date.now() - t0 });
      if (dupOf) await store.event(row.id, "duplicate", `identical bytes to resource #${dupOf}; not indexed separately`);
      if (changed) await store.event(row.id, "changed", `fields changed: ${changedFields!.join(", ") || "(content bytes only)"}`);
      await store.event(row.id, index ? "indexed" : "not_indexed", `${record.fields.length} observations, ${observedCats}/41 categories observed`);

      const nested = shared.get("archiveEntries") as NestedEntry[] | undefined;
      if (nested?.length && !unavailable) await this.processArchiveEntries(row, res, nested);

      // ---------------- path 2: discovery processing
      if (!unavailable && !dupOf) await this.discover(row, record, shared, now);
      this.processed++;
      this.emit("processed", { id: row.id, url: row.url, state: index ? "indexed" : unavailable ? "unavailable" : "duplicate" });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      const blocked = err instanceof FetchBlockedError || /EGRESS_BLOCKED/.test(msg);
      await store.hostResult(row.host, false, null, now).catch(() => undefined);
      await store.recordPattern(pattern, row.host, { indexed: false, failed: true, fields: 0, categories: 0, ms: Date.now() - t0 }).catch(() => undefined);
      const retry = !blocked && row.attempts < 3;
      await store.finish(row.id, retry ? "queued" : blocked ? "skipped" : "failed", now + (retry ? 15 * 60_000 * row.attempts : 30 * DAY), { last_error: msg }).catch(() => undefined);
      await store.event(row.id, retry ? "retrieve_failed_retrying" : "failed", msg).catch(() => undefined);
    }
  }

  private async processArchiveEntries(parent: ResourceRow, res: SafeResponse, entries: NestedEntry[]): Promise<void> {
    for (const e of entries) {
      const url = `${res.finalUrl}#entry=${encodeURIComponent(e.name)}`;
      await this.store.enqueue([{ url, priority: 0, depth: parent.depth + 1, via: "archive_entry", purpose: "contained", parentId: parent.id, relation: "has_part", scope: "resource" }]);
      const child = (await this.store.byUrl(url))!;
      const virtual: SafeResponse = { ...res, requestedUrl: url, finalUrl: url, headers: {}, body: e.body, truncated: false, redirects: [], encodedBytes: e.body.length };
      let shared = new Map<string, unknown>();
      const rec = await analyzeResponse(virtual, { sourceType: "url", enrich: false, filename: e.name, onShared: (s) => (shared = s) });
      const iso = new Date(this.deps.now()).toISOString();
      await this.store.saveSnapshot(child.id, rec, { text: String(shared.get("plainText") ?? (["csv", "json", "text", "xml"].includes(rec.kind) ? e.body.toString("utf8") : "")), index: true });
      // setStage (not finish): finishing would release the host lease the parent still holds.
      await this.store.setStage(child.id, { state: "indexed", due_at: Number.MAX_SAFE_INTEGER, lease_until: null, retrieved_at: iso, inspected_at: iso, extracted_at: iso, indexed_at: iso, kind: rec.kind, title: rec.title ?? e.name, content_hash: rec.contentHash, field_count: rec.fields.length });
      await this.store.event(child.id, "indexed", `archive entry of #${parent.id} (${e.size} bytes)`);
    }
  }

  private async discover(row: ResourceRow, record: ResourceRecord, shared: Map<string, unknown>, now: number): Promise<void> {
    const refs: Reference[] = collectReferences(record, shared);
    const items: FrontierItem[] = [];
    const rejected = new Map<string, number>();
    const load = new Map<string, number>();
    const hostsSeen = [...new Set(refs.map((r) => { try { return new URL(r.url).hostname; } catch { return ""; } }).filter(Boolean))].slice(0, 200);
    for (const h of hostsSeen) load.set(h, (await this.store.hostStats(h)).enqueued);
    const hostLoad = (h: string) => load.get(h) ?? 0;
    for (const ref of refs) {
      const c = classifyReference(ref, { id: row.id, url: row.url, depth: row.depth, kind: record.kind, purpose: row.purpose }, this.deps.limits, hostLoad, this.deps.urlPolicy);
      if (!c) continue;
      if ("rejected" in c) {
        rejected.set(c.rejected, (rejected.get(c.rejected) ?? 0) + 1);
        continue;
      }
      items.push(c);
      const h = new URL(c.url).hostname;
      load.set(h, hostLoad(h) + 1);
      if (items.length >= 300) break;
    }

    // Learned yield model: adjust priorities by what has been learned about each URL pattern.
    const stats = await this.store.patternStats(items.map((i) => patternKey(i.url)));
    for (const it of items) it.priority = Math.round((it.priority + learnedAdjustment(stats.get(patternKey(it.url))).delta) * 10) / 10;

    // Gap pursuit: applicable categories still missing → boost references likely to supply them (bounded).
    const gaps = record.categories.filter((c) => c.state === "not_found_after_inspection" && categoryApplies(c.id, record.kind as ResourceKind)).map((c) => c.id);
    const pursued: string[] = [];
    for (const cat of gaps) {
      if (pursued.length >= GAP_PURSUIT_PER_RESOURCE) break;
      const rule = CATEGORY_EXTENSIONS[cat]?.supportingDiscovery;
      if (!rule) continue;
      const it = items.find((i) => !i.purpose.startsWith("supporting:gap") && rule.test(`${i.url} ${i.anchor ?? ""}`));
      if (!it) continue;
      it.priority += 15;
      if (it.purpose === "discovery") it.purpose = `supporting:gap_${CATEGORY_BY_ID.get(cat)!.key}`;
      pursued.push(`${CATEGORY_BY_ID.get(cat)!.key}→${it.url}`);
    }

    const added = await this.store.enqueue(items, now);
    const purposes = items.reduce<Record<string, number>>((a, i) => ((a[i.purpose] = (a[i.purpose] ?? 0) + 1), a), {});
    await this.store.event(row.id, "discovered", `${refs.length} references → ${added} new frontier entries ${JSON.stringify(purposes)}${rejected.size ? `; rejected ${JSON.stringify(Object.fromEntries(rejected))}` : ""}`);
    if (pursued.length) await this.store.event(row.id, "gap_pursuit", `missing categories pursued via: ${pursued.join("; ")}`);
  }

  /** Adaptive revisit: frequently changing resources are revisited sooner (1 day … 60 days). */
  private revisitInterval(changes: number, unchangedStreak: number): number {
    const base = changes > 2 ? 1 : 7;
    return Math.min(60, base * 2 ** Math.min(unchangedStreak, 4)) * DAY;
  }
}

function diffFields(before: MetadataField[], after: MetadataField[]): string[] {
  const pick = (fs: MetadataField[], cat: number, field: string) => JSON.stringify(fs.filter((f) => f.category === cat && f.field === field).map((f) => f.value).sort());
  return TRACKED.filter(([cat, field]) => pick(before, cat, field) !== pick(after, cat, field)).map(([cat, field]) => `${cat}.${field}`);
}

function crawlerField(record: ResourceRecord, category: number, field: string, value: unknown, method: string, evidence?: string, evidenceType: MetadataField["evidenceType"] = "system_measurement"): MetadataField {
  return { category, field, value, status: "observed", method, extractor: "crawler@2.0.0", evidence, evidenceType, scope: "resource", sensitivity: "public", observedAt: record.fetchedAt };
}

/** The crawler's own measurements and policies, recorded separately from source claims. */
async function addCrawlerObservations(
  record: ResourceRecord,
  row: ResourceRow,
  o: { revisit: boolean; changedFields: string[] | null; prevFetchedAt: string | null; dupOf: number | null; store: Corpus; crawlerId: string; pattern: string },
) {
  const add = (category: number, field: string, value: unknown, method: string, evidence?: string) => record.fields.push(crawlerField(record, category, field, value, method, evidence));
  const events = await o.store.eventsFor(row.id, 20);
  add(C.audit, "crawlerEvents", events.slice(0, 10).map((e) => ({ ts: e.ts, type: e.type })), "crawler event log", "this system's own retrieval/processing history — not the source's logs");
  add(C.operational, "crawlerState", { crawler: o.crawlerId, discoveredVia: row.via, purpose: row.purpose, depth: row.depth, attempts: row.attempts, discoveredAt: row.discovered_at, previousRetrieval: o.prevFetchedAt, pattern: o.pattern }, "crawler frontier state");
  add(C.retention, "systemRetentionPolicy", SYSTEM_RETENTION, "omnispider retention configuration", "the collecting system's own rules, distinct from any source-declared retention");
  add(C.provenance, "discoveredVia", row.via, "crawler frontier");
  add(C.file_system, "localDownloadTime", record.fetchedAt, "crawler retrieval clock", "property created by this system's download — not a source file property");
  if (o.revisit) add(C.version, "changedSinceLastSnapshot", o.changedFields ? { changed: true, fields: o.changedFields, previousSnapshotAt: o.prevFetchedAt } : { changed: false, previousSnapshotAt: o.prevFetchedAt }, "snapshot comparison (content hash + tracked fields)");
  if (o.dupOf) {
    add(C.integrity, "duplicateOfResource", o.dupOf, "sha256 equality with another resource", "identical bytes; copies are not independent evidence");
    const other = await o.store.get(o.dupOf);
    if (other) record.relationships.push({ type: "same_as", target: other.url, evidence: "identical SHA-256 content hash", method: "crawler duplicate detection", status: "observed" });
  }
}
