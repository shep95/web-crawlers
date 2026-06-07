import type { TopicPageIntel, TopicReport, PageRecord } from "../core/models.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as cheerio from "cheerio";
import { extractPeopleDataFromText } from "./people-intel.js";

const STOPWORDS = new Set(["a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "about"]);
const LOCATION_TERMS = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "hampshire",
  "jersey", "mexico", "york", "carolina", "dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "wisconsin", "wyoming", "united", "states", "usa", "county", "city",
]);
const SOCIAL_DOMAINS = [
  "github.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "youtube.com",
  "threads.net",
  "discord.gg",
];

/** Site chrome / nav URLs that are never topic-connected. */
const NOISE_URL_PATTERNS = [
  /github\.com\/(?:features|marketplace|mcp|security|enterprise|team|solutions|resources|customer-stories|orgs|trust-center|partners|sponsors|accelerator|topics|why-github|login|signup|search|settings|explore|pricing|about|contact|site|trending|premium-support|user-attachments)/i,
  /github\.com\/collections/i,
  /x\.com\/(?:home|explore|login|i\/flow)/i,
];

export function isTopicNoiseUrl(url: string): boolean {
  const l = url.toLowerCase();
  if (/\.(png|jpg|jpeg|svg|gif|ico|webp)(\?|$)/.test(l)) return true;
  return NOISE_URL_PATTERNS.some((p) => p.test(l));
}

/** True when a discovered link should enter the crawl frontier for this topic. */
export function shouldFollowTopicLink(
  url: string,
  anchor: string,
  profile: TopicProfile,
  minScore: number,
): boolean {
  if (isTopicNoiseUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!SOCIAL_DOMAINS.some((d) => host.includes(d))) {
      return scoreLink(url, anchor, profile) >= minScore + 0.05;
    }
  } catch {
    return false;
  }
  return scoreLink(url, anchor, profile) >= minScore;
}

export class TopicProfile {
  readonly raw: string;
  readonly terms: string[];
  readonly phrases: string[];
  readonly primary: string;

  private constructor(raw: string, terms: string[], phrases: string[], primary: string) {
    this.raw = raw;
    this.terms = terms;
    this.phrases = phrases;
    this.primary = primary;
  }

  static parse(query: string): TopicProfile {
    const raw = query.trim();
    if (!raw) throw new Error("Topic query cannot be empty");
    const terms = [
      ...new Set(
        (raw.match(/[a-zA-Z0-9_@.-]+/g) ?? [])
          .filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()))
          .map((t) => t.toLowerCase()),
      ),
    ];
    const words = raw.split(/\s+/);
    const phrases: string[] = [];
    for (const size of [4, 3, 2]) {
      for (let i = 0; i <= words.length - size; i++) {
        const phrase = words.slice(i, i + size).join(" ").trim().toLowerCase();
        if (phrase.length > 4) phrases.push(phrase);
      }
    }
    const uniquePhrases = [...new Set(phrases)];
    return new TopicProfile(raw, terms, uniquePhrases, uniquePhrases[0] ?? terms[0] ?? raw.toLowerCase());
  }

  slugVariants(): string[] {
    const slugs: string[] = [];
    if (this.terms.length >= 2) {
      slugs.push(this.terms.slice(0, 2).join("-"));
      slugs.push(this.terms.slice(0, 3).join("-"));
      slugs.push(this.terms.slice(0, 2).join("_"));
    }
    for (const t of this.terms) if (t.length > 3) slugs.push(t);
    return [...new Set(slugs)];
  }
}

export function scoreText(text: string, profile: TopicProfile): number {
  if (!text) return 0;
  const lowered = text.toLowerCase();
  let score = 0;
  for (const phrase of profile.phrases.slice(0, 6)) {
    if (lowered.includes(phrase)) score += 0.35;
  }
  const hits = profile.terms.filter((t) => lowered.includes(t)).length;
  if (profile.terms.length) score += Math.min(0.55, (hits / profile.terms.length) * 0.55);
  return Math.min(1, score);
}

export function scoreUrl(url: string, profile: TopicProfile): number {
  let score = scoreText(url.toLowerCase(), profile);
  for (const slug of profile.slugVariants()) if (url.toLowerCase().includes(slug)) score += 0.25;
  for (const d of SOCIAL_DOMAINS) if (url.includes(d)) score += 0.05;
  return Math.min(1, score);
}

export function scoreLink(url: string, anchor: string, profile: TopicProfile): number {
  const combined = scoreUrl(url, profile) * 0.65 + scoreText(anchor, profile) * 0.35;
  return Math.min(1, combined + (SOCIAL_DOMAINS.some((d) => url.includes(d)) ? 0.08 : 0));
}

