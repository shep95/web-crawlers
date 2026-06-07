import { describe, it, expect } from "vitest";
import { TopicProfile, scoreText, scoreLink, scorePage, isTopicNoiseUrl, shouldFollowTopicLink, extractPageIntel } from "../src/topic/index.js";
import { SSRFGuard } from "../src/security/nomad.js";
import { normalizeUrl } from "../src/core/policy.js";
import { synthesizeIntelligenceReport } from "../src/topic/intelligence.js";
import {
  isSnapshotSaturated,
  snapshotFromKeys,
  socialRunner,
} from "../src/topic/intelligence-runners.js";
import { extractPeopleDataFromText, emptyPeopleMap } from "../src/topic/people-intel.js";
import { classifySearchMode } from "../src/topic/search-mode.js";
import { buildSocialTrail, classifySocialUrl, isRepostText, isSocialProfileUrl } from "../src/topic/social-trail.js";
import {
  buildEmploymentTimeline,
  extractDatedEvidenceFromText,
  inferJobTransitions,
} from "../src/topic/temporal-intel.js";
import { buildOrganizationIntelMap } from "../src/topic/org-intel.js";
import {
  buildHouseholdMap,
  emptyHouseholdMap,
  selectLinkedPersonCandidates,
} from "../src/topic/household-intel.js";
import { emptySocialTrail } from "../src/topic/social-trail.js";
import { emptyTemporalMap } from "../src/topic/temporal-intel.js";
import type { PageRecord, TopicPageIntel } from "../src/core/models.js";

describe("topic", () => {
  it("parses terms", () => {
    const p = TopicProfile.parse("Asher Shepherd Newton Cape Coral Florida");
    expect(p.terms).toContain("asher");
    expect(p.terms).toContain("newton");
  });

  it("scores github profile", () => {
    const p = TopicProfile.parse("Asher Newton");
    expect(scoreLink("https://github.com/shep95", "Asher Newton", p)).toBeGreaterThan(0.2);
  });
});

describe("security", () => {
  it("blocks localhost", () => {
    const g = new SSRFGuard({});
    expect(g.validateUrl("http://127.0.0.1/admin").ok).toBe(false);
  });
});

describe("policy", () => {
  it("normalizes urls", () => {
    expect(normalizeUrl("https://Example.com/path/")).toBe("https://example.com/path");
  });
});

describe("search-mode", () => {
  it("detects people vs knowledge queries", () => {
    const people = classifySearchMode("Asher Shepherd Newton Cape Coral Florida");
    expect(people.mode).toBe("people");
    const knowledge = classifySearchMode("how does transformer attention work");
    expect(knowledge.mode).toBe("knowledge");
    const ai = classifySearchMode("What Is Artificial Intelligence");
    expect(ai.mode).toBe("knowledge");
  });
});

