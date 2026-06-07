import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { AppConfig } from "../core/config.js";
import type {
  IntelligenceEntity,
  IntelligenceNetworkEdge,
  IntelligenceReport,
  IntelligenceTimelineEvent,
  HistoricalSnapshot,
  PageRecord,
  TopicPageIntel,
} from "../core/models.js";
import type { NomadSecurityStack } from "../security/nomad.js";
import { ArchiveEngine } from "../engines/registry.js";
import {
  TopicProfile,
  buildTopicReport,
  extractPageIntel,
  isTopicNoiseUrl,
  scorePage,
} from "./index.js";
import {
  buildPeopleMap,
  emptyPeopleMap,
  formatPeopleMapMarkdown,
} from "./people-intel.js";
import { buildSocialTrail } from "./social-trail.js";
import { buildOrganizationIntelMap } from "./org-intel.js";
import {
  KNOWLEDGE_RUNNERS,
  PEOPLE_RUNNERS,
  buildInitialGraphSeeds,
  createRunnerContext,
  runIntelligenceRunners,
} from "./intelligence-runners.js";
import { buildTemporalIntelligence } from "./temporal-intel.js";
import {
  buildHouseholdMap,
  emptyHouseholdMap,
  formatHouseholdMarkdown,
  formatLinkedPersonsMarkdown,
  runLinkedPersonAgents,
} from "./household-intel.js";
import {
  buildKnowledgeMap,
  emptyKnowledgeMap,
  formatKnowledgeMapMarkdown,
} from "./knowledge-intel.js";
import { resolveSearchMode } from "./search-mode.js";
import type { SearchMode as SearchModeType } from "../core/models.js";

const HANDLE_RE = /(?:@|x\.com\/|twitter\.com\/)([a-zA-Z0-9_]{2,30})/gi;
const LOCATION_PATTERNS = [
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}),?\s+(Alabama|AL|Alaska|AK|Arizona|AZ|Arkansas|AR|California|CA|Colorado|CO|Connecticut|CT|Delaware|DE|Florida|FL|Georgia|GA|Hawaii|HI|Idaho|ID|Illinois|IL|Indiana|IN|Iowa|IA|Kansas|KS|Kentucky|KY|Louisiana|LA|Maine|ME|Maryland|MD|Massachusetts|MA|Michigan|MI|Minnesota|MN|Mississippi|MS|Missouri|MO|Montana|MT|Nebraska|NE|Nevada|NV|New Hampshire|NH|New Jersey|NJ|New Mexico|NM|New York|NY|North Carolina|NC|North Dakota|ND|Ohio|OH|Oklahoma|OK|Oregon|OR|Pennsylvania|PA|Rhode Island|RI|South Carolina|SC|South Dakota|SD|Tennessee|TN|Texas|TX|Utah|UT|Vermont|VT|Virginia|VA|Washington|WA|West Virginia|WV|Wisconsin|WI|Wyoming|WY|United States|USA)\b/g,
];

export interface IntelligenceOptions {
  topic: string;
  extraSeeds?: string[];
  maxDepth?: number;
  /** 0 = use config orchestrator max_pages_per_job */
  maxPages?: number;
  minRelevance?: number;
  minLinkScore?: number;
  /** Keep expanding until no new relevant URLs (bounded by maxPages) */
  exhaustive?: boolean;
  includeArchive?: boolean;
  jsRendering?: boolean;
  /** people = human intel map; knowledge = domain map; auto = detect */
  searchMode?: "people" | "knowledge" | "auto";
  /** Spawn sub-lookups for co-residents / household members (people mode) */
  linkedDepth?: number;
  maxLinkedPersons?: number;
  /** Safety page cap per linked-person agent (0 = config max); saturation stops first */
  linkedMaxPages?: number;
  onProgress?: (message: string) => void;
}

function progress(opts: IntelligenceOptions, msg: string): void {
  opts.onProgress?.(msg);
}

function pageLimit(config: AppConfig, opts: IntelligenceOptions): number {
  const requested = opts.maxPages ?? 0;
  return requested > 0 ? requested : config.orchestrator.maxPagesPerJob;
}

function loadBody(page: PageRecord): string {
  if (!page.contentPath) return "";
  try {
    return readFileSync(page.contentPath, "utf8");
  } catch {
    return "";
  }
}

