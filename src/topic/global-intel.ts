import type {
  GlobalKnowledgeCoverage,
  IntelligenceEntity,
  RegionalPerspective,
  TopicPageIntel,
} from "../core/models.js";

export interface GlobalRegion {
  code: string;
  name: string;
  wikiLang: string;
  tlds: string[];
  domains: string[];
  /** ISO 639-1 hints for html lang attributes */
  langHints: string[];
}

/** Priority regions the algorithm actively seeks perspectives from. */
export const GLOBAL_REGIONS: GlobalRegion[] = [
  {
    code: "GLOBAL",
    name: "Global (English)",
    wikiLang: "en",
    tlds: [".org", ".int"],
    domains: ["wikipedia.org", "britannica.com", "bbc.com", "reuters.com"],
    langHints: ["en"],
  },
  {
    code: "IN",
    name: "India",
    wikiLang: "hi",
    tlds: [".in"],
    domains: ["timesofindia.indiatimes.com", "thehindu.com", "indiatoday.in", "livemint.com"],
    langHints: ["hi", "en-in", "bn", "ta", "te", "mr"],
  },
  {
    code: "CN",
    name: "China",
    wikiLang: "zh",
    tlds: [".cn"],
    domains: ["163.com", "sina.com.cn", "xinhuanet.com", "people.com.cn", "baidu.com"],
    langHints: ["zh", "zh-cn", "zh-hans"],
  },
  {
    code: "RU",
    name: "Russia",
    wikiLang: "ru",
    tlds: [".ru"],
    domains: ["tass.com", "ria.ru", "rt.com", "kommersant.ru"],
    langHints: ["ru"],
  },
  {
    code: "JP",
    name: "Japan",
    wikiLang: "ja",
    tlds: [".jp"],
    domains: ["nhk.or.jp", "asahi.com", "mainichi.jp"],
    langHints: ["ja"],
  },
  {
    code: "DE",
    name: "Germany / EU (German)",
    wikiLang: "de",
    tlds: [".de"],
    domains: ["dw.com", "spiegel.de", "zeit.de"],
    langHints: ["de"],
  },
  {
    code: "BR",
    name: "Brazil / Latin America (Portuguese)",
    wikiLang: "pt",
    tlds: [".br"],
    domains: ["globo.com", "uol.com.br"],
    langHints: ["pt", "pt-br"],
  },
  {
    code: "SA",
    name: "Middle East (Arabic)",
    wikiLang: "ar",
    tlds: [".sa", ".ae", ".eg"],
    domains: ["aljazeera.com", "arabnews.com"],
    langHints: ["ar"],
  },
  {
    code: "KR",
    name: "South Korea",
    wikiLang: "ko",
    tlds: [".kr"],
    domains: ["yna.co.kr", "koreaherald.com"],
    langHints: ["ko"],
  },
  {
    code: "FR",
    name: "France / Francophone",
    wikiLang: "fr",
    tlds: [".fr"],
    domains: ["lemonde.fr", "france24.com"],
    langHints: ["fr"],
  },
];

const REGION_BY_CODE = new Map(GLOBAL_REGIONS.map((r) => [r.code, r]));
const REGION_BY_WIKI = new Map(GLOBAL_REGIONS.map((r) => [r.wikiLang, r]));

const CYRILLIC = /[\u0400-\u04FF]/;
const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
const DEVANAGARI = /[\u0900-\u097F]/;
const ARABIC = /[\u0600-\u06FF]/;
const HANGUL = /[\uAC00-\uD7AF]/;
const KANA = /[\u3040-\u30FF]/;

function extractHtmlLang(html: string): string | undefined {
  const m = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);
  return m?.[1]?.toLowerCase();
}

function scriptRegionHint(text: string): GlobalRegion | undefined {
  const sample = text.slice(0, 8000);
  if (CYRILLIC.test(sample)) return REGION_BY_CODE.get("RU");
  if (CJK.test(sample)) return REGION_BY_CODE.get("CN");
  if (DEVANAGARI.test(sample)) return REGION_BY_CODE.get("IN");
  if (ARABIC.test(sample)) return REGION_BY_CODE.get("SA");
  if (HANGUL.test(sample)) return REGION_BY_CODE.get("KR");
  if (KANA.test(sample)) return REGION_BY_CODE.get("JP");
  return undefined;
}

