import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { AppConfig } from "./config.js";
import type { EngineType, PageSource } from "./models.js";

interface RobotsRobot {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as (
  url: string,
  robotstxt: string,
) => RobotsRobot;

export function normalizeUrl(url: string): string {
  const u = new URL(url.trim());
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

export function domainOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export function isSameDomain(url: string, base: string): boolean {
  return domainOf(url) === domainOf(base);
}

export function absoluteUrl(base: string, link: string): string | null {
  if (!link || link.startsWith("#") || /^(mailto|javascript|tel|data):/i.test(link)) return null;
  try {
    const joined = new URL(link, base).toString();
    const parsed = new URL(joined);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return normalizeUrl(joined);
  } catch {
    return null;
  }
}

export function contentHash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function saveContent(contentDir: string, url: string, body: Buffer): string {
  const digest = contentHash(body);
  const shard = digest.slice(0, 2);
  const dir = join(contentDir, shard);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${digest}.html`);
  writeFileSync(path, body);
  return path;
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

const JS_HINTS =
  /react|angular|vue|next\.js|nuxt|__NEXT_DATA__|window\.__INITIAL_STATE__/i;

export function needsJsRendering(html: string): boolean {
  if (html.length < 500) return true;
  const slice = html.slice(0, 50000);
  if (/<noscript/i.test(slice) && (slice.match(/<a\s+href=/gi) ?? []).length < 3) return true;
  return JS_HINTS.test(slice);
}

class RateLimiter {
  private interval: number;
  private lastRequest = new Map<string, number>();

  constructor(requestsPerSecond: number) {
    this.interval = 1000 / Math.max(requestsPerSecond, 0.1);
  }

  async acquire(host: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRequest.get(host) ?? 0;
    const elapsed = now - last;
    if (elapsed < this.interval) {
      await sleep(this.interval - elapsed);
    }
    this.lastRequest.set(host, Date.now());
  }
}

class RobotsCache {
  private parsers = new Map<string, RobotsRobot | null>();
  private userAgent: string;
  private timeoutMs: number;

  constructor(userAgent: string, timeoutSeconds: number) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutSeconds * 1000;
  }

  async allowed(fetchFn: typeof fetch, url: string): Promise<boolean> {
    const host = domainOf(url);
    if (!this.parsers.has(host)) {
      this.parsers.set(host, await this.fetchParser(fetchFn, host));
    }
    const parser = this.parsers.get(host);
    if (!parser) return true;
    return parser.isAllowed(url, this.userAgent) ?? true;
  }

  private async fetchParser(fetchFn: typeof fetch, host: string) {
    const robotsUrl = `https://${host}/robots.txt`;
    try {
      const resp = await fetchFn(robotsUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "User-Agent": this.userAgent },
      });
      if (!resp.ok) return null;
      const text = await resp.text();
      return robotsParser(robotsUrl, text);
    } catch {
      return null;
    }
  }
}

export class CrawlPolicy {
  private config: AppConfig;
  private rateLimiter: RateLimiter;
  private robots: RobotsCache;

  constructor(config: AppConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(config.policy.rateLimitPerHost);
    this.robots = new RobotsCache(
      config.orchestrator.userAgent,
      config.orchestrator.requestTimeoutSeconds,
    );
  }

  async preflight(
    fetchFn: typeof fetch,
    url: string,
    opts: { allowedDomains?: string[] | null; seedUrl: string },
  ): Promise<{ allowed: boolean; reason?: string }> {
    const parsed = new URL(url);
    if (!this.config.policy.allowedSchemes.includes(parsed.protocol.replace(":", ""))) {
      return { allowed: false, reason: "scheme_not_allowed" };
    }
    const host = parsed.hostname.toLowerCase();
    if (this.config.policy.blockedDomains.includes(host)) {
      return { allowed: false, reason: "domain_blocked" };
    }
    if (opts.allowedDomains?.length) {
      const ok = opts.allowedDomains.some(
        (d) => host === d || host.endsWith(`.${d}`),
      );
      if (!ok) {
        return { allowed: false, reason: "domain_not_allowed" };
      }
    }
    if (this.config.policy.respectRobotsTxt) {
      if (!(await this.robots.allowed(fetchFn, url))) {
        return { allowed: false, reason: "robots_disallowed" };
      }
    }
    await this.rateLimiter.acquire(host);
    return { allowed: true };
  }

  selectEngine(opts: {
    requested: EngineType;
    jsRendering: boolean;
    source: PageSource;
  }): EngineType {
    if (opts.requested !== "auto") return opts.requested;
    if (opts.source === "wayback" || opts.source === "common_crawl") return "archive";
    if (opts.jsRendering) return this.config.engines.routing.js_heavy as EngineType;
    return this.config.engines.default as EngineType;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
