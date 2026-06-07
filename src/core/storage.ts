import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import type { CrawlJob, CrawlJobSpec, CrawlStatus, FrontierEntry, PageRecord } from "./models.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  pages_crawled INTEGER DEFAULT 0,
  pages_failed INTEGER DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  source TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  archive_timestamp TEXT,
  status TEXT DEFAULT 'pending',
  UNIQUE(job_id, url, archive_timestamp)
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  status_code INTEGER,
  content_type TEXT,
  title TEXT,
  depth INTEGER,
  source TEXT,
  engine TEXT,
  fetched_at TEXT,
  content_path TEXT,
  content_hash TEXT,
  links_found INTEGER DEFAULT 0,
  archive_timestamp TEXT,
  metadata_json TEXT,
  UNIQUE(job_id, url, archive_timestamp)
);
CREATE TABLE IF NOT EXISTS visited (
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  archive_timestamp TEXT,
  PRIMARY KEY (job_id, url, archive_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_frontier_job_status ON frontier(job_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_pages_job ON pages(job_id);
`;

export class Storage {
  private db: Database.Database;
  readonly contentDir: string;
  readonly storeHtml: boolean;
  readonly storeMetadata: boolean;

  constructor(config: AppConfig) {
    mkdirSync(dirname(config.storage.databasePath), { recursive: true });
    mkdirSync(config.storage.contentDir, { recursive: true });
    this.db = new Database(config.storage.databasePath);
    this.db.exec(SCHEMA);
    this.contentDir = config.storage.contentDir;
    this.storeHtml = config.storage.storeHtml;
    this.storeMetadata = config.storage.storeMetadata;
  }

  createJob(job: CrawlJob): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, spec_json, status, created_at, pages_crawled, pages_failed)
         VALUES (?, ?, ?, ?, 0, 0)`,
      )
      .run(job.id, JSON.stringify(job), job.status, job.createdAt);
  }

  updateJob(job: CrawlJob): void {
    this.db
      .prepare(
        `UPDATE jobs SET status=?, started_at=?, finished_at=?, pages_crawled=?, pages_failed=?, error=? WHERE id=?`,
      )
      .run(
        job.status,
        job.startedAt ?? null,
        job.finishedAt ?? null,
        job.pagesCrawled,
        job.pagesFailed,
        job.error ?? null,
        job.id,
      );
  }

  getJob(jobId: string): CrawlJob | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const job = JSON.parse(row.spec_json as string) as CrawlJob;
    job.id = row.id as string;
    job.status = row.status as CrawlStatus;
    job.createdAt = row.created_at as string;
    job.startedAt = (row.started_at as string) ?? null;
    job.finishedAt = (row.finished_at as string) ?? null;
    job.pagesCrawled = row.pages_crawled as number;
    job.pagesFailed = row.pages_failed as number;
    job.error = (row.error as string) ?? null;
    return job;
  }

  listJobs(limit = 50): CrawlJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => {
      const job = JSON.parse(row.spec_json as string) as CrawlJob;
      job.id = row.id as string;
      job.status = row.status as CrawlStatus;
      job.createdAt = row.created_at as string;
      job.startedAt = (row.started_at as string) ?? null;
      job.finishedAt = (row.finished_at as string) ?? null;
      job.pagesCrawled = row.pages_crawled as number;
      job.pagesFailed = row.pages_failed as number;
      job.error = (row.error as string) ?? null;
      return job;
    });
  }

  enqueueFrontier(jobId: string, entries: FrontierEntry[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO frontier (job_id, url, depth, source, priority, archive_timestamp, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        const r = stmt.run(jobId, e.url, e.depth, e.source, e.priority, e.archiveTimestamp ?? null);
        inserted += r.changes;
      }
    });
    tx();
    return inserted;
  }

  popFrontier(jobId: string): FrontierEntry | null {
    const row = this.db
      .prepare(
        `SELECT id, url, depth, source, priority, archive_timestamp FROM frontier
         WHERE job_id=? AND status='pending' ORDER BY priority DESC, depth ASC, id ASC LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE frontier SET status='processing' WHERE id=?`).run(row.id);
    return {
      url: row.url as string,
      depth: row.depth as number,
      source: row.source as FrontierEntry["source"],
      priority: row.priority as number,
      archiveTimestamp: (row.archive_timestamp as string) ?? null,
    };
  }

  markFrontierDone(jobId: string, url: string, archiveTimestamp: string | null): void {
    this.db
      .prepare(
        `UPDATE frontier SET status='done' WHERE job_id=? AND url=? AND archive_timestamp IS ?`,
      )
      .run(jobId, url, archiveTimestamp);
  }

  markVisited(jobId: string, url: string, archiveTimestamp: string | null): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO visited (job_id, url, archive_timestamp) VALUES (?, ?, ?)`)
      .run(jobId, url, archiveTimestamp);
    return r.changes > 0;
  }

  savePage(jobId: string, page: PageRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pages
         (job_id, url, final_url, status_code, content_type, title, depth, source, engine,
          fetched_at, content_path, content_hash, links_found, archive_timestamp, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        page.url,
        page.finalUrl ?? null,
        page.statusCode ?? null,
        page.contentType ?? null,
        page.title ?? null,
        page.depth,
        page.source,
        page.engine,
        page.fetchedAt,
        page.contentPath ?? null,
        page.contentHash ?? null,
        page.linksFound,
        page.archiveTimestamp ?? null,
        this.storeMetadata ? JSON.stringify(page.metadata) : "{}",
      );
  }

  listPages(jobId: string, limit = 100, offset = 0): PageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM pages WHERE job_id=? ORDER BY fetched_at DESC LIMIT ? OFFSET ?`)
      .all(jobId, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => ({
      url: row.url as string,
      finalUrl: (row.final_url as string) ?? null,
      statusCode: (row.status_code as number) ?? null,
      contentType: (row.content_type as string) ?? null,
      title: (row.title as string) ?? null,
      depth: row.depth as number,
      source: row.source as PageRecord["source"],
      engine: row.engine as PageRecord["engine"],
      fetchedAt: row.fetched_at as string,
      contentPath: (row.content_path as string) ?? null,
      contentHash: (row.content_hash as string) ?? null,
      linksFound: row.links_found as number,
      archiveTimestamp: (row.archive_timestamp as string) ?? null,
      metadata: JSON.parse((row.metadata_json as string) || "{}"),
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function createJobFromSpec(id: string, spec: CrawlJobSpec): CrawlJob {
  return {
    id,
    seeds: spec.seeds,
    engine: spec.engine ?? "auto",
    maxDepth: spec.maxDepth ?? 3,
    maxPages: spec.maxPages ?? 1000,
    includeArchive: spec.includeArchive ?? true,
    includeSitemaps: spec.includeSitemaps ?? true,
    jsRendering: spec.jsRendering ?? false,
    allowedDomains: spec.allowedDomains ?? null,
    metadata: spec.metadata ?? {},
    topic: spec.topic ?? null,
    topicMinLinkScore: spec.topicMinLinkScore ?? 0.1,
    topicMinRelevance: spec.topicMinRelevance ?? 0.12,
    topicFollowRelated: spec.topicFollowRelated ?? false,
    exhaustive: spec.exhaustive ?? false,
    extraFrontier: spec.extraFrontier ?? [],
    status: "pending",
    createdAt: new Date().toISOString(),
    pagesCrawled: 0,
    pagesFailed: 0,
  };
}
