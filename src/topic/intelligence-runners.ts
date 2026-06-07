import type { AppConfig } from "../core/config.js";
import type {
  CrawlJobSpec,
  FrontierEntry,
  PageRecord,
  SearchMode,
  TopicPageIntel,
} from "../core/models.js";
import type { NomadSecurityStack } from "../security/nomad.js";
import { ArchiveEngine } from "../engines/registry.js";
import type { Orchestrator } from "../core/orchestrator.js";
import {
  TopicProfile,
  buildTopicReport,
  buildTopicSeeds,
  enrichSeedsFromGithubSearch,
  isTopicNoiseUrl,
} from "./index.js";
import { buildPeopleMap } from "./people-intel.js";
import { buildSocialTrail, collectSocialProfileSeeds } from "./social-trail.js";
import {
  buildOrganizationIntelMap,
  collectOrganizationSeeds,
} from "./org-intel.js";
import { buildTemporalIntelligence } from "./temporal-intel.js";
import { buildHouseholdMap } from "./household-intel.js";
import { buildKnowledgeSeeds } from "./knowledge-intel.js";
import {
  assessGlobalCoverage,
  buildRegionalPerspectives,
  collectGlobalPerspectiveSeeds,
  globalPerspectiveSnapshotKeys,
} from "./global-intel.js";

export interface IntelligenceSnapshot {
  keys: string[];
}

export interface CrawlSeedBundle {
  urls: string[];
  extraFrontier?: FrontierEntry[];
  engine?: CrawlJobSpec["engine"];
  maxDepth?: number;
  maxPages?: number;
  topicMinLinkScore?: number;
  topicMinRelevance?: number;
  topicFollowRelated?: boolean;
  exhaustive?: boolean;
  jsRendering?: boolean;
}

export interface IntelligenceRunnerContext {
  profile: TopicProfile;
  searchMode: SearchMode;
  minRelevance: number;
  minLinkScore: number;
  maxDepth: number;
  exhaustive: boolean;
  includeArchive: boolean;
  jsRendering: boolean;
  pageLimit: number;
  allPages: PageRecord[];
  crawledUrls: Set<string>;
  archivedKeys: Set<string>;
  primaryJobId: string;
  archive: ArchiveEngine;
  loadBody: (page: PageRecord) => string;
  wavesByRunner: Map<string, number>;
  saturatedRunners: Set<string>;
}

export interface IntelligenceRunner {
  id: string;
  label: string;
  maxWaves: number;
  enabled(ctx: IntelligenceRunnerContext): boolean;
  extractSnapshot(ctx: IntelligenceRunnerContext): IntelligenceSnapshot;
  collectSeeds(ctx: IntelligenceRunnerContext): Promise<CrawlSeedBundle>;
  buildJobSpec(bundle: CrawlSeedBundle, ctx: IntelligenceRunnerContext): CrawlJobSpec;
}

export interface IntelligenceRunnerOutcome {
  totalWaves: number;
  saturated: boolean;
  graphJobCompleted: boolean;
}

export function snapshotFromKeys(items: string[]): IntelligenceSnapshot {
  return { keys: [...new Set(items.map((s) => s.toLowerCase().trim()).filter(Boolean))].sort() };
}

export function isSnapshotSaturated(
  prev: IntelligenceSnapshot | null,
  next: IntelligenceSnapshot,
): boolean {
  if (!prev) return false;
  if (prev.keys.length === 0 && next.keys.length === 0) return true;
  return prev.keys.join("\0") === next.keys.join("\0");
}

function intelPages(ctx: IntelligenceRunnerContext): TopicPageIntel[] {
  return buildTopicReport(
    ctx.profile,
    ctx.primaryJobId,
    ctx.allPages,
    ctx.allPages.length,
    ctx.minRelevance,
  ).pages;
}

function peopleMapBase(ctx: IntelligenceRunnerContext) {
  return buildPeopleMap(intelPages(ctx), [], ctx.profile);
}

