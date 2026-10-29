import { EventEmitter } from "node:events";
import pino from "pino";
import { analyzeResponse, coverage, robotsAllows } from "../metadata/pipeline.js";
import { C } from "../metadata/categories.js";
import type { MetadataField, ResourceRecord } from "../metadata/types.js";
import { safeFetch, type SafeResponse, FetchBlockedError } from "../net/safe-fetch.js";
import { checkUrl } from "../net/ip-guard.js";
import { collectReferences, classifyReference, DEFAULT_LIMITS, type CrawlLimits, type Reference } from "./discovery.js";
import { allSources, type DiscoverySource } from "./bootstrap.js";
import { CorpusStore, SYSTEM_RETENTION, type ResourceRow } from "./store.js";
import type { NestedEntry } from "../metadata/extractors/archive.js";

const log = pino({ name: "crawler" });

export interface CrawlerDeps {
  store: CorpusStore;
  /** Retrieval function (defaults to SSRF-safe fetch). Receives conditional headers for revisits. */
  fetch?: (url: string, headers: Record<string, string>) => Promise<SafeResponse>;
  robots?: (url: string) => Promise<{ allowed: boolean | null; crawlDelay: number | null; sitemaps: string[] }>;
  sources?: DiscoverySource[];
  limits?: Partial<CrawlLimits>;
  concurrency?: number;
  /** Minimum ms between requests to one host (raised to robots Crawl-delay). */
  hostDelayMs?: number;
  /** Run network enrichment (DNS/TLS/Wayback/Crossref/registries) on retrieved resources. */
  enrich?: boolean;
  tickMs?: number;
  now?: () => number;
  /** Egress policy for discovered references (defaults to the SSRF guard's static checks). */
  urlPolicy?: (url: string) => { ok: boolean; reason?: string };
}

/** Fields compared between snapshots to report meaningful version changes (category 11). */
const TRACKED = [
  [C.descriptive, "title"], [C.descriptive, "description"], [C.descriptive, "author"], [C.web_seo, "canonical"],
  [C.temporal, "published"], [C.temporal, "modified"], [C.rights, "license"], [C.version, "version"], [C.version, "etag"],
  [C.identifiers, "doi"], [C.schema, "columns"], [C.schema, "properties"], [C.structural, "rowCount"], [C.structural, "pageCount"],
  [C.document, "pageCount"], [C.structural, "headingOutline"], [C.semantic, "types"],
] as const;

const DAY = 86400_000;

export class AutonomousCrawler extends EventEmitter {
  private store: CorpusStore;
  private deps: Required<Omit<CrawlerDeps, "limits" | "store">> & { limits: CrawlLimits };
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastBootstrapCheck = 0;
  private ticking: Promise<unknown> | null = null;
  processed = 0;

  constructor(deps: CrawlerDeps) {
    super();
    this.store = deps.store;
    this.deps = {
      fetch: deps.fetch ?? ((url, headers) => safeFetch(url, { headers, maxBytes: Number(process.env.CRAWL_MAX_BYTES ?? 20 * 1024 * 1024), timeoutMs: 30_000 })),
      robots: deps.robots ?? robotsAllows,
      sources: deps.sources ?? allSources(),
      limits: { ...DEFAULT_LIMITS, ...deps.limits },
      concurrency: deps.concurrency ?? Number(process.env.CRAWL_CONCURRENCY ?? 4),
      hostDelayMs: deps.hostDelayMs ?? Number(process.env.HOST_DELAY_MS ?? 2000),
      enrich: deps.enrich ?? process.env.CRAWL_ENRICH !== "off",
      tickMs: deps.tickMs ?? 500,
      urlPolicy: deps.urlPolicy ?? checkUrl,
      now: deps.now ?? Date.now,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    // Single-writer system: any lease present at startup belongs to a process that died.
    this.store.recoverLeases(Number.MAX_SAFE_INTEGER);
    this.store.event(null, "crawler_started", `concurrency=${this.deps.concurrency}`);
    const loop = () => {
      if (!this.running) return;
      this.ticking = this.tick().catch((err) => log.error({ err }, "tick_failed")).finally(() => {
        if (this.running) this.timer = setTimeout(loop, this.deps.tickMs);
      });
    };
    loop();
  }

  private stopping = false;

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.ticking;
    await Promise.allSettled([...this.inFlight]);
    this.store.event(null, "crawler_stopped");
  }