export function scorePage(url: string, title: string | null | undefined, body: string, profile: TopicProfile): number {
  return Math.min(
    1,
    scoreText(title ?? "", profile) * 0.35 +
      scoreText(body.slice(0, 120000), profile) * 0.45 +
      scoreUrl(url, profile) * 0.2,
  );
}

export function buildTopicSeeds(profile: TopicProfile, extraSeeds: string[] = []): string[] {
  const q = encodeURIComponent(profile.raw);
  const seeds = [
    `https://github.com/search?q=${q}&type=users`,
    `https://github.com/search?q=${q}&type=repositories`,
  ];
  for (const slug of profile.slugVariants().slice(0, 5)) {
    if (slug.includes("-") || slug.includes("_")) {
      seeds.push(`https://github.com/${slug}`);
      seeds.push(`https://x.com/${slug}`);
    }
  }
  for (const term of profile.terms) {
    if (term.length >= 5 && /^[a-z]+$/i.test(term) && !LOCATION_TERMS.has(term)) {
      seeds.push(`https://github.com/${term}`);
    }
  }
  seeds.push(...extraSeeds);
  return [...new Set(seeds.map((s) => new URL(s).toString()))];
}

export async function enrichSeedsFromGithubSearch(
  profile: TopicProfile,
  opts: { userAgent: string; timeoutMs: number },
): Promise<string[]> {
  const q = encodeURIComponent(profile.raw);
  const url = `https://github.com/search?q=${q}&type=users`;
  const found: string[] = [];
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { "User-Agent": opts.userAgent },
    });
    if (!resp.ok) return found;
    const html = await resp.text();
    const re = /href="\/([a-zA-Z0-9_-]{2,39})"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const username = m[1];
      if (["search", "settings", "explore", "login", "pricing"].includes(username.toLowerCase())) continue;
      const hits = profile.terms.filter((t) => username.toLowerCase().includes(t)).length;
      if (hits > 0) found.push(`https://github.com/${username}`);
    }
  } catch {
    /* skip */
  }
  return [...new Set(found)].slice(0, 15);
}

export function extractProfileUrlsFromHtml(html: string, baseUrl: string, profile: TopicProfile): string[] {
  const $ = cheerio.load(html);
  const candidates: Array<[number, string]> = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const link = new URL(href, baseUrl).toString();
      if (isTopicNoiseUrl(link)) return;
      const host = new URL(link).hostname;
      if (!SOCIAL_DOMAINS.some((d) => host.includes(d))) return;
      const anchor = $(el).text().replace(/\s+/g, " ").trim();
      const s = scoreLink(link, anchor, profile);
      if (s >= 0.15) candidates.push([s, link]);
    } catch {
      /* skip */
    }
  });
  candidates.sort((a, b) => b[0] - a[0]);
  return [...new Set(candidates.map((c) => c[1]))].slice(0, 20);
}

function isValidSocialLink(link: string): boolean {
  return !isTopicNoiseUrl(link);
}

export function extractPageIntel(
  url: string,
  html: string,
  profile: TopicProfile,
  relevance: number,
): TopicPageIntel {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const title = $("title").first().text().trim() || null;
  const text = $.root().text().replace(/\s+/g, " ");
  const metaDesc =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;
  const headings = ["h1", "h2", "h3"]
    .flatMap((tag) => $(tag).map((_, el) => $(el).text().trim()).get())
    .filter(Boolean)
    .slice(0, 10);
  const socialLinks = [
    ...new Set(
      (html.match(
        /https?:\/\/(?:www\.)?(?:github\.com\/(?!.*\.(?:png|jpg|svg))[^/\s"'<>]+|x\.com\/[^\s"'<>]+|twitter\.com\/[^\s"'<>]+|linkedin\.com\/in\/[^\s"'<>]+|instagram\.com\/[^\s"'<>]+|facebook\.com\/[^\s"'<>]+|tiktok\.com\/@[^\s"'<>]+|youtube\.com\/(?:@|c\/|user\/)[^\s"'<>]+|threads\.net\/@[^\s"'<>]+|discord\.gg\/[^\s"'<>]+)/gi,
      ) ?? []).filter(isValidSocialLink),
    ),
  ].slice(0, 20);
  let githubName: string | null = null;
  let githubBio: string | null = null;
  if (url.includes("github.com")) {
    githubName = $(".p-name").first().text().trim() || null;
    githubBio = $(".p-note").first().text().trim() || null;
  }
  const profileItems = $("li[itemprop]")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((t) => t.length < 200 && scoreText(t, profile) > 0)
    .slice(0, 8);
  const emails = [
    ...new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).slice(0, 5)),
  ];
  const people = extractPeopleDataFromText(text);
  for (const e of emails) if (!people.emails.includes(e)) people.emails.push(e);
  const snippets: string[] = [];
  for (const term of profile.terms) {
    if (term.length < 3) continue;
    let idx = text.toLowerCase().indexOf(term);
    while (idx >= 0 && snippets.length < 8) {
      snippets.push(text.slice(Math.max(0, idx - 80), idx + term.length + 120).trim());
      idx = text.toLowerCase().indexOf(term, idx + term.length);
    }
  }
  return {
    url,
    title,
    relevance: Math.round(relevance * 1000) / 1000,
    metaDescription: metaDesc,
    headings,
    socialLinks,
    locations: [...new Set(people.locations)].slice(0, 10),
    pastLocations: [...new Set(people.pastLocations)].slice(0, 10),
    origins: [...new Set(people.origins)].slice(0, 10),
    emails: [...new Set(people.emails)].slice(0, 8),
    phones: [...new Set(people.phones)].slice(0, 8),
    family: people.family.slice(0, 10),
    connections: people.connections.slice(0, 15),
    knowledgeDomains: [...new Set(people.knowledgeDomains)].slice(0, 15),
    employment: people.employment.slice(0, 10),
    pastEmployment: people.pastEmployment.slice(0, 10),
    businesses: people.businesses.slice(0, 10),
    government: [...new Set(people.government)].slice(0, 10),
    workplaces: people.workplaces.slice(0, 10),
    coworkers: people.coworkers.slice(0, 10),
    compensation: [...new Set(people.compensation)].slice(0, 8),
    githubName,
    githubBio,
    profileItems,
    snippets: [...new Set(snippets)].slice(0, 8),
  };
}