describe("global-intel", () => {
  it("builds multi-region Wikipedia seeds", async () => {
    const { buildGlobalKnowledgeSeeds } = await import("../src/topic/global-intel.js");
    const seeds = buildGlobalKnowledgeSeeds("What Is Artificial Intelligence");
    expect(seeds.some((s) => s.includes("hi.wikipedia.org"))).toBe(true);
    expect(seeds.some((s) => s.includes("zh.wikipedia.org"))).toBe(true);
    expect(seeds.some((s) => s.includes("ru.wikipedia.org"))).toBe(true);
    expect(seeds.some((s) => s.includes("en.wikipedia.org"))).toBe(true);
  });

  it("infers region from URL and script", async () => {
    const { inferSourceRegion, buildRegionalPerspectives } = await import("../src/topic/global-intel.js");
    expect(inferSourceRegion("https://timesofindia.indiatimes.com/tech/ai").region.code).toBe("IN");
    expect(inferSourceRegion("https://xinhuanet.com/english/ai").region.code).toBe("CN");
    expect(inferSourceRegion("https://tass.com/science/ai").region.code).toBe("RU");
    expect(inferSourceRegion("https://example.org/page", "Искусственный интеллект — это").region.code).toBe("RU");

    const pages = [
      {
        url: "https://hi.wikipedia.org/wiki/Artificial_intelligence",
        title: "कृत्रिम बुद्धिमत्ता",
        relevance: 0.8,
        headings: ["परिभाषा"],
        snippets: ["कृत्रिम बुद्धिमत्ता मशीनों की क्षमता है।"],
        metaDescription: "भारत में एआई परिभाषा और उपयोग।",
        socialLinks: [],
        locations: [],
        pastLocations: [],
        origins: [],
        emails: [],
        phones: [],
        family: [],
        connections: [],
        knowledgeDomains: [],
        employment: [],
        pastEmployment: [],
        businesses: [],
        government: [],
        workplaces: [],
        coworkers: [],
        compensation: [],
        profileItems: [],
      },
      {
        url: "https://en.wikipedia.org/wiki/Artificial_intelligence",
        title: "Artificial intelligence",
        relevance: 0.9,
        headings: ["Definitions"],
        snippets: ["AI is intelligence demonstrated by machines."],
        metaDescription: "Overview of artificial intelligence.",
        socialLinks: [],
        locations: [],
        pastLocations: [],
        origins: [],
        emails: [],
        phones: [],
        family: [],
        connections: [],
        knowledgeDomains: [],
        employment: [],
        pastEmployment: [],
        businesses: [],
        government: [],
        workplaces: [],
        coworkers: [],
        compensation: [],
        profileItems: [],
      },
    ] satisfies TopicPageIntel[];

    const perspectives = buildRegionalPerspectives("Artificial Intelligence", pages);
    expect(perspectives.some((p) => p.regionCode === "IN")).toBe(true);
    expect(perspectives.some((p) => p.regionCode === "GLOBAL")).toBe(true);
  });
});

describe("people-intel", () => {
  it("extracts phones, locations, family, employment from text", () => {
    const data = extractPeopleDataFromText(
      "Asher Newton lives in Cape Coral, Florida. Previously lived in Miami, FL. Born in Fort Myers. Mother: Jane Newton. Call (239) 555-0142. Works at ZorakCorp. Just A Prompt Expert AI specialist.",
    );
    expect(data.locations.some((l) => /cape coral/i.test(l))).toBe(true);
    expect(data.pastLocations.some((l) => /miami/i.test(l))).toBe(true);
    expect(data.origins.some((l) => /fort myers/i.test(l))).toBe(true);
    expect(data.phones.length).toBeGreaterThan(0);
    expect(data.family.some((f) => f.relation === "mother")).toBe(true);
    expect(data.connections.some((c) => c.type === "employer")).toBe(true);
    expect(data.knowledgeDomains.length).toBeGreaterThan(0);
  });
});

describe("social-trail", () => {
  it("classifies social profile URLs", () => {
    expect(classifySocialUrl("https://github.com/shep95")?.platform).toBe("github");
    expect(classifySocialUrl("https://x.com/shep_newton")?.isProfile).toBe(true);
    expect(isSocialProfileUrl("https://github.com/shep95/repo")).toBe(false);
  });

  it("detects reposts and excludes them", () => {
    expect(isRepostText("RT @someone great thread").isRepost).toBe(true);
    expect(isRepostText("Working on a new project today").isRepost).toBe(false);
  });

  it("builds social trail from github profile html", () => {
    const profile = TopicProfile.parse("Asher Newton");
    const html = `
      <html><head>
        <meta property="og:image" content="https://avatars.githubusercontent.com/u/1?v=4"/>
        <meta property="og:description" content="Just a prompt expert. Cape Coral FL."/>
      </head><body>
        <span class="p-name">Asher Newton</span>
        <div class="p-note">AI builder · shep_newton on X</div>
        <img class="avatar" src="https://avatars.githubusercontent.com/u/1?v=4"/>
        <a href="https://x.com/shep_newton">X @shep_newton</a>
        <a href="https://instagram.com/houseofasher">Instagram</a>
      </body></html>`;
    const page: PageRecord = {
      url: "https://github.com/shep95",
      depth: 0,
      source: "live",
      engine: "http",
      fetchedAt: new Date().toISOString(),
      linksFound: 0,
      metadata: {},
    };
    const intel = extractPageIntel(page.url, html, profile, 0.9);
    const trail = buildSocialTrail([intel], [page], profile, () => html);
    expect(trail.profiles.some((p) => p.platform === "github")).toBe(true);
    expect(trail.profiles.some((p) => p.platform === "twitter")).toBe(true);
    expect(trail.persona.disclaimer).toContain("not clinical");
  });
});
describe("temporal-intel", () => {
  it("extracts dated employment and infers job transitions", () => {
    const text =
      "Asher Newton worked at Macy's until September 9th, 2024. On May 8th, 2026 he posted about a new job at Zorak Corp as a prompt expert.";
    const events = extractDatedEvidenceFromText(text, "https://example.com/bio", 0.8);
    expect(events.some((e) => e.entity?.toLowerCase().includes("zorak"))).toBe(true);
    expect(events.some((e) => e.entity?.toLowerCase().includes("macy"))).toBe(true);

    const timeline = buildEmploymentTimeline(events, {
      current: [],
      past: [],
      compensation: [],
    });
    expect(timeline.some((t) => /zorak/i.test(t.company))).toBe(true);
    const withInference = inferJobTransitions(timeline);
    expect(withInference.some((t) => t.transitions.length > 0)).toBe(true);
  });
});

