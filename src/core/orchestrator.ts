import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import pino from "pino";
import type { AppConfig } from "./config.js";
import type { CrawlJob, CrawlJobSpec, CrawlStatus, EngineType, FetchResult, FrontierEntry, PageRecord } from "./models.js";
import { fetchOk } from "./models.js";
import {
  CrawlPolicy,
  contentHash,
  extractTitle,
  needsJsRendering,
  normalizeUrl,
  saveContent,
} from "./policy.js";
import { Storage, createJobFromSpec } from "./storage.js";
import {
  discoverRobotsSitemaps,
  discoverSitemapUrls,
  extractLinks,
  extractLinksWithText,
} from "../discovery/links.js";
import { ArchiveEngine, EngineRegistry } from "../engines/registry.js";
import type { NomadSecurityStack } from "../security/nomad.js";
import {
  TopicProfile,
  extractProfileUrlsFromHtml,
  isTopicNoiseUrl,
  scoreLink,
  scorePage,
  shouldFollowTopicLink,
} from "../topic/index.js";
import { extractPlainText } from "./text-extract.js";

const log = pino({ name: "orchestrator" });

export class Orchestrator {
  private config: AppConfig;
  private security: NomadSecurityStack | null;
  private storage: Storage;
  private engines: EngineRegistry;
  private policy: CrawlPolicy;
  private activeJobs = new Map<string, Promise<void>>();

  constructor(config: AppConfig, security: NomadSecurityStack | null = null) {
    this.config = config;
    this.security = security;
    this.storage = new Storage(config);
    this.engines = new EngineRegistry(config);
    this.policy = new CrawlPolicy(config);
  }

  init(): void {
    /* sqlite initialized in constructor */
  }

  shutdown(): void {
    this.storage.close();
    void this.engines.closeAll();
  }

  async submitJob(spec: CrawlJobSpec, correlationId?: string): Promise<CrawlJob> {
    if (this.security) {
      const blocked = this.security.ssrfGuard.validateMany(spec.seeds);
      if (blocked.length) {
        for (const [url, reason] of blocked) {
          this.security.audit.record("ssrf_blocked", {
            correlationId,
            detail: `${url} — ${reason}`,
          });
        }
        throw new Error(`SSRF blocked: ${blocked[0][0]} (${blocked[0][1]})`);
      }
      this.security.vitalGuard.requireVital("submit_job");
    }

    const job = createJobFromSpec(randomUUID(), spec);
    this.storage.createJob(job);
    this.security?.audit.record("job_started", {
      correlationId,
      detail: `job=${job.id} seeds=${spec.seeds.length}`,
    });

    const run = this.runJob(job, correlationId);
    this.activeJobs.set(job.id, run);
    void run.finally(() => this.activeJobs.delete(job.id));
    return job;
  }

  getJob(jobId: string): CrawlJob | null {
    return this.storage.getJob(jobId);
  }

  listJobs(limit = 50): CrawlJob[] {
    return this.storage.listJobs(limit);
  }

  listPages(jobId: string, limit = 100, offset = 0): PageRecord[] {
    return this.storage.listPages(jobId, limit, offset);
  }

  listPagesWithText(
    jobId: string,
    limit = 100,
    offset = 0,
  ): Array<PageRecord & { text: string }> {
    const pages = this.storage.listPages(jobId, limit, offset);
    const out: Array<PageRecord & { text: string }> = [];
    for (const page of pages) {
      let text = "";
      if (page.contentPath && existsSync(page.contentPath)) {
        try {
          text = extractPlainText(readFileSync(page.contentPath, "utf8"));
        } catch {
          text = "";
        }
      }
      if (text.length >= 80) {
        out.push({ ...page, text });
      }
    }
    return out;
  }