export function buildTopicReport(
  profile: TopicProfile,
  jobId: string,
  pages: PageRecord[],
  pagesCrawled: number,
  minRelevance = 0.12,
): TopicReport {
  const intelPages: TopicPageIntel[] = [];
  const seen = new Set<string>();
  const allSocial: string[] = [];
  const allSnippets: string[] = [];
  const relatedUrls: string[] = [];

  for (const page of pages) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    let body = "";
    if (page.contentPath) {
      try {
        body = readFileSync(page.contentPath, "utf8");
      } catch {
        /* skip */
      }
    }
    const relevance =
      (page.metadata?.topicRelevance as number | undefined) ??
      scorePage(page.url, page.title, body, profile);
    if (relevance < minRelevance) continue;
    const intel = extractPageIntel(page.url, body, profile, relevance);
    intelPages.push(intel);
    allSocial.push(...intel.socialLinks.filter(isValidSocialLink));
    allSnippets.push(...intel.snippets);
    relatedUrls.push(page.url);
  }
  intelPages.sort((a, b) => b.relevance - a.relevance);
  return {
    topic: profile.raw,
    jobId,
    pagesCrawled,
    relevantPages: intelPages.length,
    pages: intelPages,
    aggregatedSocialLinks: [...new Set(allSocial)],
    aggregatedLocations: [],
    aggregatedSnippets: [...new Set(allSnippets)].slice(0, 20),
    relatedUrls: [...new Set(relatedUrls)],
  };
}

