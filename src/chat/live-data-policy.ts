import type { PageRecord } from "../core/models.js";
import type { ChatDocument } from "./algorithm-chatbot.js";

/** Blocked hosts — never use test, local, or placeholder URLs as training/retrieval corpus. */
const BLOCKED_HOSTS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "test",
  "invalid",
]);

const BLOCKED_PATH_RE =
  /(?:^|[\\/])(?:tests?|fixtures?|mocks?|data[\\/]reports|__tests__|node_modules)(?:[\\/]|$)/i;

const BLOCKED_SCHEMES = /^(?:file|data|blob|javascript|about):/i;

export function isBlockedLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (BLOCKED_SCHEMES.test(trimmed)) return true;
  if (BLOCKED_PATH_RE.test(trimmed)) return true;
  if (/\.(?:test|spec)\.[a-z]+$/i.test(trimmed)) return true;
  return false;
}

export function isLiveHttpUrl(url: string): boolean {
  if (isBlockedLocalPath(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return false;
    if (host.endsWith(".local") || host.endsWith(".test") || host.endsWith(".localhost")) return false;
    if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (BLOCKED_PATH_RE.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function assertLiveSeeds(seeds: string[]): string[] {
  const live = seeds.map((s) => s.trim()).filter(Boolean);
  if (!live.length) {
    throw new Error("LIVE_SEEDS_REQUIRED — provide domain or https seed URLs");
  }
  for (const seed of live) {
    if (isBlockedLocalPath(seed)) {
      throw new Error(`BLOCKED_LOCAL_SOURCE — cannot use test or local paths: ${seed}`);
    }
    if (!isLiveHttpUrl(seed)) {
      throw new Error(`LIVE_URL_REQUIRED — seed must be a public http(s) URL: ${seed}`);
    }
  }
  return live;
}

export function isLivePage(page: PageRecord): boolean {
  if (page.source !== "live") return false;
  const url = page.finalUrl ?? page.url;
  return isLiveHttpUrl(url);
}

/** Convert crawled pages to chat corpus — live web only, never archive or local files. */
export function pagesToLiveDocuments(
  pages: Array<PageRecord & { text: string }>,
): ChatDocument[] {
  return pages
    .filter((p) => isLivePage(p) && p.text.length >= 80)
    .map((p) => ({
      text: p.text,
      url: p.finalUrl ?? p.url,
      title: p.title ?? p.url,
      source: "live" as const,
      fetchedAt: p.fetchedAt,
    }));
}

export function assertLiveDocuments(documents: ChatDocument[]): ChatDocument[] {
  const live = documents.filter((d) => d.source === "live" && isLiveHttpUrl(d.url));
  if (!live.length && documents.length) {
    throw new Error("LIVE_DATA_REQUIRED — no live web pages in corpus (archive/test sources rejected)");
  }
  return live;
}
