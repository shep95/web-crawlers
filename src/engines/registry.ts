import type { AppConfig } from "../core/config.js";
import type { EngineType, FetchResult, PageSource } from "../core/models.js";

export interface Engine {
  engineType: EngineType;
  fetch(
    url: string,
    opts?: { source?: PageSource; archiveTimestamp?: string | null },
  ): Promise<FetchResult>;
  close?(): Promise<void>;
}

export class HttpEngine implements Engine {
  engineType: EngineType = "http";
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async fetch(
    url: string,
    opts: { source?: PageSource; archiveTimestamp?: string | null } = {},
  ): Promise<FetchResult> {
    const timeoutMs = this.config.orchestrator.requestTimeoutSeconds * 1000;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        headers: { "User-Agent": this.config.orchestrator.userAgent },
      });
      const body = Buffer.from(await resp.arrayBuffer());
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        url,
        finalUrl: resp.url,
        statusCode: resp.status,
        headers,
        body,
        contentType: resp.headers.get("content-type"),
        engine: this.engineType,
        source: opts.source ?? "live",
        archiveTimestamp: opts.archiveTimestamp ?? null,
      };
    } catch (err) {
      return {
        url,
        finalUrl: url,
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        engine: this.engineType,
        source: opts.source ?? "live",
        archiveTimestamp: opts.archiveTimestamp ?? null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class ArchiveEngine implements Engine {
  engineType: EngineType = "archive";
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  waybackUrl(timestamp: string, url: string): string {
    return `${this.config.archive.waybackRenderUrl.replace(/\/$/, "")}/${timestamp}/${url}`;
  }

  async listSnapshots(url: string): Promise<string[]> {
    const params = new URLSearchParams({
      url,
      output: "json",
      fl: "timestamp,original,statuscode",
      filter: "statuscode:200",
      collapse: "timestamp:8",
      limit: String(this.config.archive.maxSnapshotsPerUrl),
    });
    const rows = await this.queryCdxRows(params);
    return rows.map((r) => r[0]).filter(Boolean);
  }

  /** CDX wildcard search — returns original URLs captured in Wayback. */
  async searchCapturedUrls(urlPattern: string, limit = 30): Promise<string[]> {
    const params = new URLSearchParams({
      url: urlPattern,
      output: "json",
      fl: "timestamp,original,statuscode",
      filter: "statuscode:200",
      collapse: "original",
      limit: String(limit),
    });
    const rows = await this.queryCdxRows(params);
    return [...new Set(rows.map((r) => r[1]).filter(Boolean))];
  }

  /** Returns [timestamp, original] pairs for a URL pattern. */
  async searchSnapshots(
    urlPattern: string,
    limit = 20,
  ): Promise<Array<{ timestamp: string; original: string }>> {
    const params = new URLSearchParams({
      url: urlPattern,
      fl: "timestamp,original,statuscode",
      filter: "statuscode:200",
      collapse: "timestamp:8",
      limit: String(limit),
      output: "json",
    });
    const rows = await this.queryCdxRows(params);
    return rows
      .map((r) => ({ timestamp: r[0], original: r[1] }))
      .filter((r) => r.timestamp && r.original);
  }

  private async queryCdxRows(params: URLSearchParams): Promise<string[][]> {
    try {
      const resp = await fetch(`${this.config.archive.waybackCdxUrl}?${params}`, {
        signal: AbortSignal.timeout(this.config.orchestrator.requestTimeoutSeconds * 1000),
        headers: { "User-Agent": this.config.orchestrator.userAgent },
      });
      if (!resp.ok) return [];
      const rows = (await resp.json()) as string[][];
      if (!rows || rows.length < 2) return [];
      return rows.slice(1);
    } catch {
      return [];
    }
  }

  async fetch(
    url: string,
    opts: { source?: PageSource; archiveTimestamp?: string | null } = {},
  ): Promise<FetchResult> {
    let timestamp = opts.archiveTimestamp;
    if (!timestamp) {
      const snapshots = await this.listSnapshots(url);
      if (!snapshots.length) {
        return {
          url,
          finalUrl: url,
          statusCode: 404,
          headers: {},
          body: Buffer.alloc(0),
          engine: this.engineType,
          source: "wayback",
          error: "no_archive_snapshots",
        };
      }
      timestamp = snapshots[snapshots.length - 1];
    }
    const archiveUrl = this.waybackUrl(timestamp, url);
    const http = new HttpEngine(this.config);
    const result = await http.fetch(archiveUrl, { source: "wayback", archiveTimestamp: timestamp });
    return { ...result, url, source: "wayback", archiveTimestamp: timestamp };
  }
}

export class PlaywrightEngine implements Engine {
  engineType: EngineType = "playwright";
  private config: AppConfig;
  private browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>> | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private async ensureBrowser() {
    if (this.browser) return this.browser;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: this.config.engines.playwright.headless });
    return this.browser;
  }

  async fetch(
    url: string,
    opts: { source?: PageSource; archiveTimestamp?: string | null } = {},
  ): Promise<FetchResult> {
    try {
      const browser = await this.ensureBrowser();
      const page = await browser.newPage({ userAgent: this.config.orchestrator.userAgent });
      try {
        const response = await page.goto(url, {
          waitUntil: this.config.engines.playwright.waitUntil as "networkidle",
          timeout: this.config.orchestrator.requestTimeoutSeconds * 1000,
        });
        const html = await page.content();
        return {
          url,
          finalUrl: page.url(),
          statusCode: response?.status() ?? 200,
          headers: {},
          body: Buffer.from(html, "utf8"),
          contentType: "text/html",
          engine: this.engineType,
          source: opts.source ?? "live",
          archiveTimestamp: opts.archiveTimestamp ?? null,
        };
      } finally {
        await page.close();
      }
    } catch (err) {
      return {
        url,
        finalUrl: url,
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        engine: this.engineType,
        source: opts.source ?? "live",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

export class EngineRegistry {
  private engines: Map<string, Engine>;

  constructor(config: AppConfig) {
    this.engines = new Map<string, Engine>([
      ["http", new HttpEngine(config)],
      ["archive", new ArchiveEngine(config)],
      ["playwright", new PlaywrightEngine(config)],
    ]);
  }

  get(type: EngineType): Engine {
    const engine = this.engines.get(type);
    if (!engine) return this.engines.get("http")!;
    return engine;
  }

  async closeAll(): Promise<void> {
    for (const e of this.engines.values()) {
      await e.close?.();
    }
  }
}