function filterSeedBundle(
  bundle: CrawlSeedBundle,
  ctx: IntelligenceRunnerContext,
  security: NomadSecurityStack | null,
): CrawlSeedBundle {
  let urls = bundle.urls.filter(
    (u) => !ctx.crawledUrls.has(u.toLowerCase()) && !isTopicNoiseUrl(u),
  );
  if (security) {
    const blocked = new Set(security.ssrfGuard.validateMany(urls).map((b) => b[0]));
    urls = urls.filter((u) => !blocked.has(u));
  }
  const extraFrontier = bundle.extraFrontier?.filter((e) => {
    const key = `${e.url.toLowerCase()}|${e.archiveTimestamp ?? ""}`;
    return !ctx.archivedKeys.has(key) && !ctx.crawledUrls.has(e.url.toLowerCase());
  });
  return { ...bundle, urls, extraFrontier };
}

export const graphRunner: IntelligenceRunner = {
  id: "graph",
  label: "Topic graph",
  maxWaves: 1,
  enabled: () => true,
  extractSnapshot(ctx) {
    const pages = intelPages(ctx);
    return snapshotFromKeys([
      ...pages.map((p) => p.url),
      ...pages.flatMap((p) => p.emails),
      ...pages.flatMap((p) => p.phones ?? []),
      ...pages.flatMap((p) => p.socialLinks),
    ]);
  },
  async collectSeeds() {
    return { urls: [] };
  },
  buildJobSpec(bundle, ctx) {
    return {
      seeds: bundle.urls,
      engine: "auto",
      maxDepth: ctx.maxDepth,
      maxPages: ctx.pageLimit,
      includeArchive: false,
      includeSitemaps: false,
      jsRendering: ctx.jsRendering,
      topic: ctx.profile.raw,
      topicMinLinkScore: ctx.minLinkScore,
      topicMinRelevance: ctx.minRelevance,
      topicFollowRelated: true,
      exhaustive: ctx.exhaustive,
    };
  },
};

export const socialRunner: IntelligenceRunner = {
  id: "social",
  label: "Social trail",
  maxWaves: 3,
  enabled(ctx) {
    return ctx.searchMode === "people";
  },
  extractSnapshot(ctx) {
    const trail = buildSocialTrail(intelPages(ctx), ctx.allPages, ctx.profile, ctx.loadBody);
    return snapshotFromKeys([
      ...trail.profiles.map((p) => p.profileUrl),
      ...trail.posts.map((p) => p.postUrl),
      ...trail.images.map((i) => i.imageUrl),
      ...trail.persona.themes,
    ]);
  },
  async collectSeeds(ctx) {
    const seeds = collectSocialProfileSeeds(intelPages(ctx), ctx.allPages, ctx.profile).slice(0, 12);
    return { urls: seeds };
  },
  buildJobSpec(bundle, ctx) {
    const n = bundle.urls.length;
    return {
      seeds: bundle.urls,
      engine: ctx.jsRendering ? "playwright" : "auto",
      maxDepth: 2,
      maxPages: Math.min(40, Math.max(n * 5, 5)),
      includeArchive: false,
      includeSitemaps: false,
      jsRendering: ctx.jsRendering,
      topic: ctx.profile.raw,
      topicMinLinkScore: ctx.minLinkScore * 0.75,
      topicMinRelevance: ctx.minRelevance * 0.65,
      topicFollowRelated: true,
      exhaustive: false,
    };
  },
};

export const organizationRunner: IntelligenceRunner = {
  id: "organization",
  label: "Organization",
  maxWaves: 2,
  enabled(ctx) {
    return ctx.searchMode === "people";
  },
  extractSnapshot(ctx) {
    const people = peopleMapBase(ctx);
    const orgs = buildOrganizationIntelMap(
      intelPages(ctx),
      people,
      ctx.profile,
      ctx.allPages,
      ctx.loadBody,
    );
    return snapshotFromKeys([
      ...orgs.map((o) => o.normalizedName),
      ...orgs.flatMap((o) => o.relatedPages),
      ...orgs.flatMap((o) => o.addresses.map((a) => a.address)),
    ]);
  },
  async collectSeeds(ctx) {
    const people = peopleMapBase(ctx);
    const orgs = buildOrganizationIntelMap(
      intelPages(ctx),
      people,
      ctx.profile,
      ctx.allPages,
      ctx.loadBody,
    );
    return { urls: collectOrganizationSeeds(orgs).slice(0, 8) };
  },
  buildJobSpec(bundle, ctx) {
    const n = bundle.urls.length;
    return {
      seeds: bundle.urls,
      engine: "auto",
      maxDepth: 1,
      maxPages: Math.min(20, Math.max(n * 3, 3)),
      includeArchive: false,
      includeSitemaps: false,
      topic: ctx.profile.raw,
      topicMinLinkScore: ctx.minLinkScore * 0.5,
      topicMinRelevance: ctx.minRelevance * 0.5,
      topicFollowRelated: false,
      exhaustive: false,
    };
  },
};