  async waitForJob(
    jobId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<CrawlJob | null> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const pollMs = opts.pollMs ?? 1500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.getJob(jobId);
      if (!job) return null;
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await sleep(pollMs);
    }
    return this.getJob(jobId);
  }

  enqueueEntries(jobId: string, entries: FrontierEntry[]): void {
    this.storage.enqueueFrontier(jobId, entries);
  }

  private async runJob(job: CrawlJob, correlationId?: string): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.storage.updateJob(job);

    try {
      await this.seedFrontier(job);
      const workers = Array.from(
        { length: Math.min(this.config.orchestrator.maxConcurrency, 8) },
        () => this.worker(job),
      );
      await Promise.all(workers);
      job.status = "completed";
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      log.error({ jobId: job.id, err: job.error }, "job_failed");
    } finally {
      job.finishedAt = new Date().toISOString();
      this.storage.updateJob(job);
      if (this.security) {
        this.security.audit.record(
          job.status === "completed" ? "job_completed" : "job_failed",
          { correlationId, detail: `job=${job.id} pages=${job.pagesCrawled}` },
        );
      }
    }
  }

  private async seedFrontier(job: CrawlJob): Promise<void> {
    const entries: FrontierEntry[] = [];
    const seeds = job.seeds.map(normalizeUrl);
    for (const seed of seeds) {
      entries.push({ url: seed, depth: 0, source: "seed", priority: 100 });
    }

    if (job.includeSitemaps && this.config.discovery.sitemap) {
      const timeoutMs = this.config.orchestrator.requestTimeoutSeconds * 1000;
      const ua = this.config.orchestrator.userAgent;
      for (const seed of seeds) {
        const sitemapUrls = await discoverSitemapUrls(fetch, seed, { timeoutMs, userAgent: ua });
        const robots = await discoverRobotsSitemaps(fetch, seed, { timeoutMs, userAgent: ua });
        for (const url of [...sitemapUrls, ...robots]) {
          entries.push({ url, depth: 0, source: "sitemap", priority: 90 });
        }
      }
    }

    if (job.includeArchive && this.config.archive.enabled) {
      const archive = this.engines.get("archive") as ArchiveEngine;
      for (const seed of seeds) {
        const snapshots = await archive.listSnapshots(seed);
        for (const ts of snapshots) {
          entries.push({ url: seed, depth: 0, source: "wayback", priority: 70, archiveTimestamp: ts });
        }
      }
    }

    if (job.extraFrontier?.length) {
      entries.push(...job.extraFrontier);
    }

    this.storage.enqueueFrontier(job.id, entries);
    log.info({ jobId: job.id, entries: entries.length }, "frontier_seeded");
  }

  private pageLimit(job: CrawlJob): number {
    if (job.maxPages && job.maxPages > 0) return job.maxPages;
    return this.config.orchestrator.maxPagesPerJob;
  }

  private async worker(job: CrawlJob): Promise<void> {
    const seedUrl = normalizeUrl(job.seeds[0]);
    let idleRounds = 0;
    const topicProfile = job.topic ? TopicProfile.parse(job.topic) : null;
    const limit = this.pageLimit(job);
    const maxIdle = job.exhaustive ? 30 : 6;

    while (job.pagesCrawled < limit) {
      const entry = this.storage.popFrontier(job.id);
      if (!entry) {
        idleRounds++;
        if (idleRounds >= maxIdle) break;
        await sleep(500);
        continue;
      }
      idleRounds = 0;

      if (entry.depth > (job.maxDepth ?? 3) && entry.source !== "wayback") {
        this.storage.markFrontierDone(job.id, entry.url, entry.archiveTimestamp ?? null);
        continue;
      }

      if (!this.storage.markVisited(job.id, entry.url, entry.archiveTimestamp ?? null)) {
        this.storage.markFrontierDone(job.id, entry.url, entry.archiveTimestamp ?? null);
        continue;
      }

      const { allowed, reason } = await this.policy.preflight(fetch, entry.url, {
        allowedDomains: job.allowedDomains ?? null,
        seedUrl,
      });
      if (!allowed) {
        job.pagesFailed++;
        this.storage.markFrontierDone(job.id, entry.url, entry.archiveTimestamp ?? null);
        this.storage.updateJob(job);
        continue;
      }

      if (this.security && entry.source === "live") {
        const ssrf = this.security.ssrfGuard.validateUrl(entry.url);
        if (!ssrf.ok) {
          job.pagesFailed++;
          this.storage.markFrontierDone(job.id, entry.url, entry.archiveTimestamp ?? null);
          this.storage.updateJob(job);
          continue;
        }
      }

      if (job.pagesCrawled >= limit) break;

      const page = await this.fetchAndProcess(job, entry, seedUrl, topicProfile);
      if (page) job.pagesCrawled++;
      else job.pagesFailed++;

      this.storage.markFrontierDone(job.id, entry.url, entry.archiveTimestamp ?? null);
      this.storage.updateJob(job);
    }
  }

  private async fetchAndProcess(
    job: CrawlJob,
    entry: FrontierEntry,
    seedUrl: string,
    topicProfile: TopicProfile | null,
  ): Promise<PageRecord | null> {
    const engineType = this.policy.selectEngine({
      requested: (job.engine ?? "auto") as EngineType,
      jsRendering: job.jsRendering ?? false,
      source: entry.source,
    });

    let result = await this.engines.get(engineType).fetch(entry.url, {
      source: entry.source,
      archiveTimestamp: entry.archiveTimestamp ?? null,
    });

    if (!fetchOk(result) && entry.source === "live" && !(job.jsRendering ?? false)) {
      const retry = await this.engines.get("playwright").fetch(entry.url, { source: entry.source });
      if (fetchOk(retry)) result = retry;
    }

    if (!fetchOk(result) || !result.body.length) return null;

    let html = result.body.toString("utf8");
    if (entry.source === "live" && !(job.jsRendering ?? false) && needsJsRendering(html)) {
      const retry = await this.engines.get("playwright").fetch(entry.url, { source: entry.source });
      if (fetchOk(retry) && retry.body.length) {
        result = retry;
        html = retry.body.toString("utf8");
      }
    }

    let contentPath: string | null = null;
    const digest = contentHash(result.body);
    if (this.storage.storeHtml && (result.contentType ?? "text/html").includes("html")) {
      contentPath = saveContent(this.storage.contentDir, entry.url, result.body);
    }

    const links = this.config.discovery.linkExtraction ? extractLinks(html, result.finalUrl) : [];
    const title = extractTitle(html);
    const topicRelevance = topicProfile
      ? scorePage(entry.url, title, html, topicProfile)
      : undefined;

    const page: PageRecord = {
      url: entry.url,
      finalUrl: result.finalUrl,
      statusCode: result.statusCode,
      contentType: result.contentType ?? null,
      title,
      depth: entry.depth,
      source: entry.source,
      engine: result.engine,
      fetchedAt: new Date().toISOString(),
      contentPath,
      contentHash: digest,
      linksFound: links.length,
      archiveTimestamp: entry.archiveTimestamp ?? null,
      metadata: topicRelevance !== undefined ? { topicRelevance } : {},
    };
    this.storage.savePage(job.id, page);

    if (entry.depth < (job.maxDepth ?? 3)) {
      const childEntries: FrontierEntry[] = [];
      const linkCap = topicProfile && job.topicFollowRelated ? 500 : 200;
      const enqueueCap = topicProfile && job.topicFollowRelated ? 400 : 250;

      if (topicProfile && job.topicFollowRelated) {
        for (const link of extractProfileUrlsFromHtml(html, result.finalUrl, topicProfile)) {
          if (isTopicNoiseUrl(link)) continue;
          if (this.security && !this.security.ssrfGuard.validateUrl(link).ok) continue;
          childEntries.push({
            url: link,
            depth: entry.depth + 1,
            source: "live",
            priority: 90 - entry.depth,
          });
        }
        const pageIsRelevant =
          topicRelevance !== undefined && topicRelevance >= (job.topicMinRelevance ?? 0.1);
        const linkThreshold = pageIsRelevant
          ? (job.topicMinLinkScore ?? 0.1) * 0.6
          : (job.topicMinLinkScore ?? 0.1);
        for (const [link, anchor] of extractLinksWithText(html, result.finalUrl)) {
          if (!shouldFollowTopicLink(link, anchor, topicProfile, linkThreshold)) continue;
          if (this.security && !this.security.ssrfGuard.validateUrl(link).ok) continue;
          const linkScore = scoreLink(link, anchor, topicProfile);
          childEntries.push({
            url: link,
            depth: entry.depth + 1,
            source: "live",
            priority: Math.round(linkScore * 100) - entry.depth,
          });
        }
      } else {
        for (const link of links.slice(0, linkCap)) {
          if (this.security && !this.security.ssrfGuard.validateUrl(link).ok) continue;
          childEntries.push({
            url: link,
            depth: entry.depth + 1,
            source: "live",
            priority: 50 - entry.depth,
          });
        }
      }

      if (childEntries.length) {
        childEntries.sort((a, b) => b.priority - a.priority);
        const seen = new Set<string>();
        const deduped = childEntries.filter((e) => {
          const key = `${e.url}|${e.archiveTimestamp ?? ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        this.storage.enqueueFrontier(job.id, deduped.slice(0, enqueueCap));
      }
    }

    return page;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