function regionFromHostname(host: string): GlobalRegion | undefined {
  const h = host.toLowerCase();
  for (const region of GLOBAL_REGIONS) {
    if (region.domains.some((d) => h === d || h.endsWith(`.${d}`) || h.endsWith(d))) {
      return region;
    }
    for (const tld of region.tlds) {
      if (h.endsWith(tld)) return region;
    }
  }
  const wikiMatch = h.match(/^(?:([a-z]{2,3})\.)?wikipedia\.org$/);
  if (wikiMatch?.[1]) {
    return REGION_BY_WIKI.get(wikiMatch[1]) ?? REGION_BY_CODE.get("GLOBAL");
  }
  if (h.includes("wikipedia.org")) return REGION_BY_CODE.get("GLOBAL");
  return undefined;
}

function regionFromLang(lang: string): GlobalRegion | undefined {
  const base = lang.split("-")[0];
  for (const region of GLOBAL_REGIONS) {
    if (region.langHints.some((h) => h === lang || h === base || lang.startsWith(`${h}-`))) {
      return region;
    }
  }
  if (base === "en") return REGION_BY_CODE.get("GLOBAL");
  return REGION_BY_WIKI.get(base);
}

/** Infer which region a page most likely represents. */
export function inferSourceRegion(
  url: string,
  textHint?: string,
): { region: GlobalRegion; language?: string } {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }

  const fromHost = regionFromHostname(host);
  if (fromHost && fromHost.code !== "GLOBAL") {
    return { region: fromHost, language: fromHost.langHints[0] };
  }

  if (textHint) {
    const lang = extractHtmlLang(textHint);
    if (lang) {
      const fromLang = regionFromLang(lang);
      if (fromLang) return { region: fromLang, language: lang };
    }
    const fromScript = scriptRegionHint(textHint);
    if (fromScript) return { region: fromScript, language: fromScript.langHints[0] };
  }

  if (fromHost) return { region: fromHost, language: fromHost.langHints[0] };
  return { region: REGION_BY_CODE.get("GLOBAL")!, language: "en" };
}

export function buildGlobalKnowledgeSeeds(topic: string): string[] {
  const q = encodeURIComponent(topic.trim());
  const seeds: string[] = [];

  for (const region of GLOBAL_REGIONS) {
    seeds.push(`https://${region.wikiLang}.wikipedia.org/wiki/Special:Search?search=${q}&fulltext=1`);
  }

  seeds.push(`https://www.wikidata.org/w/index.php?search=${q}`);
  seeds.push(`https://github.com/search?q=${q}&type=repositories`);

  return [...new Set(seeds)];
}

export function collectGlobalPerspectiveSeeds(
  topic: string,
  crawledUrls: Set<string>,
  underrepresented: string[],
): string[] {
  const q = encodeURIComponent(topic.trim());
  const seeds: string[] = [];

  for (const code of underrepresented) {
    const region = REGION_BY_CODE.get(code);
    if (!region) continue;
    const wikiSeed = `https://${region.wikiLang}.wikipedia.org/wiki/Special:Search?search=${q}&fulltext=1`;
    if (!crawledUrls.has(wikiSeed.toLowerCase())) seeds.push(wikiSeed);
    for (const domain of region.domains.slice(0, 2)) {
      const portal = `https://${domain}/search?q=${q}`;
      if (!crawledUrls.has(portal.toLowerCase())) seeds.push(portal);
    }
  }

  return [...new Set(seeds)].slice(0, 24);
}

function uniqueStrings(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (!key || key.length < 12 || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
    if (out.length >= max) break;
  }
  return out;
}

function extractClaimsFromPage(page: TopicPageIntel): string[] {
  const claims: string[] = [];
  if (page.metaDescription && page.metaDescription.length >= 30) {
    claims.push(page.metaDescription.slice(0, 240));
  }
  for (const s of page.snippets.slice(0, 3)) {
    if (s.length >= 40) claims.push(s.slice(0, 240));
  }
  if (page.title && page.title.length >= 15) claims.push(page.title.slice(0, 160));
  return claims;
}