export const historicalRunner: IntelligenceRunner = {
  id: "historical",
  label: "Historical",
  maxWaves: 2,
  enabled(ctx) {
    return ctx.includeArchive && ctx.allPages.length > 0;
  },
  extractSnapshot(ctx) {
    const snaps = ctx.allPages
      .filter((p) => p.source === "wayback")
      .map((p) => `${p.url}|${p.archiveTimestamp ?? ""}`);
    return snapshotFromKeys(snaps);
  },
  async collectSeeds(ctx) {
    const archiveSeeds = [
      ...new Set(
        ctx.allPages
          .filter((p) => p.source === "live")
          .filter((p) => {
            const rel = p.metadata?.topicRelevance as number | undefined;
            return rel !== undefined && rel >= ctx.minRelevance;
          })
          .sort(
            (a, b) =>
              ((b.metadata?.topicRelevance as number) ?? 0) -
              ((a.metadata?.topicRelevance as number) ?? 0),
          )
          .map((p) => p.url)
          .filter((u) => !isTopicNoiseUrl(u)),
      ),
    ].slice(0, 5);

    const extraFrontier: FrontierEntry[] = [];
    for (const url of archiveSeeds) {
      const snaps = (await ctx.archive.listSnapshots(url)).slice(0, 3);
      for (const ts of snaps) {
        const key = `${url.toLowerCase()}|${ts}`;
        if (ctx.archivedKeys.has(key)) continue;
        extraFrontier.push({
          url,
          depth: 0,
          source: "wayback",
          priority: 80,
          archiveTimestamp: ts,
        });
      }
    }

    return {
      urls: archiveSeeds.slice(0, 1),
      extraFrontier,
      engine: "archive",
      maxDepth: 0,
      maxPages: extraFrontier.length,
      topicMinRelevance: ctx.minRelevance,
      topicFollowRelated: false,
      exhaustive: false,
    };
  },
  buildJobSpec(bundle, ctx) {
    return {
      seeds: bundle.urls.length ? bundle.urls : ["https://web.archive.org/"],
      engine: bundle.engine ?? "archive",
      maxDepth: bundle.maxDepth ?? 0,
      maxPages: bundle.maxPages ?? bundle.extraFrontier?.length ?? 1,
      includeArchive: false,
      includeSitemaps: false,
      topic: ctx.profile.raw,
      topicMinRelevance: bundle.topicMinRelevance ?? ctx.minRelevance,
      topicFollowRelated: bundle.topicFollowRelated ?? false,
      exhaustive: bundle.exhaustive ?? false,
      extraFrontier: bundle.extraFrontier,
    };
  },
};

export const temporalRunner: IntelligenceRunner = {
  id: "temporal",
  label: "Temporal",
  maxWaves: 1,
  enabled(ctx) {
    return ctx.searchMode === "people";
  },
  extractSnapshot(ctx) {
    const people = peopleMapBase(ctx);
    const social = buildSocialTrail(intelPages(ctx), ctx.allPages, ctx.profile, ctx.loadBody);
    const temporal = buildTemporalIntelligence(
      intelPages(ctx),
      people,
      social,
      ctx.profile,
      ctx.allPages,
      ctx.loadBody,
    );
    return snapshotFromKeys([
      ...temporal.employmentTimeline.map(
        (t) => `${t.company}|${t.startDate ?? ""}|${t.endDate ?? ""}|${t.status}`,
      ),
      ...temporal.inferences,
      ...temporal.datedEvents.map((e) => `${e.date}|${e.category}|${e.label}`),
    ]);
  },
  async collectSeeds() {
    return { urls: [] };
  },
  buildJobSpec(bundle) {
    return { seeds: bundle.urls };
  },
};

