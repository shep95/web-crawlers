/**
 * Hosts the crawlers never enqueue and search never returns.
 *
 * The default keeps the Wikimedia family (Wikipedia, Wikidata, Commons, …) out of
 * the corpus so answers come from primary publishers rather than encyclopedia
 * mirrors. Operators override it with EXCLUDED_HOSTS (comma separated; a bare
 * domain also matches its subdomains). EXCLUDED_HOSTS=none disables the list.
 */
export const DEFAULT_EXCLUDED_HOSTS = [
  "wikipedia.org",
  "wikimedia.org",
  "wikidata.org",
  "wiktionary.org",
  "wikibooks.org",
  "wikiquote.org",
  "wikisource.org",
  "wikinews.org",
  "wikiversity.org",
  "wikivoyage.org",
  "mediawiki.org",
];

/** Discovery providers that only point at excluded hosts. */
export const EXCLUDED_PROVIDERS = new Set(["wikipedia", "wikidata"]);

let cached: { raw: string | undefined; list: string[] } | null = null;

export function excludedHosts(raw = process.env.EXCLUDED_HOSTS): string[] {
  if (cached && cached.raw === raw) return cached.list;
  const list =
    raw === undefined || raw.trim() === ""
      ? DEFAULT_EXCLUDED_HOSTS
      : raw.trim().toLowerCase() === "none"
        ? []
        : raw.split(",").map((h) => h.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
  cached = { raw, list };
  return list;
}

export function isExcludedHost(host: string, list = excludedHosts()): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isExcludedUrl(url: string, list = excludedHosts()): boolean {
  try {
    return isExcludedHost(new URL(url).hostname, list);
  } catch {
    return false;
  }
}
