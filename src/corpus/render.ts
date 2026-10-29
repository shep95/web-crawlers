import pino from "pino";
import type { Renderer } from "./crawler.js";
import { checkUrl } from "../net/ip-guard.js";

const log = pino({ name: "renderer" });

/**
 * Selective headless rendering for JS-only pages. One shared browser, one page
 * at a time per call, sub-requests to non-public addresses blocked, no
 * screenshots — the rendered DOM goes back through the structured extractors.
 */
export function playwrightRenderer(opts: { timeoutMs?: number; maxConcurrent?: number; urlPolicy?: (url: string) => { ok: boolean } } = {}): Renderer & { close(): Promise<void> } {
  let browser: import("playwright").Browser | null = null;
  let active = 0;
  const max = opts.maxConcurrent ?? Number(process.env.RENDER_CONCURRENCY ?? 1);
  const ensure = async () => {
    if (browser) return browser;
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    return browser;
  };
  return {
    async render(url: string): Promise<string | null> {
      if (active >= max) return null; // never queue unbounded browser work
      active++;
      try {
        const b = await ensure();
        const ctx = await b.newContext({ userAgent: "OmnispiderMetadataBot/2.0 (+https://github.com/shep95/web-crawlers; respects robots.txt)", javaScriptEnabled: true });
        try {
          await ctx.route("**/*", (route) => {
            const req = route.request();
            if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
            return (opts.urlPolicy ?? checkUrl)(req.url()).ok ? route.continue() : route.abort();
          });
          const page = await ctx.newPage();
          await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs ?? 20_000 });
          return await page.content();
        } finally {
          await ctx.close();
        }
      } catch (err) {
        log.warn({ url, err: (err as Error).message }, "render_failed");
        return null;
      } finally {
        active--;
      }
    },
    async close() {
      await browser?.close().catch(() => undefined);
      browser = null;
    },
  };
}
