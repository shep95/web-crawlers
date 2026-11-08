import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { detectSecrets } from "../text/secrets.js";
import { parsePage, techFromHeaders, type PageFacts } from "./collect.js";
import { isReadOnlyCandidate, validatePage, type Validation } from "./validation.js";
import type { IntelNet } from "./net.js";

export interface PageEvidence {
  url: string; finalUrl: string; parent: string | null; via: string; status: number; bytes: number; truncated: boolean;
  sha256: string; observedAt: string; error?: string;
  secrets: Array<{ type: string; value: string; start: number; end: number; length: number; placeholder: boolean }>;
  contacts: string[];
  web?: { contentType: string; technologies: string[]; headers: Record<string, boolean>; page: PageFacts | null };
  validation?: Validation[];
}

type PageTask = { url: string; parent: string | null; via: string };
const DISCOVERY_RELS = new Set(["canonical", "alternate", "next", "prev", "sitemap", "describedby", "item", "service-desc"]);
const MAX_ACTIVE = 4;

/** Authorized public GET traversal. Every discovered branch passes through the same scope check. */
export class PageCrawler {
  private queue: PageTask[] = [];
  private head = 0;
  private seen = new Set<string>();
  records: PageEvidence[] = [];
  rejected: Array<{ url: string; reason: string }> = [];

  constructor(
    private net: IntelNet,
    private allowed: (host: string) => boolean,
    private onHost: (host: string, parent: string) => void,
    private now = Date.now,
    private validate = false,
  ) {}

  get frontier() { return this.queue.length - this.head; }

  enqueue(input: string, parent: string | null, via: string, base = parent) {
    let url: URL;
    try { url = new URL(input, base || undefined); } catch { return; }
    url.hash = "";
    if (this.seen.has(url.href)) return;
    this.seen.add(url.href);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !this.allowed(url.hostname)) return;

    if (!isReadOnlyCandidate(url)) {
      this.rejected.push({ url: url.href, reason: "Potential state-changing navigation; not requested automatically." });
      return;
    }
    this.queue.push({ url: url.href, parent, via });
    this.onHost(url.hostname, parent || url.hostname);
  }

  private take(): PageTask {
    const task = this.queue[this.head++];
    if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return task;
  }

  async wave(budgetMs: number) {
    const deadline = this.now() + Math.max(0, budgetMs);
    const active = new Set<Promise<void>>();
    while (this.frontier || active.size) {
      while (this.frontier && active.size < MAX_ACTIVE && this.now() < deadline) {
        const timeout = Math.max(1000, Math.min(8000, deadline - this.now()));
        const work = this.inspect(this.take(), timeout).finally(() => active.delete(work));
        active.add(work);
      }
      if (!active.size) break;
      await Promise.race(active);
    }
  }

  private async inspect(task: PageTask, timeoutMs: number) {
    const { url, parent, via } = task;
    try {
      const response = await this.net.http(url, { maxBytes: 8 * 1024 * 1024, follow: false, timeoutMs, raw: true });
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        this.enqueue(response.headers.location, url, "redirect");
      }
      const body = response.body || "";
      const bytes = response.bytes ?? Buffer.from(body);
      const secrets = detectSecrets(body, { maxFindings: Number.MAX_SAFE_INTEGER }).map(s => ({
        type: s.type, value: body.slice(s.start, s.end), start: s.start, end: s.end,
        length: s.length, placeholder: !!s.likelyPlaceholder,
      }));
      const contacts = [...new Set(body.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
      const type = response.headers["content-type"] || "";
      const isHtml = /html/i.test(type);
      const success = response.status >= 200 && response.status < 300;
      const parsed = success && isHtml ? await parsePage(this.net, body, new URL(url), new URL(url).hostname, () => false) : null;
      const record: PageEvidence = {
        url, parent, via, finalUrl: response.finalUrl, status: response.status, bytes: bytes.length,
        truncated: response.truncated, sha256: createHash("sha256").update(bytes).digest("hex"),
        observedAt: new Date(this.now()).toISOString(), ...(response.error ? { error: response.error } : {}), secrets, contacts,
        web: {
          contentType: type, technologies: [...new Set([...techFromHeaders(response.headers), ...(parsed?.technologies || [])])],
          headers: Object.fromEntries(["content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "access-control-allow-origin", "cache-control", "set-cookie"].map(name => [name, name in response.headers])),
          page: parsed,
        },
      };
      // A failed probe must not discard the successful acquisition.
      if (this.validate) {
        try { record.validation = await validatePage(this.net, new URL(url), response, timeoutMs, true, this.now); }
        catch (error) { record.error = "Validation: " + (error as Error).message; }
      }
      this.records.push(record);
      if (!success) return;
      const linkHeader = response.headers.link || "";
      for (const [, target, params] of linkHeader.matchAll(/<([^>]+)>([^<]*)/g)) {
        const match = params.match(/;\s*rel\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i);
        const rel = (match?.[1] || match?.[2] || "").toLowerCase().split(/\s+/);
        if (!/;\s*anchor\s*=/i.test(params) && rel.some(value => DISCOVERY_RELS.has(value))) {
          this.enqueue(target, url, "HTTP link");
        }
      }
      if (/html/i.test(type)) {
        const $ = cheerio.load(body);
        let base = url;
        try { base = new URL($("base[href]").first().attr("href") || url, url).href; } catch { /* Keep the request URL. */ }
        $("a[href],area[href],link[href],script[src],iframe[src]").each((_i, element) => {
          const target = $(element).attr("href") || $(element).attr("src");
          if (target) this.enqueue(target, url, element.tagName === "script" ? "script" : "page link", base);
        });
      }
      if (/xml/i.test(type) || /sitemap/i.test(new URL(url).pathname)) {
        const $ = cheerio.load(body, { xml: true });
        $("sitemapindex > sitemap > loc,urlset > url > loc,sitemapindex > loc,urlset > loc").each((_i, element) => {
          this.enqueue($(element).text().trim(), url, "sitemap");
        });
      }
    } catch (error) {
      this.records.push({
        url, parent, via, finalUrl: url, status: 0, bytes: 0, truncated: false, sha256: "",
        observedAt: new Date(this.now()).toISOString(), error: (error as Error).message, secrets: [], contacts: [],
      });
    }
  }

  report() {
    return {
      records: this.records, validationEnabled: this.validate, frontier: this.frontier, rejected: this.rejected, complete: this.frontier === 0,
      limits: [
        "8 MiB per response; truncated responses are identified, not claimed complete.",
        "Discovered authorized URLs only; unlinked, authenticated and undiscovered paths may remain.",
        "Public GET requests only; state-changing navigation is excluded. Time budgets pause the queue without discarding it.",
      ],
    };
  }
}
