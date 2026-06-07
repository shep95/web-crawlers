import type { IntelligenceEntity, IntelligenceTimelineEvent, KnowledgeIntelligenceMap, TopicPageIntel } from "../core/models.js";
import {
  assessGlobalCoverage,
  buildGlobalKnowledgeSeeds,
  buildRegionalPerspectives,
  emptyGlobalCoverage,
  formatRegionalPerspectivesMarkdown,
} from "./global-intel.js";

const DOMAIN_PATTERNS: Array<{ re: RegExp; domain: string }> = [
  { re: /\b(artificial intelligence|\bAI\b|machine learning|\bML\b|deep learning|neural network|LLM|large language model)/gi, domain: "Artificial Intelligence" },
  { re: /\b(prompt engineering|prompt expert|prompt design|chain-of-thought)/gi, domain: "Prompt Engineering" },
  { re: /\b(cybersecurity|infosec|penetration testing|OSINT|threat intelligence)/gi, domain: "Cybersecurity" },
  { re: /\b(web scraping|crawling|spider|data extraction)/gi, domain: "Web Crawling & Data" },
  { re: /\b(blockchain|cryptocurrency|web3|smart contract)/gi, domain: "Blockchain" },
  { re: /\b(cloud computing|devops|kubernetes|docker|aws|azure|gcp)/gi, domain: "Cloud & DevOps" },
  { re: /\b(finance|economics|investment|trading|accounting)/gi, domain: "Finance" },
  { re: /\b(medicine|healthcare|clinical|pharmaceutical|biology)/gi, domain: "Healthcare & Life Sciences" },
  { re: /\b(law|legal|jurisprudence|litigation|regulation)/gi, domain: "Law & Policy" },
];

export function extractKnowledgeDomains(text: string): string[] {
  const found: string[] = [];
  for (const { re, domain } of DOMAIN_PATTERNS) {
    if (new RegExp(re.source, re.flags.replace("g", "")).test(text)) found.push(domain);
  }
  return [...new Set(found)];
}

export function buildKnowledgeMap(
  topic: string,
  intelPages: TopicPageIntel[],
  timeline: IntelligenceTimelineEvent[],
  loadBody?: (url: string) => string,
): KnowledgeIntelligenceMap {
  const subtopics = new Map<string, IntelligenceEntity>();
  const concepts = new Map<string, IntelligenceEntity>();
  const sources = new Map<string, IntelligenceEntity>();
  const related = new Map<string, IntelligenceEntity>();

  for (const page of intelPages) {
    const conf = Math.min(0.95, 0.3 + page.relevance);
    for (const h of page.headings) {
      if (h.length < 8 || h.length > 120) continue;
      const key = h.toLowerCase();
      if (!subtopics.has(key)) {
        subtopics.set(key, { type: "knowledge_domain", value: h, confidence: conf, sources: [page.url], context: "heading" });
      }
    }
    for (const s of page.snippets.slice(0, 4)) {
      for (const d of extractKnowledgeDomains(s)) {
        const key = d.toLowerCase();
        if (!related.has(key)) {
          related.set(key, { type: "knowledge_domain", value: d, confidence: conf, sources: [page.url], context: "related domain" });
        }
      }
    }
    sources.set(page.url, {
      type: "url",
      value: page.url,
      confidence: conf,
      sources: [page.url],
      context: page.title ?? "source page",
    });
    if (page.metaDescription) {
      const key = page.metaDescription.slice(0, 80).toLowerCase();
      concepts.set(key, {
        type: "knowledge_domain",
        value: page.metaDescription.slice(0, 160),
        confidence: conf * 0.9,
        sources: [page.url],
        context: "summary",
      });
    }
  }

  const primaryDomains = extractKnowledgeDomains(
    [topic, ...intelPages.map((p) => [p.title, p.metaDescription, p.githubBio].join(" ")).join(" ")].join(" "),
  );

  const regionalPerspectives = buildRegionalPerspectives(
    topic,
    intelPages,
    loadBody ? (url) => loadBody(url) : undefined,
  );
  const globalCoverage = assessGlobalCoverage(regionalPerspectives);

  return {
    topic,
    primaryDomains: primaryDomains.length ? primaryDomains : [topic],
    subtopics: [...subtopics.values()].slice(0, 30),
    keyConcepts: [...concepts.values()].slice(0, 25),
    authoritativeSources: [...sources.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 40),
    relatedDomains: [...related.values()].slice(0, 20),
    timeline: timeline.slice(0, 40),
    regionalPerspectives,
    globalCoverage,
  };
}

export function emptyKnowledgeMap(topic: string): KnowledgeIntelligenceMap {
  return {
    topic,
    primaryDomains: [topic],
    subtopics: [],
    keyConcepts: [],
    authoritativeSources: [],
    relatedDomains: [],
    timeline: [],
    regionalPerspectives: [],
    globalCoverage: emptyGlobalCoverage(),
  };
}

export function buildKnowledgeSeeds(topic: string): string[] {
  return buildGlobalKnowledgeSeeds(topic);
}

export function formatKnowledgeMapMarkdown(map: KnowledgeIntelligenceMap): string {
  const lines = [
    "## Knowledge Domain Map",
    "",
    `**Topic:** ${map.topic}`,
    `**Primary domains:** ${map.primaryDomains.join(", ")}`,
    "",
    "### Subtopics",
    "",
  ];
  if (!map.subtopics.length) lines.push("_No subtopics extracted._", "");
  else for (const s of map.subtopics.slice(0, 20)) lines.push(`- ${s.value} (${(s.confidence * 100).toFixed(0)}%) — ${s.sources[0]}`);

  lines.push("", "### Key Concepts", "");
  if (!map.keyConcepts.length) lines.push("_No concepts extracted._", "");
  else for (const c of map.keyConcepts.slice(0, 15)) lines.push(`- ${c.value.slice(0, 200)}`);

  lines.push("", "### Authoritative Sources", "");
  for (const s of map.authoritativeSources.slice(0, 20)) {
    lines.push(`- [${(s.confidence * 100).toFixed(0)}%] ${s.value}`);
  }

  lines.push(
    "",
    `### Global coverage`,
    "",
    `Regions represented: ${map.globalCoverage.regionsRepresented.length ? map.globalCoverage.regionsRepresented.join(", ") : "none yet"}`,
    `Underrepresented: ${map.globalCoverage.underrepresentedRegions.length ? map.globalCoverage.underrepresentedRegions.join(", ") : "none"}`,
    "",
  );
  lines.push(...formatRegionalPerspectivesMarkdown(map.regionalPerspectives));

  return lines.join("\n");
}