describe("org-intel", () => {
  it("classifies employer vs owned business", () => {
    const profile = TopicProfile.parse("Asher Newton");
    const peopleMap = emptyPeopleMap();
    peopleMap.employment.current.push({
      type: "employment",
      value: "employer @ Zorak Corp",
      confidence: 0.8,
      sources: ["https://example.com"],
      context: "employer",
    });
    const intel = extractPageIntel(
      "https://example.com",
      "Asher Newton works at Zorak Corp. Zorak Corp LLC registered agent at 123 Main St, Cape Coral, FL 33904. Asher lives at 123 Main St, Cape Coral, FL.",
      profile,
      0.9,
    );
    const orgs = buildOrganizationIntelMap([intel], peopleMap, profile, [], () => "");
    expect(orgs.some((o) => /zorak/i.test(o.name))).toBe(true);
    const zorak = orgs.find((o) => /zorak/i.test(o.name));
    expect(zorak?.addresses.some((a) => a.linkedToSubjectHome)).toBe(true);
  });
});

describe("household-intel", () => {
  it("extracts home address and co-residents", () => {
    const profile = TopicProfile.parse("Asher Shepherd Newton Cape Coral Florida");
    const peopleMap = emptyPeopleMap();
    const html =
      "Asher Shepherd Newton lives at 2004 SW 23rd Ct, Cape Coral, Florida 33914. John Doe also lives at 2004 SW 23rd Ct Cape Coral FL. Mother: Jane Newton. Mother's phone: (239) 555-0199. John Doe moved out May 2023 to Miami, FL.";
    const intel = extractPageIntel("https://example.com", html, profile, 0.9);
    const household = buildHouseholdMap(
      [intel],
      [],
      profile,
      peopleMap,
      emptyTemporalMap(),
      emptySocialTrail(),
      () => html,
    );
    expect(household.homeAddresses.some((a) => /2004.*23rd.*ct/i.test(a.address))).toBe(true);
    expect(household.members.some((m) => /john doe/i.test(m.name))).toBe(true);
    expect(household.members.find((m) => /john doe/i.test(m.name))?.lookupQuery).toContain("John Doe");
    expect(household.familyPhones.some((p) => p.value.includes("555"))).toBe(true);
  });

  it("selects linked person candidates excluding subject", () => {
    const profile = TopicProfile.parse("Asher Shepherd Newton");
    const household = emptyHouseholdMap();
    household.members.push({
      name: "John Doe",
      relation: "co-resident",
      status: "current_resident",
      homeAddress: "2004 SW 23rd Ct, Cape Coral, FL",
      lookupQuery: "John Doe Cape Coral Florida",
      phones: [],
      socialProfiles: [],
      sources: ["test"],
      confidence: 0.8,
    });
    const candidates = selectLinkedPersonCandidates(household, profile);
    expect(candidates.some((c) => /john doe/i.test(c.name))).toBe(true);
    expect(candidates.every((c) => !/asher shepherd newton/i.test(c.name))).toBe(true);
  });
});