export const householdRunner: IntelligenceRunner = {
  id: "household",
  label: "Household",
  maxWaves: 1,
  enabled(ctx) {
    return ctx.searchMode === "people";
  },
  extractSnapshot(ctx) {
    const people = peopleMapBase(ctx);
    const social = buildSocialTrail(intelPages(ctx), ctx.allPages, ctx.profile, ctx.loadBody);
    const temporal = buildTemporalIntelligence(
      intelPages(ctx),
      people,
      social,
      ctx.profile,
      ctx.allPages,
      ctx.loadBody,
    );
    const household = buildHouseholdMap(
      intelPages(ctx),
      ctx.allPages,
      ctx.profile,
      people,
      temporal,
      social,
      ctx.loadBody,
    );
    return snapshotFromKeys([
      ...household.homeAddresses.map((a) => a.normalizedAddress),
      ...household.members.map((m) => `${m.name}|${m.status}|${m.relation ?? ""}`),
      ...household.familyPhones.map((p) => p.value),
      ...household.familySocial.map((s) => s.url),
      ...household.moveHistory.map((m) => `${m.member}|${m.date ?? ""}|${m.toAddress ?? ""}`),
    ]);
  },
  async collectSeeds() {
    return { urls: [] };
  },
  buildJobSpec(bundle) {
    return { seeds: bundle.urls };
  },
};

export const globalPerspectiveRunner: IntelligenceRunner = {
  id: "global",
  label: "Global perspectives",
  maxWaves: 4,
  enabled(ctx) {
    return ctx.searchMode === "knowledge";
  },
  extractSnapshot(ctx) {
    const perspectives = buildRegionalPerspectives(
      ctx.profile.raw,
      intelPages(ctx),
      (url) => ctx.loadBody(ctx.allPages.find((p) => p.url === url) ?? { url, depth: 0, source: "live", engine: "http", fetchedAt: "", linksFound: 0, metadata: {} }),
    );
    return snapshotFromKeys(globalPerspectiveSnapshotKeys(perspectives));
  },
  async collectSeeds(ctx) {
    const perspectives = buildRegionalPerspectives(
      ctx.profile.raw,
      intelPages(ctx),
      (url) => ctx.loadBody(ctx.allPages.find((p) => p.url === url) ?? { url, depth: 0, source: "live", engine: "http", fetchedAt: "", linksFound: 0, metadata: {} }),
    );
    const coverage = assessGlobalCoverage(perspectives);
    const under = coverage.underrepresentedRegions.slice(0, 6);
    if (!under.length) return { urls: [] };
    return {
      urls: collectGlobalPerspectiveSeeds(ctx.profile.raw, ctx.crawledUrls, under),
    };
  },
  buildJobSpec(bundle, ctx) {
    const n = bundle.urls.length;
    return {
      seeds: bundle.urls,
      engine: "auto",
      maxDepth: 2,
      maxPages: Math.min(60, Math.max(n * 4, 8)),
      includeArchive: false,
      includeSitemaps: false,
      topic: ctx.profile.raw,
      topicMinLinkScore: ctx.minLinkScore * 0.45,
      topicMinRelevance: ctx.minRelevance * 0.4,
      topicFollowRelated: true,
      exhaustive: false,
    };
  },
};

export const PEOPLE_RUNNERS: IntelligenceRunner[] = [
  graphRunner,
  socialRunner,
  organizationRunner,
  historicalRunner,
  temporalRunner,
];

export const KNOWLEDGE_RUNNERS: IntelligenceRunner[] = [
  graphRunner,
  globalPerspectiveRunner,
  historicalRunner,
];

export function createRunnerContext(
  profile: TopicProfile,
  searchMode: SearchMode,
  opts: {
    minRelevance: number;
    minLinkScore: number;
    maxDepth: number;
    exhaustive: boolean;
    includeArchive: boolean;
    jsRendering: boolean;
    pageLimit: number;
    loadBody: (page: PageRecord) => string;
    config: AppConfig;
  },
): IntelligenceRunnerContext {
  return {
    profile,
    searchMode,
    minRelevance: opts.minRelevance,
    minLinkScore: opts.minLinkScore,
    maxDepth: opts.maxDepth,
    exhaustive: opts.exhaustive,
    includeArchive: opts.includeArchive,
    jsRendering: opts.jsRendering,
    pageLimit: opts.pageLimit,
    allPages: [],
    crawledUrls: new Set(),
    archivedKeys: new Set(),
    primaryJobId: "",
    archive: new ArchiveEngine(opts.config),
    loadBody: opts.loadBody,
    wavesByRunner: new Map(),
    saturatedRunners: new Set(),
  };
}