  /** One scheduling step: refresh due discovery sources, then lease and process due resources. */
  async tick(): Promise<number> {
    const now = this.deps.now();
    if (now - this.lastBootstrapCheck > 60_000 || this.store.frontierSize() === 0) {
      this.lastBootstrapCheck = now;
      this.store.recoverLeases(now); // leases that outlived their deadline (hung workers)
      await this.runDueSources(now);
    }
    const free = this.deps.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    if (this.stopping) return 0;
    const batch = this.store.lease(free, 5 * 60_000, now);
    for (const r of batch) {
      const p = this.process(r).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return batch.length;
  }

  /** Process until the frontier has nothing due (tests / one-shot runs). */
  async drain(maxResources = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxResources * 4 && total < maxResources; i++) {
      const n = await this.tick();
      await Promise.allSettled([...this.inFlight]);
      total += n;
      if (n === 0 && this.inFlight.size === 0) {
        const due = this.store.db.prepare(`SELECT COUNT(*) n FROM resources WHERE state='queued' AND due_at <= ?`).get(this.deps.now()) as { n: number };
        if (!due.n) break;
        await new Promise((r) => setTimeout(r, Math.min(this.deps.hostDelayMs, 50)));
      }
    }
    return total;
  }

  async runDueSources(now = this.deps.now(), force = false): Promise<number> {
    let added = 0;
    for (const src of this.deps.sources) {
      const last = this.store.sourceRun(src.id)?.last_run_at ?? 0;
      if (!force && now - last < src.intervalMs) continue;
      try {
        const items = await src.run();
        const n = this.store.enqueue(items, now);
        added += n;
        this.store.recordSourceRun(src.id, n, null, now);
        this.store.event(null, "bootstrap_source", `${src.id}: ${items.length} references, ${n} new`);
      } catch (err) {
        this.store.recordSourceRun(src.id, 0, (err as Error).message.slice(0, 200), now);
        this.store.event(null, "bootstrap_source_failed", `${src.id}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    return added;
  }

  // ---------------------------------------------------------------- per-resource processing

  private async process(row: ResourceRow): Promise<void> {
    const store = this.store;
    const now = this.deps.now();
    const revisit = row.snapshot_count > 0;
    try {
      // Robots + host capacity.
      const rb = await this.deps.robots(row.url).catch((err) => {
        if (err instanceof FetchBlockedError) throw err;
        return { allowed: null, crawlDelay: null, sitemaps: [] as string[] };
      });
      if (rb.allowed === false) {
        store.finish(row.id, "skipped", now + 30 * DAY, { last_error: "robots.txt disallow" });
        store.event(row.id, "robots_disallowed");
        return;
      }
      const delay = Math.max(this.deps.hostDelayMs, (rb.crawlDelay ?? 0) * 1000);
      store.touchHost(row.host, delay, now);
      if (!revisit && rb.sitemaps.length && store.hostStats(row.host).pages === 0) {
        // First contact with a host: its declared sitemaps become discovery inputs.
        store.enqueue(rb.sitemaps.slice(0, 3).map((s) => ({ url: s, priority: 50, depth: row.depth + 1, via: "robots_sitemap", purpose: "discovery" as const, parentId: row.id, relation: "sitemap", scope: "site" })), now);
      }

      // ---------------- path 1: evidence & metadata processing
      const conditional: Record<string, string> = {};
      if (row.etag) conditional["if-none-match"] = row.etag;
      if (row.last_modified) conditional["if-modified-since"] = row.last_modified;
      store.event(row.id, revisit ? "revisit" : "retrieve", row.url);
      const res = await this.deps.fetch(row.url, conditional);
      const retrievedAt = new Date(this.deps.now()).toISOString();
      store.setStage(row.id, { retrieved_at: retrievedAt, http_status: res.status, final_url: res.finalUrl });
      store.event(row.id, "retrieved", `HTTP ${res.status}, ${res.body.length} bytes${res.redirects.length ? `, ${res.redirects.length} redirect(s)` : ""}`);

      if (res.status === 304) {
        store.hostResult(row.host, true, 304, now);
        const unchanged = row.unchanged_count + 1;
        store.finish(row.id, "indexed", now + this.revisitInterval(row.change_count, unchanged), { unchanged_count: unchanged });
        store.event(row.id, "not_modified", "conditional request: unchanged since last snapshot");
        return;
      }
      // Redirect target may be governed by a different robots.txt.
      if (new URL(res.finalUrl).origin !== new URL(row.url).origin) {
        const rb2 = await this.deps.robots(res.finalUrl).catch(() => ({ allowed: null }));
        if (rb2.allowed === false) {
          store.finish(row.id, "skipped", now + 30 * DAY, { last_error: `robots.txt disallows redirect target ${res.finalUrl}` });
          return;
        }
      }

      let shared = new Map<string, unknown>();
      const record = await analyzeResponse(res, { sourceType: "url", enrich: this.deps.enrich && !revisit, onShared: (s) => (shared = s) });
      store.setStage(row.id, { inspected_at: new Date(this.deps.now()).toISOString(), kind: record.kind });
      store.event(row.id, "inspected", `format ${record.kind} (${record.mimeType ?? "unknown"}), extractors: ${record.processing.extractors.map((e) => e.id.split("@")[0]).join(",")}`);

      const unavailable = res.status >= 400;
      store.hostResult(row.host, !unavailable || res.status === 404 || res.status === 410, res.status, now);

      // Version comparison against the previous snapshot.
      const prev = store.latestSnapshot(row.id);
      let changedFields: string[] | null = null;
      if (prev && prev.content_hash !== record.contentHash) {
        changedFields = diffFields(store.observationsFor(prev.id), record.fields);
      }
      // Duplicate content under another URL.
      const dupOf = record.contentHash ? store.linkDuplicates(row.id, record.contentHash) : null;

      addCrawlerObservations(record, row, { revisit, changedFields, prevFetchedAt: prev?.fetched_at ?? null, dupOf, store });
      record.categories = coverage(record.fields, record.kind, record.processing.extractors, record.httpStatus);
      store.setStage(row.id, { extracted_at: new Date(this.deps.now()).toISOString(), field_count: record.fields.length, extractor_errors: record.quality.extractorErrors.length });

      const text = String(shared.get("plainText") ?? (record.kind === "text" || record.kind === "csv" || record.kind === "json" || record.kind === "xml" ? res.body.toString("utf8") : ""));
      const index = !unavailable && !dupOf;
      store.saveSnapshot(row.id, record, { text, changedFields, index });
      const changed = Boolean(prev && changedFields);
      store.finish(row.id, unavailable ? "unavailable" : "indexed", now + (unavailable ? 7 * DAY : this.revisitInterval(row.change_count + (changed ? 1 : 0), changed ? 0 : row.unchanged_count + (prev ? 1 : 0))), {
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
      if (dupOf) store.event(row.id, "duplicate", `identical bytes to resource #${dupOf}; not indexed separately`);
      if (changed) store.event(row.id, "changed", `fields changed: ${changedFields!.join(", ") || "(content bytes only)"}`);
      store.event(row.id, index ? "indexed" : "not_indexed", `${record.fields.length} observations, ${record.categories.filter((c) => c.state === "observed").length}/41 categories observed`);

      // Contained resources (archive entries) are inspected as their own resources.
      const nested = shared.get("archiveEntries") as NestedEntry[] | undefined;
      if (nested?.length && !unavailable) await this.processArchiveEntries(row, res, nested);

      // ---------------- path 2: discovery processing
      if (!unavailable && !dupOf) this.discover(row, record, shared, now);
      this.processed++;
      this.emit("processed", { id: row.id, url: row.url, state: index ? "indexed" : unavailable ? "unavailable" : "duplicate" });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      const blocked = err instanceof FetchBlockedError || /EGRESS_BLOCKED/.test(msg);
      store.hostResult(row.host, false, null, now);
      const retry = !blocked && row.attempts < 3;
      store.finish(row.id, retry ? "queued" : blocked ? "skipped" : "failed", now + (retry ? 15 * 60_000 * row.attempts : 30 * DAY), { last_error: msg });
      store.event(row.id, retry ? "retrieve_failed_retrying" : "failed", msg);
    }
  }

  private async processArchiveEntries(parent: ResourceRow, res: SafeResponse, entries: NestedEntry[]): Promise<void> {
    for (const e of entries) {
      const url = `${res.finalUrl}#entry=${encodeURIComponent(e.name)}`;
      this.store.enqueue([{ url, priority: 0, depth: parent.depth + 1, via: "archive_entry", purpose: "contained", parentId: parent.id, relation: "has_part", scope: "resource" }]);
      const child = this.store.byUrl(url)!;
      const virtual: SafeResponse = { ...res, requestedUrl: url, finalUrl: url, headers: {}, body: e.body, truncated: false, redirects: [], encodedBytes: e.body.length };
      let shared = new Map<string, unknown>();
      const rec = await analyzeResponse(virtual, { sourceType: "url", enrich: false, filename: e.name, onShared: (s) => (shared = s) });
      const iso = new Date(this.deps.now()).toISOString();
      this.store.saveSnapshot(child.id, rec, { text: String(shared.get("plainText") ?? (["csv", "json", "text", "xml"].includes(rec.kind) ? e.body.toString("utf8") : "")), index: true });
      this.store.finish(child.id, "indexed", Number.MAX_SAFE_INTEGER, { retrieved_at: iso, inspected_at: iso, extracted_at: iso, indexed_at: iso, kind: rec.kind, title: rec.title ?? e.name, content_hash: rec.contentHash, field_count: rec.fields.length });
      this.store.event(child.id, "indexed", `archive entry of #${parent.id} (${e.size} bytes)`);
    }
  }

  private discover(row: ResourceRow, record: ResourceRecord, shared: Map<string, unknown>, now: number): void {
    const refs: Reference[] = collectReferences(record, shared);
    const items = [];
    const rejected = new Map<string, number>();
    const load = new Map<string, number>();
    const hostLoad = (h: string) => {
      if (!load.has(h)) load.set(h, this.store.hostStats(h).enqueued);
      return load.get(h)!;
    };
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
    const added = this.store.enqueue(items, now);
    const purposes = items.reduce<Record<string, number>>((a, i) => ((a[i.purpose] = (a[i.purpose] ?? 0) + 1), a), {});
    this.store.event(row.id, "discovered", `${refs.length} references → ${added} new frontier entries ${JSON.stringify(purposes)}${rejected.size ? `; rejected ${JSON.stringify(Object.fromEntries(rejected))}` : ""}`);
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

/** The crawler's own measurements and policies, recorded separately from source claims. */
function addCrawlerObservations(
  record: ResourceRecord,
  row: ResourceRow,
  o: { revisit: boolean; changedFields: string[] | null; prevFetchedAt: string | null; dupOf: number | null; store: CorpusStore },
) {
  const add = (category: number, field: string, value: unknown, method: string, evidence?: string, evidenceType: MetadataField["evidenceType"] = "system_measurement") =>
    record.fields.push({ category, field, value, status: "observed", method, extractor: "crawler@1.0.0", evidence, evidenceType, scope: "resource", sensitivity: "public", observedAt: record.fetchedAt });
  const events = o.store.eventsFor(row.id, 20);
  add(C.audit, "crawlerEvents", events.slice(0, 10).map((e) => ({ ts: e.ts, type: e.type })), "crawler event log", "this system's own retrieval/processing history — not the source's logs");
  add(C.operational, "crawlerState", { discoveredVia: row.via, purpose: row.purpose, depth: row.depth, attempts: row.attempts, discoveredAt: row.discovered_at, previousRetrieval: o.prevFetchedAt }, "crawler frontier state");
  add(C.retention, "systemRetentionPolicy", SYSTEM_RETENTION, "omnispider retention configuration", "the collecting system's own rules, distinct from any source-declared retention", "system_measurement");
  add(C.provenance, "discoveredVia", row.via, "crawler frontier");
  if (o.revisit) add(C.version, "changedSinceLastSnapshot", o.changedFields ? { changed: true, fields: o.changedFields, previousSnapshotAt: o.prevFetchedAt } : { changed: false, previousSnapshotAt: o.prevFetchedAt }, "snapshot comparison (content hash + tracked fields)");
  if (o.dupOf) {
    add(C.integrity, "duplicateOfResource", o.dupOf, "sha256 equality with another resource", "identical bytes; copies are not independent evidence");
    record.relationships.push({ type: "same_as", target: o.store.get(o.dupOf)!.url, evidence: "identical SHA-256 content hash", method: "crawler duplicate detection", status: "observed" });
  }
}