export function formatReportText(report: TopicReport | import("../core/models.js").IntelligenceReport): string {
  const intel = report as import("../core/models.js").IntelligenceReport;
  const lines = [
    `Topic: ${report.topic}`,
    `Search type: ${intel.searchMode ?? "people"} (${intel.searchModeReason ?? ""})`,
    `Job: ${report.jobId}`,
    `Pages crawled: ${report.pagesCrawled} | Relevant: ${report.relevantPages}`,
  ];
  if (intel.executiveSummary) {
    lines.push("", "Executive summary", intel.executiveSummary);
  }
  if (intel.keyFindings?.length) {
    lines.push("", "Key findings");
    for (const f of intel.keyFindings.slice(0, 8)) lines.push(`  • ${f}`);
  }
  if (intel.crawlStats) {
    lines.push(
      "",
      `Crawl: ${intel.crawlStats.totalPages} pages (${intel.crawlStats.livePages} live, ${intel.crawlStats.archivePages} archive)`,
    );
    if (intel.crawlStats.saturated) lines.push("Status: all topic-connected links exhausted");
  }
  if (intel.sourceLinks?.length) {
    lines.push(`Source index: ${intel.sourceLinks.length} URLs crawled`);
  }
  if (intel.peopleMap) {
    const pm = intel.peopleMap;
    lines.push("", "People intelligence map");
    if (pm.locations.current.length) {
      lines.push(`  Locations: ${pm.locations.current.slice(0, 4).map((e) => e.value).join("; ")}`);
    }
    if (pm.locations.past.length) {
      lines.push(`  Past locations: ${pm.locations.past.slice(0, 4).map((e) => e.value).join("; ")}`);
    }
    if (pm.locations.origins.length) {
      lines.push(`  Origins: ${pm.locations.origins.slice(0, 4).map((e) => e.value).join("; ")}`);
    }
    if (pm.phones.length) lines.push(`  Phones: ${pm.phones.map((e) => e.value).join(", ")}`);
    if (pm.family.length) lines.push(`  Family: ${pm.family.slice(0, 4).map((e) => e.value).join("; ")}`);
    if (pm.connections.length) {
      lines.push(`  Connections: ${pm.connections.slice(0, 4).map((e) => e.value).join("; ")}`);
    }
    if (pm.knowledgeDomains.length) {
      lines.push(`  Expertise: ${pm.knowledgeDomains.slice(0, 4).map((e) => e.value).join("; ")}`);
    }
    if (pm.employment.current.length) {
      lines.push(`  Jobs: ${pm.employment.current.slice(0, 3).map((e) => e.value).join("; ")}`);
    }
    const st = pm.socialTrail;
    if (st.profiles.length) {
      lines.push(`  Social: ${st.profiles.slice(0, 4).map((p) => `${p.platform} ${p.profileUrl}`).join("; ")}`);
    }
    if (st.images.length) {
      lines.push(`  Social images: ${st.images.length} (${st.persona.selfPresentation.selfImageCount} likely self)`);
    }
    if (pm.organizationMap.length) {
      lines.push(
        `  Orgs: ${pm.organizationMap.slice(0, 3).map((o) => `${o.name}${o.isLikelyOwnedBySubject ? " (owned)" : ""}`).join("; ")}`,
      );
    }
    if (pm.temporal.inferences.length) {
      lines.push(`  Job changes: ${pm.temporal.inferences.slice(0, 2).join("; ")}`);
    }
  }
  lines.push("");
  if (report.aggregatedSocialLinks.length) {
    lines.push("Social / profile links");
    for (const l of report.aggregatedSocialLinks.slice(0, 15)) lines.push(`  - ${l}`);
    lines.push("");
  }
  lines.push("Relevant pages");
  for (const p of report.pages.slice(0, 15)) {
    lines.push(`\n[${p.relevance.toFixed(2)}] ${p.url}`);
    if (p.title) lines.push(`  Title: ${p.title.slice(0, 140)}`);
    if (p.githubName) lines.push(`  GitHub name: ${p.githubName}`);
    if (p.githubBio) lines.push(`  GitHub bio: ${p.githubBio.slice(0, 160)}`);
    if (p.knowledgeDomains?.length) {
      lines.push(`  Expertise: ${p.knowledgeDomains.slice(0, 4).join(", ")}`);
    }
    if (p.employment?.length) {
      lines.push(`  Employment: ${p.employment.slice(0, 2).map((j) => `${j.role} @ ${j.company}`).join("; ")}`);
    }
    for (const item of p.profileItems.slice(0, 5)) lines.push(`  - ${item.slice(0, 120)}`);
    for (const s of p.snippets.slice(0, 2)) lines.push(`  > ${s.slice(0, 200)}`);
  }
  return lines.join("\n");
}

export function saveReport(report: TopicReport, path: string): void {
  mkdirSync(path.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
}

export async function runTopicLookup(
  config: import("../core/config.js").AppConfig,
  security: import("../security/nomad.js").NomadSecurityStack | null,
  opts: {
    topic: string;
    extraSeeds?: string[];
    maxDepth?: number;
    maxPages?: number;
    minRelevance?: number;
    minLinkScore?: number;
    followWaves?: number;
    jsRendering?: boolean;
    exhaustive?: boolean;
    includeArchive?: boolean;
    searchMode?: "people" | "knowledge" | "auto";
    linkedDepth?: number;
    maxLinkedPersons?: number;
    linkedMaxPages?: number;
    onProgress?: (message: string) => void;
  },
): Promise<import("../core/models.js").IntelligenceReport> {
  const { runIntelligenceLookup } = await import("./intelligence.js");
  return runIntelligenceLookup(config, security, {
    topic: opts.topic,
    extraSeeds: opts.extraSeeds,
    maxDepth: opts.maxDepth,
    maxPages: opts.maxPages,
    minRelevance: opts.minRelevance,
    minLinkScore: opts.minLinkScore,
    exhaustive: opts.exhaustive ?? true,
    includeArchive: opts.includeArchive ?? true,
    searchMode: opts.searchMode ?? "auto",
    jsRendering: opts.jsRendering,
    linkedDepth: opts.linkedDepth,
    maxLinkedPersons: opts.maxLinkedPersons,
    linkedMaxPages: opts.linkedMaxPages,
    onProgress: opts.onProgress,
  });
}