export async function buildInitialGraphSeeds(
  ctx: IntelligenceRunnerContext,
  extraSeeds: string[] | undefined,
  config: AppConfig,
): Promise<string[]> {
  let seeds =
    ctx.searchMode === "knowledge"
      ? [...buildKnowledgeSeeds(ctx.profile.raw), ...(extraSeeds ?? [])]
      : buildTopicSeeds(ctx.profile, extraSeeds ?? []);
  if (ctx.searchMode === "people") {
    const enriched = await enrichSeedsFromGithubSearch(ctx.profile, {
      userAgent: config.orchestrator.userAgent,
      timeoutMs: config.orchestrator.requestTimeoutSeconds * 1000,
    });
    seeds = [...new Set([...seeds, ...enriched])];
  }
  return seeds.filter((s) => !isTopicNoiseUrl(s));
}

async function waitForJob(
  orchestrator: Orchestrator,
  jobId: string,
  onProgress: ((message: string) => void) | undefined,
  timeoutMs = 600_000,
): Promise<import("../core/models.js").CrawlJob> {
  const deadline = Date.now() + timeoutMs;
  let job = orchestrator.getJob(jobId)!;
  let lastLogged = -1;
  let lastLogTime = 0;
  while (job.status === "running" || job.status === "pending") {
    if (Date.now() > deadline) {
      onProgress?.(`Timeout waiting for job ${jobId} — using pages collected so far`);
      break;
    }
    const now = Date.now();
    if (job.pagesCrawled !== lastLogged && (job.pagesCrawled - lastLogged >= 5 || lastLogged < 0)) {
      onProgress?.(`Crawling… ${job.pagesCrawled} pages fetched, following topic-connected links`);
      lastLogged = job.pagesCrawled;
      lastLogTime = now;
    } else if (now - lastLogTime > 15_000) {
      onProgress?.(`Still working… ${job.pagesCrawled} pages so far`);
      lastLogTime = now;
    }
    await new Promise((r) => setTimeout(r, 1000));
    job = orchestrator.getJob(jobId)!;
  }
  onProgress?.(
    `Crawl complete: ${job.pagesCrawled} pages (${job.pagesFailed} failed) — compiling intelligence report`,
  );
  return job;
}

function mergePages(ctx: IntelligenceRunnerContext, pages: PageRecord[]): void {
  for (const page of pages) {
    ctx.crawledUrls.add(page.url.toLowerCase());
    if (page.source === "wayback" && page.archiveTimestamp) {
      ctx.archivedKeys.add(`${page.url.toLowerCase()}|${page.archiveTimestamp}`);
    }
  }
  ctx.allPages = [...ctx.allPages, ...pages];
}

async function runRunnerWave(
  runner: IntelligenceRunner,
  ctx: IntelligenceRunnerContext,
  orchestrator: Orchestrator,
  security: NomadSecurityStack | null,
  onProgress: ((message: string) => void) | undefined,
  initialSeeds?: string[],
  jobTimeoutMs?: number,
): Promise<{ saturated: boolean; crawled: boolean; jobCompleted: boolean }> {
  if (!runner.enabled(ctx) || ctx.saturatedRunners.has(runner.id)) {
    return { saturated: true, crawled: false, jobCompleted: false };
  }

  const wave = ctx.wavesByRunner.get(runner.id) ?? 0;
  if (wave >= runner.maxWaves) {
    ctx.saturatedRunners.add(runner.id);
    return { saturated: true, crawled: false, jobCompleted: false };
  }

  const prevSnapshot = wave > 0 ? runner.extractSnapshot(ctx) : null;
  const rawBundle =
    wave === 0 && initialSeeds?.length
      ? { urls: initialSeeds }
      : await runner.collectSeeds(ctx);
  const bundle = filterSeedBundle(rawBundle, ctx, security);

  if (!bundle.urls.length && !bundle.extraFrontier?.length) {
    onProgress?.(`${runner.label}: no new seeds — dimension saturated`);
    ctx.saturatedRunners.add(runner.id);
    return { saturated: true, crawled: false, jobCompleted: false };
  }

  const seedCount = bundle.urls.length + (bundle.extraFrontier?.length ?? 0);
  onProgress?.(`${runner.label} wave ${wave + 1}: ${seedCount} target(s)…`);

  const job = await orchestrator.submitJob(runner.buildJobSpec(bundle, ctx));
  if (runner.id === "graph") ctx.primaryJobId = job.id;
  const finished = await waitForJob(orchestrator, job.id, onProgress, jobTimeoutMs);
  mergePages(ctx, orchestrator.listPages(job.id, 100000));
  ctx.wavesByRunner.set(runner.id, wave + 1);

  const nextSnapshot = runner.extractSnapshot(ctx);
  if (isSnapshotSaturated(prevSnapshot, nextSnapshot)) {
    onProgress?.(`${runner.label}: intelligence stopped moving — dimension saturated`);
    ctx.saturatedRunners.add(runner.id);
    return { saturated: true, crawled: true, jobCompleted: finished.status === "completed" };
  }

  if (wave + 1 >= runner.maxWaves) {
    ctx.saturatedRunners.add(runner.id);
    return { saturated: true, crawled: true, jobCompleted: finished.status === "completed" };
  }

  return { saturated: false, crawled: true, jobCompleted: finished.status === "completed" };
}