export function buildRegionalPerspectives(
  topic: string,
  intelPages: TopicPageIntel[],
  loadBody?: (url: string, page?: TopicPageIntel) => string,
): RegionalPerspective[] {
  const buckets = new Map<string, { region: GlobalRegion; pages: TopicPageIntel[]; languages: Set<string> }>();

  for (const page of intelPages) {
    const body = loadBody?.(page.url, page) ?? "";
    const { region, language } = inferSourceRegion(page.url, body || [page.title, page.metaDescription].join(" "));
    const bucket = buckets.get(region.code) ?? { region, pages: [], languages: new Set<string>() };
    bucket.pages.push(page);
    if (language) bucket.languages.add(language);
    buckets.set(region.code, bucket);
  }

  const perspectives: RegionalPerspective[] = [];

  for (const { region, pages, languages } of buckets.values()) {
    const themes = uniqueStrings(
      pages.flatMap((p) => p.headings.filter((h) => h.length >= 8 && h.length <= 120)),
      12,
    );
    const keyClaims = uniqueStrings(pages.flatMap(extractClaimsFromPage), 8);
    const snippets = uniqueStrings(
      pages.flatMap((p) => p.snippets.filter((s) => s.length >= 30)),
      5,
    );

    const sources: IntelligenceEntity[] = pages
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 8)
      .map((p) => ({
        type: "url" as const,
        value: p.url,
        confidence: Math.min(0.95, 0.35 + p.relevance),
        sources: [p.url],
        context: p.title ?? region.name,
      }));

    perspectives.push({
      region: region.name,
      regionCode: region.code,
      language: [...languages][0] ?? region.langHints[0],
      themes,
      keyClaims,
      sources,
      pageCount: pages.length,
      representativeSnippets: snippets,
    });
  }

  return perspectives.sort((a, b) => b.pageCount - a.pageCount);
}

export function assessGlobalCoverage(
  perspectives: RegionalPerspective[],
  priorityCodes: string[] = ["IN", "CN", "RU", "JP", "DE", "BR", "SA", "KR", "FR"],
): GlobalKnowledgeCoverage {
  const represented = perspectives
    .filter((p) => p.pageCount > 0 && p.regionCode !== "GLOBAL")
    .map((p) => p.regionCode);
  const globalPresent = perspectives.some((p) => p.regionCode === "GLOBAL" && p.pageCount > 0);
  const regionsRepresented = [...new Set(represented)];
  if (globalPresent && !regionsRepresented.includes("GLOBAL")) regionsRepresented.unshift("GLOBAL");

  const underrepresentedRegions = priorityCodes.filter(
    (code) => !regionsRepresented.includes(code),
  );

  return {
    regionsRepresented,
    underrepresentedRegions,
    totalRegionalSources: perspectives.reduce((sum, p) => sum + p.pageCount, 0),
  };
}

export function globalPerspectiveSnapshotKeys(perspectives: RegionalPerspective[]): string[] {
  return perspectives.flatMap((p) => [
    p.regionCode,
    String(p.pageCount),
    ...p.themes.slice(0, 5),
    ...p.keyClaims.slice(0, 3),
    ...p.sources.slice(0, 3).map((s) => s.value),
  ]);
}

export function emptyGlobalCoverage(): GlobalKnowledgeCoverage {
  return {
    regionsRepresented: [],
    underrepresentedRegions: GLOBAL_REGIONS.filter((r) => r.code !== "GLOBAL").map((r) => r.code),
    totalRegionalSources: 0,
  };
}

export function formatRegionalPerspectivesMarkdown(perspectives: RegionalPerspective[]): string[] {
  const lines = ["## Global Perspectives", ""];
  if (!perspectives.length) {
    lines.push("_No regional perspectives extracted yet — run with more pages or add regional --seed URLs._", "");
    return lines;
  }

  for (const p of perspectives) {
    lines.push(`### ${p.region} (${p.regionCode})`, "");
    if (p.language) lines.push(`**Language signal:** ${p.language}`, "");
    lines.push(`**Sources analyzed:** ${p.pageCount}`, "");
    if (p.themes.length) {
      lines.push("**Themes:**", "");
      for (const t of p.themes.slice(0, 8)) lines.push(`- ${t}`);
      lines.push("");
    }
    if (p.keyClaims.length) {
      lines.push("**How this region frames the topic:**", "");
      for (const c of p.keyClaims.slice(0, 5)) lines.push(`- ${c.slice(0, 220)}`);
      lines.push("");
    }
    if (p.sources.length) {
      lines.push("**Representative sources:**", "");
      for (const s of p.sources.slice(0, 5)) lines.push(`- [${(s.confidence * 100).toFixed(0)}%] ${s.value}`);
      lines.push("");
    }
  }
  return lines;
}