describe("intelligence-runners", () => {
  it("detects saturation when snapshot keys stop changing", () => {
    const a = snapshotFromKeys(["https://github.com/shep95", "https://x.com/shep"]);
    const b = snapshotFromKeys(["https://github.com/shep95", "https://x.com/shep"]);
    const c = snapshotFromKeys(["https://github.com/shep95", "https://x.com/shep", "post-1"]);
    expect(isSnapshotSaturated(null, a)).toBe(false);
    expect(isSnapshotSaturated(a, b)).toBe(true);
    expect(isSnapshotSaturated(a, c)).toBe(false);
  });

  it("social runner fingerprint includes profiles and posts", () => {
    const profile = TopicProfile.parse("Asher Newton");
    const html = `<html><body><a href="https://x.com/shep_newton">X</a></body></html>`;
    const page: PageRecord = {
      url: "https://github.com/shep95",
      depth: 0,
      source: "live",
      engine: "http",
      fetchedAt: new Date().toISOString(),
      linksFound: 0,
      metadata: {},
    };
    const intel = extractPageIntel(page.url, html, profile, 0.9);
    const ctx = {
      profile,
      searchMode: "people" as const,
      minRelevance: 0.1,
      minLinkScore: 0.06,
      maxDepth: 4,
      exhaustive: true,
      includeArchive: false,
      jsRendering: false,
      pageLimit: 50,
      allPages: [page],
      crawledUrls: new Set([page.url.toLowerCase()]),
      archivedKeys: new Set<string>(),
      primaryJobId: "job-1",
      archive: {} as import("../src/engines/registry.js").ArchiveEngine,
      loadBody: () => html,
      wavesByRunner: new Map(),
      saturatedRunners: new Set(),
    };
    const snap = socialRunner.extractSnapshot(ctx);
    expect(snap.keys.some((k) => k.includes("github.com"))).toBe(true);
  });
});

describe("intelligence", () => {
  it("synthesizes executive summary", () => {
    const profile = TopicProfile.parse("Asher Newton Cape Coral");
    const report = synthesizeIntelligenceReport(profile, "job-1", [], {
      minRelevance: 0.1,
      mode: "exhaustive",
      wavesCompleted: 1,
      durationMs: 1000,
      saturated: true,
      searchMode: "people",
      searchModeReason: "test",
    });
    expect(report.executiveSummary).toContain("Asher Newton Cape Coral");
    expect(report.mode).toBe("exhaustive");
    expect(report.sourceLinks).toEqual([]);
    expect(report.peopleMap).toBeDefined();
    expect(report.linkedPersons).toEqual([]);
  });

  it("synthesizes global knowledge report", () => {
    const profile = TopicProfile.parse("What Is Artificial Intelligence");
    const report = synthesizeIntelligenceReport(profile, "job-1", [], {
      minRelevance: 0.1,
      mode: "exhaustive",
      wavesCompleted: 2,
      durationMs: 2000,
      saturated: true,
      searchMode: "knowledge",
      searchModeReason: "question phrasing",
    });
    expect(report.executiveSummary).toContain("Global knowledge synthesis");
    expect(report.knowledgeMap.globalCoverage).toBeDefined();
    expect(report.knowledgeMap.regionalPerspectives).toEqual([]);
  });

  it("filters github nav noise", () => {
    expect(isTopicNoiseUrl("https://github.com/mcp")).toBe(true);
    expect(isTopicNoiseUrl("https://github.com/shep95")).toBe(false);
  });

  it("follows topic-connected profile links", () => {
    const p = TopicProfile.parse("Asher Newton");
    expect(shouldFollowTopicLink("https://github.com/shep95", "Asher Newton", p, 0.06)).toBe(true);
    expect(shouldFollowTopicLink("https://github.com/mcp", "MCP", p, 0.06)).toBe(false);
  });
});