async function runRunnerLoop(
  runner: IntelligenceRunner,
  ctx: IntelligenceRunnerContext,
  orchestrator: Orchestrator,
  security: NomadSecurityStack | null,
  onProgress: ((message: string) => void) | undefined,
  initialSeeds?: string[],
  jobTimeoutMs?: number,
): Promise<{ jobCompleted: boolean }> {
  let jobCompleted = false;
  while (!ctx.saturatedRunners.has(runner.id)) {
    const result = await runRunnerWave(
      runner,
      ctx,
      orchestrator,
      security,
      onProgress,
      initialSeeds,
      jobTimeoutMs,
    );
    if (result.jobCompleted) jobCompleted = true;
    initialSeeds = undefined;
    if (result.saturated) break;
  }
  return { jobCompleted };
}

export async function runIntelligenceRunners(
  runners: IntelligenceRunner[],
  ctx: IntelligenceRunnerContext,
  orchestrator: Orchestrator,
  security: NomadSecurityStack | null,
  onProgress: ((message: string) => void) | undefined,
  initialGraphSeeds: string[],
): Promise<IntelligenceRunnerOutcome> {
  const expandable = runners.filter((r) => r.id !== "graph" && r.id !== "temporal");
  const extractOnly = runners.filter((r) => r.id === "temporal" || r.id === "household");

  onProgress?.(`Starting graph crawl from ${initialGraphSeeds.length} seed(s)…`);
  const graphResult = await runRunnerLoop(
    graphRunner,
    ctx,
    orchestrator,
    security,
    onProgress,
    initialGraphSeeds,
  );

  let round = 0;
  const maxRounds = Math.max(...expandable.map((r) => r.maxWaves), 1);
  while (round < maxRounds) {
    let anyActive = false;
    for (const runner of expandable) {
      if (ctx.saturatedRunners.has(runner.id)) continue;
      const before = ctx.wavesByRunner.get(runner.id) ?? 0;
      const result = await runRunnerWave(
        runner,
        ctx,
        orchestrator,
        security,
        onProgress,
        undefined,
        runner.id === "historical" ? 120_000 : undefined,
      );
      const after = ctx.wavesByRunner.get(runner.id) ?? 0;
      if (after > before || (!result.saturated && result.crawled)) anyActive = true;
    }
    if (!anyActive) break;
    round++;
  }

  for (const runner of extractOnly) {
    if (runner.enabled(ctx)) {
      runner.extractSnapshot(ctx);
      ctx.wavesByRunner.set(runner.id, 1);
    }
  }

  const totalWaves = [...ctx.wavesByRunner.values()].reduce((sum, n) => sum + n, 0);
  const saturated = runners
    .filter((r) => r.enabled(ctx))
    .every((r) => ctx.saturatedRunners.has(r.id) || r.id === "temporal" || r.id === "household");

  return {
    totalWaves,
    saturated,
    graphJobCompleted: graphResult.jobCompleted,
  };
}