export async function discoverWaybackSeeds(
  profile: TopicProfile,
  config: AppConfig,
): Promise<Array<{ url: string; timestamp: string }>> {
  const archive = new ArchiveEngine(config);
  const found: Array<{ url: string; timestamp: string }> = [];
  const patterns = new Set<string>();

  for (const slug of profile.slugVariants().slice(0, 8)) {
    patterns.add(`*${slug}*`);
    patterns.add(`github.com/*${slug}*`);
    patterns.add(`*github.com/${slug}*`);
  }
  for (const term of profile.terms) {
    if (term.length >= 4) patterns.add(`*${term}*`);
  }

  for (const pattern of patterns) {
    const snaps = await archive.searchSnapshots(pattern, 15);
    for (const s of snaps) found.push({ url: s.original, timestamp: s.timestamp });
  }
  return found;
}

function extractEntitiesFromIntel(intel: TopicPageIntel, profile: TopicProfile): IntelligenceEntity[] {
  const entities: IntelligenceEntity[] = [];
  const src = intel.url;
  const conf = Math.min(0.95, 0.4 + intel.relevance);

  if (intel.githubName) {
    entities.push({ type: "name", value: intel.githubName, confidence: conf, sources: [src] });
  }
  if (intel.title) {
    const nameMatch = intel.title.match(/\(([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\)/);
    if (nameMatch) {
      entities.push({ type: "name", value: nameMatch[1], confidence: conf * 0.9, sources: [src] });
    }
  }
  for (const item of intel.profileItems) {
    if (/^#/.test(item)) {
      entities.push({ type: "alias", value: item, confidence: conf * 0.85, sources: [src] });
    }
    if (/^X @/.test(item) || /^@/.test(item)) {
      const handle = item.replace(/^X @/, "@");
      entities.push({ type: "handle", value: handle, confidence: conf * 0.9, sources: [src] });
    }
    for (const pattern of LOCATION_PATTERNS) {
      for (const m of item.matchAll(pattern)) {
        entities.push({ type: "location", value: m[0].trim(), confidence: conf * 0.8, sources: [src] });
      }
    }
  }
  for (const email of intel.emails) {
    entities.push({ type: "email", value: email, confidence: conf * 0.85, sources: [src] });
  }
  for (const phone of intel.phones ?? []) {
    entities.push({ type: "phone", value: phone, confidence: conf * 0.85, sources: [src], context: "extracted" });
  }
  for (const loc of intel.locations) {
    entities.push({ type: "location", value: loc, confidence: conf * 0.8, sources: [src], context: "current" });
  }
  for (const loc of intel.pastLocations ?? []) {
    entities.push({ type: "past_location", value: loc, confidence: conf * 0.75, sources: [src], context: "former" });
  }
  for (const origin of intel.origins ?? []) {
    entities.push({ type: "origin", value: origin, confidence: conf * 0.75, sources: [src], context: "origin" });
  }
  for (const f of intel.family ?? []) {
    entities.push({
      type: "family",
      value: `${f.relation}: ${f.name}`,
      confidence: conf * 0.7,
      sources: [src],
      context: f.relation,
    });
  }
  for (const c of intel.connections ?? []) {
    entities.push({
      type: "connection",
      value: c.url ? `${c.type}: ${c.name} (${c.url})` : `${c.type}: ${c.name}`,
      confidence: conf * 0.72,
      sources: [src],
      context: c.type,
    });
  }
  for (const link of intel.socialLinks) {
    if (/github\.com\/[^/]+$/i.test(link)) {
      entities.push({ type: "url", value: link, confidence: conf * 0.75, sources: [src] });
    }
    for (const m of link.matchAll(HANDLE_RE)) {
      entities.push({ type: "handle", value: `@${m[1]}`, confidence: conf * 0.7, sources: [src] });
    }
  }
  const blob = [intel.title, intel.githubBio, intel.metaDescription, ...intel.snippets].join(" ");
  for (const pattern of LOCATION_PATTERNS) {
    for (const m of blob.matchAll(pattern)) {
      entities.push({ type: "location", value: m[0].trim(), confidence: conf * 0.75, sources: [src] });
    }
  }
  for (const term of profile.terms) {
    if (scorePage(intel.url, intel.title, blob, profile) > 0.2 && intel.url.includes(term)) {
      entities.push({ type: "url", value: intel.url, confidence: conf, sources: [src] });
    }
  }
  return entities;
}

function mergeEntities(entities: IntelligenceEntity[]): IntelligenceEntity[] {
  const map = new Map<string, IntelligenceEntity>();
  for (const e of entities) {
    const key = `${e.type}:${e.value.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...e, sources: [...new Set(e.sources)] });
    } else {
      existing.confidence = Math.max(existing.confidence, e.confidence);
      existing.sources = [...new Set([...existing.sources, ...e.sources])];
    }
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

function buildNetworkGraph(pages: TopicPageIntel[]): IntelligenceNetworkEdge[] {
  const edges: IntelligenceNetworkEdge[] = [];
  const top = pages.slice(0, 20);
  for (const page of top) {
    for (const link of page.socialLinks) {
      if (link === page.url) continue;
      edges.push({ from: page.url, to: link, relation: "links_to" });
    }
    for (const item of page.profileItems) {
      if (/^X @/.test(item) || /^@/.test(item)) {
        edges.push({ from: page.url, to: item, relation: "profile_handle" });
      }
    }
  }
  return edges.slice(0, 100);
}

function buildTimeline(
  pages: PageRecord[],
  intelPages: TopicPageIntel[],
  historical: HistoricalSnapshot[],
): IntelligenceTimelineEvent[] {
  const events: IntelligenceTimelineEvent[] = [];

  for (const h of historical) {
    const y = h.timestamp.slice(0, 4);
    const mo = h.timestamp.slice(4, 6);
    const d = h.timestamp.slice(6, 8);
    events.push({
      date: `${y}-${mo}-${d}`,
      label: "Wayback snapshot",
      source: h.url,
      detail: h.title ?? h.snippets[0]?.slice(0, 120),
    });
  }

  for (const page of pages.filter((p) => p.source === "live")) {
    events.push({
      date: page.fetchedAt.slice(0, 10),
      label: "Live capture",
      source: page.url,
      detail: page.title ?? undefined,
    });
  }

  for (const intel of intelPages.slice(0, 10)) {
    for (const s of intel.snippets.slice(0, 2)) {
      if (/discord|linkedin|github|twitter|x\.com/i.test(s)) {
        events.push({ date: "present", label: "Profile mention", source: intel.url, detail: s.slice(0, 150) });
      }
    }
  }

  return events
    .sort((a, b) => (a.date === "present" ? "9999" : a.date).localeCompare(b.date === "present" ? "9999" : b.date))
    .slice(0, 50);
}

function buildKeyFindings(
  profile: TopicProfile,
  pages: TopicPageIntel[],
  entities: IntelligenceEntity[],
  peopleMap: import("../core/models.js").PeopleIntelligenceMap,
): string[] {
  const findings: string[] = [];
  const names = entities.filter((e) => e.type === "name");
  const handles = entities.filter((e) => e.type === "handle");

  if (names.length) {
    findings.push(`Identified name variants: ${names.slice(0, 5).map((n) => n.value).join(", ")}`);
  }
  if (handles.length) {
    findings.push(`Social handles: ${handles.slice(0, 8).map((h) => h.value).join(", ")}`);
  }
  if (peopleMap.locations.current.length) {
    findings.push(`Current locations: ${peopleMap.locations.current.slice(0, 5).map((l) => l.value).join("; ")}`);
  }
  if (peopleMap.locations.past.length) {
    findings.push(`Past locations: ${peopleMap.locations.past.slice(0, 4).map((l) => l.value).join("; ")}`);
  }
  if (peopleMap.locations.origins.length) {
    findings.push(`Origins/hometown: ${peopleMap.locations.origins.slice(0, 4).map((o) => o.value).join("; ")}`);
  }
  if (peopleMap.knowledgeDomains.length) {
    findings.push(`Expertise niches: ${peopleMap.knowledgeDomains.slice(0, 5).map((d) => d.value).join("; ")}`);
  }
  if (peopleMap.employment.current.length) {
    findings.push(`Current employment: ${peopleMap.employment.current.slice(0, 3).map((e) => e.value).join("; ")}`);
  }
  if (peopleMap.employment.past.length) {
    findings.push(`Past jobs: ${peopleMap.employment.past.slice(0, 3).map((e) => e.value).join("; ")}`);
  }
  if (peopleMap.businesses.length) {
    findings.push(`Businesses/LLCs: ${peopleMap.businesses.slice(0, 3).map((e) => e.value).join("; ")}`);
  }
  if (peopleMap.government.length) {
    findings.push(`Government presence: ${peopleMap.government.slice(0, 3).map((e) => e.value).join("; ")}`);
  }
  if (peopleMap.phones.length) {
    findings.push(`Phone numbers: ${peopleMap.phones.map((p) => p.value).join(", ")}`);
  }
  if (peopleMap.family.length) {
    findings.push(`Family mentions: ${peopleMap.family.slice(0, 4).map((f) => f.value).join("; ")}`);
  }
  if (peopleMap.coworkers.length) {
    findings.push(`Co-workers: ${peopleMap.coworkers.slice(0, 4).map((c) => c.value).join("; ")}`);
  }
  if (peopleMap.workplaces.length) {
    findings.push(`Workplaces: ${peopleMap.workplaces.slice(0, 3).map((w) => w.value).join("; ")}`);
  }
  if (peopleMap.employment.compensation.length) {
    findings.push(`Compensation signals: ${peopleMap.employment.compensation.map((c) => c.value).join("; ")}`);
  }
  if (pages.length) {
    findings.push(`Top presence: ${pages.slice(0, 3).map((p) => p.url).join(" · ")}`);
  }
  if (peopleMap.historicData.length) {
    findings.push(`Historic captures: ${peopleMap.historicData.length} archival snapshot(s) analyzed.`);
  }
  const trail = peopleMap.socialTrail;
  if (trail.profiles.length) {
    findings.push(
      `Social profiles: ${trail.profiles.slice(0, 6).map((p) => `${p.platform} (${p.profileUrl})`).join("; ")}`,
    );
  }
  if (trail.posts.filter((p) => !p.isRepost).length) {
    findings.push(
      `${trail.posts.filter((p) => !p.isRepost).length} original social post(s) analyzed (${trail.posts.filter((p) => p.isRepost).length} reposts excluded).`,
    );
  }
  if (trail.images.length) {
    findings.push(
      `${trail.images.length} image(s) from original posts${trail.persona.selfPresentation.postsImagesOfSelf ? ` — ${trail.persona.selfPresentation.selfImageCount} likely self-images` : ""}.`,
    );
  }
  if (trail.persona.themes.length) {
    findings.push(`Content themes: ${trail.persona.themes.slice(0, 5).join(", ")}.`);
  }
  for (const org of peopleMap.organizationMap.slice(0, 3)) {
    const kind = org.isLikelyOwnedBySubject ? "owned business" : "employer/external";
    const reg = org.isRegisteredEntity ? ` (${org.legalForm ?? "registered"})` : "";
    findings.push(`${org.name}: ${kind}${reg}${org.ownershipReason ? ` — ${org.ownershipReason}` : ""}`);
  }
  if (peopleMap.temporal.inferences.length) {
    findings.push(`Job transitions: ${peopleMap.temporal.inferences.slice(0, 2).join("; ")}`);
  }
  if (peopleMap.temporal.employmentTimeline.length) {
    const current = peopleMap.temporal.employmentTimeline.find(
      (t) => t.status === "current" || t.status === "inferred_current",
    );
    if (current) {
      findings.push(
        `Dated employment: ${current.company}${current.startDate ? ` from ${current.startDate}` : ""}${current.endDate ? ` until ${current.endDate}` : " (current)"}`,
      );
    }
  }
  const home = peopleMap.household?.homeAddresses?.filter((a) => a.status === "current") ?? [];
  if (home.length) {
    findings.push(`Home address: ${home[0].address}`);
  }
  const residents = peopleMap.household?.members?.filter((m) => m.status === "current_resident") ?? [];
  if (residents.length) {
    findings.push(`Co-residents: ${residents.slice(0, 4).map((m) => m.name).join(", ")}`);
  }
  if (peopleMap.household?.moveHistory?.length) {
    findings.push(`Move events: ${peopleMap.household.moveHistory.slice(0, 2).map((m) => `${m.member}${m.date ? ` (${m.date})` : ""}`).join("; ")}`);
  }
  if (peopleMap.household?.familyPhones?.length) {
    findings.push(`Family phones: ${peopleMap.household.familyPhones.slice(0, 3).map((p) => p.value).join(", ")}`);
  }

  if (!findings.length) {
    findings.push(`Limited public footprint found for "${profile.raw}" — try adding direct profile --seed URLs.`);
  }
  return findings;
}

function buildKnowledgeKeyFindings(
  profile: TopicProfile,
  pages: TopicPageIntel[],
  knowledgeMap: import("../core/models.js").KnowledgeIntelligenceMap,
): string[] {
  const findings: string[] = [];
  findings.push(
    `Global knowledge search for "${profile.raw}" — algorithm seeks regional perspectives, not US-only sources.`,
  );
  if (knowledgeMap.primaryDomains.length) {
    findings.push(`Primary domains: ${knowledgeMap.primaryDomains.join(", ")}`);
  }
  if (knowledgeMap.globalCoverage.regionsRepresented.length) {
    findings.push(
      `Regional coverage: ${knowledgeMap.globalCoverage.regionsRepresented.join(", ")} (${knowledgeMap.globalCoverage.totalRegionalSources} source pages).`,
    );
  }
  if (knowledgeMap.globalCoverage.underrepresentedRegions.length) {
    findings.push(
      `Still seeking perspectives from: ${knowledgeMap.globalCoverage.underrepresentedRegions.slice(0, 6).join(", ")}.`,
    );
  }
  for (const perspective of knowledgeMap.regionalPerspectives.slice(0, 6)) {
    const framing =
      perspective.keyClaims[0] ??
      perspective.themes[0] ??
      perspective.representativeSnippets[0] ??
      `${perspective.pageCount} source(s)`;
    findings.push(
      `${perspective.region}: ${framing.slice(0, 180)}${framing.length > 180 ? "…" : ""}`,
    );
  }
  if (pages.length) {
    findings.push(`Top sources: ${pages.slice(0, 3).map((p) => p.url).join(" · ")}`);
  }
  if (findings.length <= 1) {
    findings.push(`Limited global sources found — try --seed URLs from regional sites or increase --max-pages.`);
  }
  return findings;
}

function buildExecutiveSummary(
  profile: TopicProfile,
  stats: IntelligenceReport["crawlStats"],
  entities: IntelligenceEntity[],
  pages: TopicPageIntel[],
  searchMode: SearchModeType,
  knowledgeMap?: import("../core/models.js").KnowledgeIntelligenceMap,
): string {
  if (searchMode === "knowledge" && knowledgeMap) {
    const regions = knowledgeMap.globalCoverage.regionsRepresented;
    const parts = [
      `Global knowledge synthesis for "${profile.raw}".`,
      `Collected ${stats.totalPages} pages across ${stats.wavesCompleted} expansion wave(s) in ${Math.round(stats.durationMs / 1000)}s.`,
      regions.length
        ? `Regional perspectives captured: ${regions.join(", ")}.`
        : `Seeking regional perspectives (India, China, Russia, and others) — add --seed URLs or increase page budget.`,
    ];
    if (knowledgeMap.regionalPerspectives.length) {
      const highlights = knowledgeMap.regionalPerspectives
        .slice(0, 4)
        .map((p) => `${p.region} (${p.pageCount} sources)`)
        .join("; ");
      parts.push(`Perspective map: ${highlights}.`);
    }
    if (stats.saturated) parts.push(`Crawl reached saturation — no new regional intelligence in the final wave.`);
    return parts.join(" ");
  }

  const names = entities.filter((e) => e.type === "name").slice(0, 3).map((e) => e.value);
  const handles = entities.filter((e) => e.type === "handle").slice(0, 4).map((e) => e.value);
  const parts = [
    `Intelligence synthesis for "${profile.raw}".`,
    `Collected ${stats.totalPages} pages (${stats.livePages} live, ${stats.archivePages} archival) across ${stats.wavesCompleted} expansion wave(s) in ${Math.round(stats.durationMs / 1000)}s.`,
  ];
  if (names.length) parts.push(`Primary identities: ${names.join(", ")}.`);
  if (handles.length) parts.push(`Handles: ${handles.join(", ")}.`);
  if (pages.length) parts.push(`Highest-confidence source: ${pages[0].url} (relevance ${pages[0].relevance.toFixed(2)}).`);
  if (stats.saturated) parts.push(`Crawl reached saturation — no new relevant URLs in the final wave.`);
  return parts.join(" ");
}

export function synthesizeIntelligenceReport(
  profile: TopicProfile,
  jobId: string,
  allPages: PageRecord[],
  opts: {
    minRelevance: number;
    mode: "standard" | "exhaustive";
    wavesCompleted: number;
    durationMs: number;
    saturated: boolean;
    searchMode: SearchModeType;
    searchModeReason: string;
  },
): IntelligenceReport {
  const base = buildTopicReport(profile, jobId, allPages, allPages.length, opts.minRelevance);
  const allEntities: IntelligenceEntity[] = [];

  const sourceLinks = allPages
    .map((page) => {
      const body = loadBody(page);
      const relevance =
        (page.metadata?.topicRelevance as number | undefined) ??
        scorePage(page.url, page.title, body, profile);
      return {
        url: page.url,
        title: page.title,
        relevance: Math.round(relevance * 1000) / 1000,
        fetchedAt: page.fetchedAt,
        source: page.source,
        hasExtractedData: relevance >= opts.minRelevance,
      };
    })
    .sort((a, b) => b.relevance - a.relevance);

  const historical: HistoricalSnapshot[] = [];
  for (const page of allPages.filter((p) => p.source === "wayback")) {
    const body = loadBody(page);
    const rel =
      (page.metadata?.topicRelevance as number | undefined) ??
      scorePage(page.url, page.title, body, profile);
    if (rel < opts.minRelevance * 0.8) continue;
    const intel = extractPageIntel(page.url, body, profile, rel);
    historical.push({
      url: page.url,
      timestamp: page.archiveTimestamp ?? "unknown",
      title: page.title,
      relevance: rel,
      snippets: intel.snippets.slice(0, 4),
    });
  }
  historical.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const intel of base.pages) {
    allEntities.push(...extractEntitiesFromIntel(intel, profile));
  }

  const livePages = allPages.filter((p) => p.source === "live").length;
  const archivePages = allPages.filter((p) => p.source === "wayback").length;
  const uniqueUrls = new Set(allPages.map((p) => p.url)).size;
  const entities = mergeEntities(allEntities);
  const timeline = buildTimeline(allPages, base.pages, historical);
  const peopleMapBase =
    opts.searchMode === "people"
      ? buildPeopleMap(base.pages, timeline, profile)
      : emptyPeopleMap();
  let peopleMap = peopleMapBase;
  if (opts.searchMode === "people") {
    const socialTrail = buildSocialTrail(base.pages, allPages, profile, loadBody);
    const organizationMap = buildOrganizationIntelMap(base.pages, peopleMapBase, profile, allPages, loadBody);
    const temporal = buildTemporalIntelligence(
      base.pages,
      peopleMapBase,
      socialTrail,
      profile,
      allPages,
      loadBody,
    );
    const household = buildHouseholdMap(
      base.pages,
      allPages,
      profile,
      peopleMapBase,
      temporal,
      socialTrail,
      loadBody,
    );
    peopleMap = { ...peopleMapBase, socialTrail, organizationMap, temporal, household };
  }
  const knowledgeMap =
    opts.searchMode === "knowledge"
      ? buildKnowledgeMap(profile.raw, base.pages, timeline, (url) => {
          const page = allPages.find((p) => p.url === url);
          return page ? loadBody(page) : "";
        })
      : opts.searchMode === "people"
        ? buildKnowledgeMap(profile.raw, base.pages, timeline)
        : emptyKnowledgeMap(profile.raw);
  const keyFindings =
    opts.searchMode === "knowledge"
      ? buildKnowledgeKeyFindings(profile, base.pages, knowledgeMap)
      : buildKeyFindings(profile, base.pages, entities, peopleMap);
  const crawlStats = {
    totalPages: allPages.length,
    livePages,
    archivePages,
    wavesCompleted: opts.wavesCompleted,
    uniqueUrls,
    durationMs: opts.durationMs,
    saturated: opts.saturated,
  };

  return {
    ...base,
    generatedAt: new Date().toISOString(),
    searchMode: opts.searchMode,
    searchModeReason: opts.searchModeReason,
    mode: opts.mode,
    crawlStats,
    executiveSummary: buildExecutiveSummary(profile, crawlStats, entities, base.pages, opts.searchMode, knowledgeMap),
    keyFindings,
    entities,
    timeline,
    historicalSnapshots: historical.slice(0, 30),
    networkGraph: buildNetworkGraph(base.pages),
    aggregatedLocations: [
      ...new Set(entities.filter((e) => e.type === "location").map((e) => e.value)),
    ],
    sourceLinks,
    peopleMap,
    knowledgeMap,
    linkedPersons: [],
  };
}

export function formatIntelligenceMarkdown(report: IntelligenceReport): string {
  const lines: string[] = [
    `# Intelligence Report`,
    ``,
    `**Subject:** ${report.topic}`,
    `**Generated:** ${report.generatedAt}`,
    `**Search type:** ${report.searchMode} (${report.searchModeReason})`,
    `**Crawl mode:** ${report.mode}`,
    ``,
    `## Executive Summary`,
    ``,
    report.executiveSummary,
    ``,
    `## Crawl Statistics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total pages | ${report.crawlStats.totalPages} |`,
    `| Live web | ${report.crawlStats.livePages} |`,
    `| Internet Archive | ${report.crawlStats.archivePages} |`,
    `| Unique URLs | ${report.crawlStats.uniqueUrls} |`,
    `| Expansion waves | ${report.crawlStats.wavesCompleted} |`,
    `| Duration | ${Math.round(report.crawlStats.durationMs / 1000)}s |`,
    `| Saturated | ${report.crawlStats.saturated ? "yes" : "no"} |`,
    ``,
    `## Key Findings`,
    ``,
  ];
  for (const f of report.keyFindings) lines.push(`- ${f}`);
  lines.push(``);
  if (report.searchMode === "people") {
    lines.push(formatPeopleMapMarkdown(report.peopleMap));
    if (report.linkedPersons?.length) {
      lines.push(formatLinkedPersonsMarkdown(report.linkedPersons));
    }
  } else {
    lines.push(formatKnowledgeMapMarkdown(report.knowledgeMap));
  }
  if (report.searchMode === "people" && report.knowledgeMap.primaryDomains.length) {
    lines.push(``);
    lines.push(`### Person's Knowledge Domains (from crawled pages)`, ``);
    lines.push(`Primary: ${report.knowledgeMap.primaryDomains.join(", ")}`);
    for (const d of report.knowledgeMap.relatedDomains.slice(0, 10)) {
      lines.push(`- ${d.value} — ${d.sources[0]}`);
    }
  }
  lines.push(``);
  lines.push(`## Identified Entities`, ``);

  const byType = new Map<string, IntelligenceEntity[]>();
  for (const e of report.entities) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }
  for (const [type, list] of byType) {
    lines.push(`### ${type}`, ``);
    for (const e of list.slice(0, 15)) {
      lines.push(`- **${e.value}** (confidence ${(e.confidence * 100).toFixed(0)}%) — ${e.sources.slice(0, 2).join(", ")}`);
    }
    lines.push(``);
  }

  if (report.historicalSnapshots.length) {
    lines.push(`## Historical Timeline (Present → Past)`, ``);
    for (const h of report.historicalSnapshots.slice(0, 15)) {
      const d = h.timestamp.length >= 8
        ? `${h.timestamp.slice(0, 4)}-${h.timestamp.slice(4, 6)}-${h.timestamp.slice(6, 8)}`
        : h.timestamp;
      lines.push(`- **${d}** — [${h.url}](${h.url})${h.title ? `: ${h.title}` : ""}`);
    }
    lines.push(``);
  }

  lines.push(`## Relevant Pages`, ``);
  for (const p of report.pages.slice(0, 25)) {
    lines.push(`### [${p.relevance.toFixed(2)}] ${p.url}`, ``);
    if (p.title) lines.push(`**Title:** ${p.title}`, ``);
    if (p.githubName) lines.push(`**Name:** ${p.githubName}`, ``);
    if (p.githubBio) lines.push(`**Bio:** ${p.githubBio}`, ``);
    for (const item of p.profileItems.slice(0, 6)) lines.push(`- ${item}`);
    for (const s of p.snippets.slice(0, 3)) lines.push(`> ${s.slice(0, 220)}`);
    lines.push(``);
  }

  if (report.networkGraph.length) {
    lines.push(`## Connection Graph`, ``);
    for (const edge of report.networkGraph.slice(0, 30)) {
      lines.push(`- \`${edge.from}\` → \`${edge.to}\` (${edge.relation})`);
    }
    lines.push(``);
  }

  lines.push(`## Source Links (All Crawled URLs)`, ``);
  lines.push(`| Relevance | Source | URL | Title |`, `|-----------|--------|-----|-------|`);
  for (const s of report.sourceLinks.slice(0, 100)) {
    const title = (s.title ?? "").replace(/\|/g, "/").slice(0, 60);
    lines.push(`| ${s.relevance.toFixed(2)} | ${s.source} | ${s.url} | ${title} |`);
  }

  return lines.join("\n");
}

export function saveIntelligenceReport(report: IntelligenceReport, jsonPath: string, markdownPath?: string): void {
  mkdirSync(jsonPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  if (markdownPath) {
    mkdirSync(markdownPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
    writeFileSync(markdownPath, formatIntelligenceMarkdown(report), "utf8");
  }
}

function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function defaultReportPaths(topic: string): { json: string; markdown: string } {
  const slug = topicSlug(topic) || "intelligence";
  return {
    json: `./data/reports/${slug}-intelligence.json`,
    markdown: `./data/reports/${slug}-intelligence.md`,
  };
}

export async function runIntelligenceLookup(
  config: AppConfig,
  security: NomadSecurityStack | null,
  opts: IntelligenceOptions,
): Promise<IntelligenceReport> {
  const { Orchestrator } = await import("../core/orchestrator.js");
  const start = Date.now();
  const profile = TopicProfile.parse(opts.topic);
  const orchestrator = new Orchestrator(config, security);
  orchestrator.init();

  const limit = pageLimit(config, opts);
  const minRelevance = opts.minRelevance ?? 0.08;
  const minLinkScore = opts.minLinkScore ?? 0.06;
  const maxDepth = opts.maxDepth ?? 8;
  const includeArchive = opts.includeArchive !== false;
  const exhaustive = opts.exhaustive !== false;

  const modeResult = resolveSearchMode(profile.raw, opts.searchMode);
  progress(opts, `Search mode: ${modeResult.mode} (${modeResult.reason})`);

  try {
    progress(opts, `Search: "${profile.raw}" — building seed URLs…`);
    const runnerCtx = createRunnerContext(profile, modeResult.mode, {
      minRelevance,
      minLinkScore,
      maxDepth,
      exhaustive,
      includeArchive,
      jsRendering: opts.jsRendering ?? false,
      pageLimit: limit,
      loadBody,
      config,
    });

    let seeds = await buildInitialGraphSeeds(runnerCtx, opts.extraSeeds, config);
    if (security) {
      const blocked = new Set(security.ssrfGuard.validateMany(seeds).map((b) => b[0]));
      seeds = seeds.filter((s) => !blocked.has(s));
    }

    const runners = modeResult.mode === "people" ? PEOPLE_RUNNERS : KNOWLEDGE_RUNNERS;
    const runnerOutcome = await runIntelligenceRunners(
      runners,
      runnerCtx,
      orchestrator,
      security,
      (msg) => progress(opts, msg),
      seeds,
    );

    const jobId = runnerCtx.primaryJobId;
    const allPages = runnerCtx.allPages;
    const saturated = runnerOutcome.saturated && runnerOutcome.graphJobCompleted;

    const report = synthesizeIntelligenceReport(profile, jobId, allPages, {
      minRelevance,
      mode: exhaustive ? "exhaustive" : "standard",
      wavesCompleted: runnerOutcome.totalWaves,
      durationMs: Date.now() - start,
      saturated,
      searchMode: modeResult.mode,
      searchModeReason: modeResult.reason,
    });

    const linkedDepth = opts.linkedDepth ?? 1;
    const maxLinkedPersons = opts.maxLinkedPersons ?? 3;
    if (
      modeResult.mode === "people" &&
      linkedDepth > 0 &&
      maxLinkedPersons > 0 &&
      report.peopleMap.household.members.length
    ) {
      const linked = await runLinkedPersonAgents(config, security, profile, report.peopleMap.household, {
        linkedDepth,
        maxLinkedPersons,
        minRelevance,
        exhaustive,
        includeArchive: false,
        jsRendering: opts.jsRendering,
        maxPagesPerPerson: opts.linkedMaxPages ?? 0,
        onProgress: opts.onProgress,
      });
      report.linkedPersons = linked;
      for (const lp of linked.slice(0, 3)) {
        report.keyFindings.push(
          `Linked agent — ${lp.name} (${lp.relationToSubject ?? "household"}): ${lp.saturated ? "saturated" : "capped"} — ${lp.keyFindings[0] ?? lp.executiveSummary.slice(0, 100)}`,
        );
      }
    }

    return report;
  } finally {
    orchestrator.shutdown();
  }
}
