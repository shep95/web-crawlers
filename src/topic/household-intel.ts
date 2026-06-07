import * as cheerio from "cheerio";
import type {
  HouseholdFamilyPhone,
  HouseholdFamilySocial,
  HouseholdMap,
  HouseholdMember,
  HouseholdMoveEvent,
  HomeAddress,
  LinkedPersonIntelligence,
  PageRecord,
  PeopleIntelligenceMap,
  SocialTrailMap,
  TemporalIntelligenceMap,
  TopicPageIntel,
} from "../core/models.js";
import type { AppConfig } from "../core/config.js";
import type { NomadSecurityStack } from "../security/nomad.js";
import type { TopicProfile } from "./index.js";
import { parseDateFromMatch } from "./temporal-intel.js";

const STREET_ADDRESS =
  /\b(\d{1,5}\s+(?:(?:N|S|E|W|NW|NE|SW|SE)\.?\s+)?\d{1,4}(?:st|nd|rd|th)?\.?\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place|Cir|Circle|Ter|Terrace)\b(?:\s+(?:Apt|Unit|Suite|Ste|#)\s?[A-Za-z0-9-]+)?[^,.\n]{0,30}?(?:,\s*)?[A-Za-z\s]{2,30}(?:,\s*)?(?:Florida|FL|[A-Z]{2}))(?:\s+(\d{5}))?/gi;

const STREET_ADDRESS_LOOSE =
  /\b(\d{1,5}\s+(?:(?:n|s|e|w|nw|ne|sw|se)\.?\s+)?\d{1,4}(?:st|nd|rd|th)?\.?\s+(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|way|ct|court|pl|place|cir|circle|ter|terrace)\b[^,.\n]{0,80}?[,\s]+[A-Za-z\s]{2,40}[,\s]+(?:[A-Z]{2}|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b(?:\s+(\d{5}))?)/gi;

const CO_RESIDENT_PATTERNS: Array<{ re: RegExp; relation: string }> = [
  { re: /\b(?:lives with|living with|resides with|roommate[s]?[:\s]+|housemate[s]?[:\s]+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi, relation: "co-resident" },
  { re: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:also lives|also resides|lives here too|resides here too)\b/gi, relation: "co-resident" },
  { re: /\b(?:household|residents|occupants)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}(?:,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}){0,4})/gi, relation: "household" },
  { re: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:moved in|moved out|relocated)\b/gi, relation: "co-resident" },
];

const MOVE_OUT_PATTERNS: Array<{ re: RegExp; type: "out" | "to" }> = [
  { re: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+moved out(?:\s+(?:on|in)\s+([^,.]+?))?(?:\s+(?:to|and moved to)\s+([^,.]+?))?(?:\.|,|$)/gi, type: "out" },
  { re: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:relocated|moved)\s+to\s+([^,.]+?)(?:\s+(?:on|in)\s+([^,.]+?))?(?:\.|,|$)/gi, type: "to" },
  { re: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+no longer lives(?:\s+at\s+([^,.]+?))?(?:\.|,|$)/gi, type: "out" },
];

const FAMILY_PHONE_PATTERNS: Array<{ re: RegExp; relation: string }> = [
  { re: /\b(?:mother|mom|mama)(?:'s)?\s+(?:phone|cell|number)[:\s]+((?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4})/gi, relation: "mother" },
  { re: /\b(?:father|dad|papa)(?:'s)?\s+(?:phone|cell|number)[:\s]+((?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4})/gi, relation: "father" },
  { re: /\b(?:spouse|wife|husband|partner)(?:'s)?\s+(?:phone|cell|number)[:\s]+((?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4})/gi, relation: "spouse" },
  { re: /\b(?:brother|sister|sibling)(?:'s)?\s+(?:phone|cell|number)[:\s]+((?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4})/gi, relation: "sibling" },
];

const SOCIAL_URL =
  /https?:\/\/(?:www\.)?(?:github\.com\/[^\s"'<>]+|x\.com\/[^\s"'<>]+|twitter\.com\/[^\s"'<>]+|instagram\.com\/[^\s"'<>]+|facebook\.com\/[^\s"'<>]+|linkedin\.com\/in\/[^\s"'<>]+|tiktok\.com\/@[^\s"'<>]+)/gi;

const PLACE_WORDS = new Set([
  "cape", "coral", "fort", "myers", "florida", "fl", "lee", "county", "united", "states",
  "southwest", "north", "south", "east", "west",
]);

function normalizeAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bflorida\b/g, "fl")
    .trim();
}

function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function isLikelyPersonName(name: string, profile: TopicProfile): boolean {
  const trimmed = name.trim().replace(/[.,;]+$/, "");
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  if (parts.some((p) => p.length < 2)) return false;
  if (parts.every((p) => PLACE_WORDS.has(p.toLowerCase()))) return false;
  const lower = trimmed.toLowerCase();
  for (const phrase of profile.phrases) {
    if (phrase.length >= 6 && lower === phrase) return false;
  }
  if (profile.terms.length >= 2) {
    const hits = profile.terms.filter((t) => t.length >= 4 && lower.includes(t)).length;
    if (hits >= Math.min(2, profile.terms.length)) return false;
  }
  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(trimmed);
}

function extractStreetAddresses(text: string, source: string, confidence: number): HomeAddress[] {
  const found: HomeAddress[] = [];
  for (const re of [STREET_ADDRESS, STREET_ADDRESS_LOOSE]) {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(r)) {
      const addr = m[0].replace(/\s+/g, " ").trim();
      if (addr.length < 12) continue;
      const cityMatch = addr.match(/,\s*([A-Za-z\s]{2,40})\s*,?\s*(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|FL|CA|TX|NY|[A-Z]{2})\b/i);
      found.push({
        address: addr,
        normalizedAddress: normalizeAddress(addr),
        city: cityMatch?.[1]?.trim(),
        state: "FL",
        zip: m[m.length - 1]?.match(/^\d{5}$/) ? m[m.length - 1] : undefined,
        status: /\b(?:formerly|previously|used to live|past address)\b/i.test(text.slice(Math.max(0, text.indexOf(addr) - 80), text.indexOf(addr)))
          ? "past"
          : "current",
        sources: [source],
        confidence,
      });
    }
  }
  return found;
}

function geoContextForLookup(
  profile: TopicProfile,
  peopleMap: PeopleIntelligenceMap,
  home?: HomeAddress,
): string {
  if (home?.city) {
    return home.state ? `${home.city} ${home.state}` : home.city;
  }
  const loc = peopleMap.locations.current[0]?.value;
  if (loc) {
    const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join(" ");
    return loc;
  }
  const geoTerms = profile.terms.filter((t) => t.length >= 3 && LOCATION_TERMS.has(t));
  if (geoTerms.length) return geoTerms.slice(-3).join(" ");
  return profile.terms.filter((t) => t.length >= 3).slice(-2).join(" ");
}

const LOCATION_TERMS = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "hampshire",
  "jersey", "mexico", "york", "carolina", "dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "wisconsin", "wyoming", "united", "states", "usa", "county", "city",
]);

function parseDateNear(text: string, index: number): string | undefined {
  const window = text.slice(Math.max(0, index - 40), index + 80);
  for (const { re, precision } of [
    { re: /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i, precision: "day" as const },
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, precision: "day" as const },
  ]) {
    const m = window.match(re);
    if (m) {
      const d = parseDateFromMatch(m, precision);
      if (d) return d;
    }
  }
  return undefined;
}

export function emptyHouseholdMap(): HouseholdMap {
  return {
    homeAddresses: [],
    members: [],
    familyPhones: [],
    familySocial: [],
    moveHistory: [],
  };
}

export function buildHouseholdMap(
  intelPages: TopicPageIntel[],
  allPages: PageRecord[],
  profile: TopicProfile,
  peopleMap: PeopleIntelligenceMap,
  temporal: TemporalIntelligenceMap,
  socialTrail: SocialTrailMap,
  loadBody: (page: PageRecord) => string,
): HouseholdMap {
  const homeAddresses: HomeAddress[] = [];
  const members = new Map<string, HouseholdMember>();
  const familyPhones: HouseholdFamilyPhone[] = [];
  const familySocial: HouseholdFamilySocial[] = [];
  const moveHistory: HouseholdMoveEvent[] = [];

  const addMember = (raw: HouseholdMember) => {
    const name = titleCaseName(raw.name);
    if (!isLikelyPersonName(name, profile)) return;
    const key = name.toLowerCase();
    const existing = members.get(key);
    if (!existing) {
      members.set(key, { ...raw, name });
    } else {
      existing.phones.push(...raw.phones);
      existing.socialProfiles.push(...raw.socialProfiles);
      existing.sources = [...new Set([...existing.sources, ...raw.sources])];
      existing.confidence = Math.max(existing.confidence, raw.confidence);
      if (raw.relation && !existing.relation) existing.relation = raw.relation;
      if (raw.status === "current_resident") existing.status = raw.status;
      if (raw.movedOutDate) existing.movedOutDate = raw.movedOutDate;
      if (raw.movedTo) existing.movedTo = raw.movedTo;
      if (raw.homeAddress) existing.homeAddress = raw.homeAddress;
    }
  };

  for (const intel of intelPages) {
    const conf = Math.min(0.9, 0.4 + intel.relevance);
    const blob = [
      intel.title,
      intel.githubBio,
      intel.metaDescription,
      ...intel.headings,
      ...intel.profileItems,
      ...intel.snippets,
    ].join("\n");

    homeAddresses.push(...extractStreetAddresses(blob, intel.url, conf));
    for (const l of intel.locations) {
      homeAddresses.push(...extractStreetAddresses(l, intel.url, conf * 0.85));
    }

    for (const f of intel.family ?? []) {
      addMember({
        name: f.name,
        relation: f.relation,
        status: "family",
        phones: [],
        socialProfiles: [],
        sources: [intel.url],
        confidence: conf,
      });
    }

    for (const { re, relation } of CO_RESIDENT_PATTERNS) {
      for (const m of blob.matchAll(new RegExp(re.source, re.flags))) {
        const cap = m[1] ?? "";
        for (const name of cap.split(/,\s*(?:and\s+)?/)) {
          const trimmed = name.trim();
          if (!trimmed) continue;
          addMember({
            name: trimmed,
            relation,
            status: "current_resident",
            phones: [],
            socialProfiles: [],
            sources: [intel.url],
            confidence: conf * 0.85,
          });
        }
      }
    }

    for (const { re, relation } of FAMILY_PHONE_PATTERNS) {
      for (const m of blob.matchAll(new RegExp(re.source, re.flags))) {
        familyPhones.push({
          value: m[1],
          relation,
          source: intel.url,
        });
      }
    }
  }

  for (const page of allPages.slice(0, 100)) {
    const body = loadBody(page);
    if (!body || body.length < 80) continue;
    homeAddresses.push(...extractStreetAddresses(body.slice(0, 100000), page.url, 0.5));

    for (const { re } of MOVE_OUT_PATTERNS) {
      for (const m of body.matchAll(new RegExp(re.source, re.flags))) {
        const member = titleCaseName(m[1] ?? "");
        if (!isLikelyPersonName(member, profile)) continue;
        const idx = m.index ?? 0;
        const date = parseDateNear(body, idx);
        const toAddr = m[3]?.trim() || m[2]?.trim();
        moveHistory.push({
          member,
          fromAddress: homeAddresses[0]?.address,
          toAddress: toAddr && !/^\d{4}/.test(toAddr) ? toAddr : m[2]?.trim(),
          date,
          detail: m[0].replace(/\s+/g, " ").trim().slice(0, 180),
          source: page.url,
        });
        addMember({
          name: member,
          status: "former_resident",
          movedOutDate: date,
          movedTo: toAddr,
          phones: [],
          socialProfiles: [],
          sources: [page.url],
          confidence: 0.65,
        });
      }
    }

    const $ = cheerio.load(body);
    const htmlText = $.root().text();
    for (const f of peopleMap.family) {
      const relMatch = f.value.match(/^(\w+):\s*(.+)$/);
      const relation = relMatch?.[1];
      const memberName = relMatch?.[2]?.trim();
      if (!memberName) continue;
      let idx = htmlText.indexOf(memberName);
      while (idx >= 0) {
        const ctx = htmlText.slice(Math.max(0, idx - 120), idx + memberName.length + 200);
        for (const url of ctx.match(SOCIAL_URL) ?? []) {
          const platform = url.includes("instagram")
            ? "instagram"
            : url.includes("facebook")
              ? "facebook"
              : url.includes("x.com") || url.includes("twitter")
                ? "twitter"
                : url.includes("linkedin")
                  ? "linkedin"
                  : url.includes("github")
                    ? "github"
                    : "other";
          familySocial.push({ member: memberName, relation, platform, url, source: page.url });
        }
        idx = htmlText.indexOf(memberName, idx + memberName.length);
      }
    }
  }

  for (const e of peopleMap.locations.current) {
    homeAddresses.push(...extractStreetAddresses(e.value, e.sources[0] ?? "", e.confidence));
  }

  for (const ev of temporal.datedEvents.filter((e) => e.category === "location")) {
    if (/\b(?:moved|relocated|left)\b/i.test(ev.detail)) {
      moveHistory.push({
        member: profile.phrases[0] ?? profile.raw,
        toAddress: ev.entity,
        date: ev.date,
        detail: ev.detail,
        source: ev.source,
      });
    }
  }

  for (const fp of familyPhones) {
    const fam = peopleMap.family.find((f) => f.context === fp.relation || f.value.startsWith(`${fp.relation}:`));
    if (fam) {
      const name = fam.value.split(":").pop()?.trim();
      fp.member = name;
    }
  }

  const dedupedAddresses = dedupeAddresses(homeAddresses);
  const primaryHome = dedupedAddresses.find((a) => a.status === "current") ?? dedupedAddresses[0];

  if (primaryHome) {
    const geo = geoContextForLookup(profile, peopleMap, primaryHome);
    for (const [key, member] of members) {
      if (!member.homeAddress) member.homeAddress = primaryHome.address;
      member.lookupQuery = geo ? `${member.name} ${geo}` : member.name;
      members.set(key, member);
    }
  }

  for (const intel of intelPages) {
    const blob = [intel.githubBio, ...intel.snippets, ...intel.profileItems].join("\n");
    if (!primaryHome) continue;
    const normHome = primaryHome.normalizedAddress;
    for (const [key, member] of members) {
      if (member.status !== "current_resident" && member.status !== "family") continue;
      const idx = blob.toLowerCase().indexOf(member.name.toLowerCase());
      if (idx < 0) continue;
      const ctx = blob.slice(Math.max(0, idx - 100), idx + member.name.length + 150);
      if (normalizeAddress(ctx).includes(normHome.split(" ").slice(0, 3).join(" ")) || ctx.toLowerCase().includes("same address")) {
        member.confidence = Math.min(0.95, member.confidence + 0.1);
        member.homeAddress = primaryHome.address;
        members.set(key, member);
      }
    }
  }

  return {
    homeAddresses: dedupedAddresses,
    members: [...members.values()].sort((a, b) => b.confidence - a.confidence),
    familyPhones: dedupeFamilyPhones(familyPhones),
    familySocial: dedupeFamilySocial(familySocial),
    moveHistory: moveHistory.slice(0, 30),
  };
}

function dedupeAddresses(items: HomeAddress[]): HomeAddress[] {
  const map = new Map<string, HomeAddress>();
  for (const a of items) {
    const existing = map.get(a.normalizedAddress);
    if (!existing) map.set(a.normalizedAddress, { ...a, sources: [...a.sources] });
    else {
      existing.confidence = Math.max(existing.confidence, a.confidence);
      existing.sources = [...new Set([...existing.sources, ...a.sources])];
      if (a.status === "current") existing.status = "current";
    }
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

function dedupeFamilyPhones(items: HouseholdFamilyPhone[]): HouseholdFamilyPhone[] {
  const map = new Map<string, HouseholdFamilyPhone>();
  for (const p of items) map.set(p.value, p);
  return [...map.values()];
}

function dedupeFamilySocial(items: HouseholdFamilySocial[]): HouseholdFamilySocial[] {
  const map = new Map<string, HouseholdFamilySocial>();
  for (const s of items) map.set(s.url, s);
  return [...map.values()];
}

export interface LinkedPersonAgentOptions {
  maxLinkedPersons?: number;
  linkedDepth?: number;
  /** 0 = use orchestrator config cap; agent still stops at saturation first */
  maxPagesPerPerson?: number;
  maxDepth?: number;
  minRelevance?: number;
  /** Run full algorithm until person-related intelligence stops moving (default true) */
  exhaustive?: boolean;
  includeArchive?: boolean;
  jsRendering?: boolean;
  onProgress?: (message: string) => void;
}

export function selectLinkedPersonCandidates(
  household: HouseholdMap,
  profile: TopicProfile,
): Array<{ name: string; query: string; relation?: string; discoveredFrom: string; confidence: number }> {
  const candidates: Array<{ name: string; query: string; relation?: string; discoveredFrom: string; confidence: number }> = [];

  for (const member of household.members) {
    if (member.confidence < 0.55) continue;
    if (!member.lookupQuery) continue;
    if (!isLikelyPersonName(member.name, profile)) continue;
    const discoveredFrom = member.homeAddress
      ? `${member.relation ?? member.status} at ${member.homeAddress}`
      : member.relation ?? member.status;
    candidates.push({
      name: member.name,
      query: member.lookupQuery,
      relation: member.relation,
      discoveredFrom,
      confidence: member.confidence,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runLinkedPersonAgents(
  config: AppConfig,
  security: NomadSecurityStack | null,
  subjectProfile: TopicProfile,
  household: HouseholdMap,
  opts: LinkedPersonAgentOptions,
): Promise<LinkedPersonIntelligence[]> {
  const maxPersons = opts.maxLinkedPersons ?? 3;
  const depth = opts.linkedDepth ?? 1;
  if (depth <= 0) return [];

  const candidates = selectLinkedPersonCandidates(household, subjectProfile).slice(0, maxPersons);
  if (!candidates.length) return [];

  const { runIntelligenceLookup } = await import("./intelligence.js");
  const results: LinkedPersonIntelligence[] = [];

  for (const candidate of candidates) {
    const prefix = `[${candidate.name}]`;
    opts.onProgress?.(
      `${prefix} Spawning linked-person agent — full intelligence run for "${candidate.query}" (${candidate.discoveredFrom}). Stops when person-related intelligence stops moving.`,
    );
    try {
      const report = await runIntelligenceLookup(config, security, {
        topic: candidate.query,
        maxPages: opts.maxPagesPerPerson ?? 0,
        maxDepth: opts.maxDepth ?? 6,
        minRelevance: opts.minRelevance ?? 0.1,
        exhaustive: opts.exhaustive !== false,
        includeArchive: opts.includeArchive ?? false,
        jsRendering: opts.jsRendering ?? false,
        searchMode: "people",
        linkedDepth: depth - 1,
        maxLinkedPersons: depth > 1 ? (opts.maxLinkedPersons ?? 3) : 0,
        onProgress: (msg) => opts.onProgress?.(`${prefix} ${msg}`),
      });
      const stoppedReason = report.crawlStats.saturated
        ? "Intelligence saturated — no new person-related URLs or dimensions produced additional data"
        : "Stopped at page safety cap before full saturation";
      opts.onProgress?.(
        `${prefix} Agent complete (${report.crawlStats.totalPages} pages, saturated: ${report.crawlStats.saturated ? "yes" : "no"})`,
      );
      results.push({
        name: candidate.name,
        query: candidate.query,
        discoveredFrom: candidate.discoveredFrom,
        relationToSubject: candidate.relation,
        confidence: candidate.confidence,
        saturated: report.crawlStats.saturated,
        stoppedReason,
        crawlStats: report.crawlStats,
        executiveSummary: report.executiveSummary,
        keyFindings: report.keyFindings,
        peopleMap: report.peopleMap,
        linkedPersons: report.linkedPersons ?? [],
      });
    } catch (err) {
      opts.onProgress?.(
        `Linked person agent failed for ${candidate.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return results;
}

export function formatHouseholdMarkdown(household: HouseholdMap): string {
  const lines: string[] = ["## Household & Residence Intelligence", ""];

  lines.push("### Home Address(es)", "");
  if (!household.homeAddresses.length) {
    lines.push("_No street-level home address extracted — add pages with full address or `--seed` property records._", "");
  } else {
    for (const a of household.homeAddresses.slice(0, 8)) {
      lines.push(
        `- **${a.address}** (${a.status}) — confidence ${(a.confidence * 100).toFixed(0)}% — ${a.sources.slice(0, 2).join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push("### Who Lives / Lived There", "");
  if (!household.members.length) {
    lines.push("_No co-residents or household members identified._", "");
  } else {
    for (const m of household.members.slice(0, 20)) {
      const status =
        m.status === "current_resident"
          ? "currently resides"
          : m.status === "former_resident"
            ? "moved out"
            : m.status === "family"
              ? "family"
              : "linked";
      lines.push(`- **${m.name}**${m.relation ? ` (${m.relation})` : ""} — _${status}_`);
      if (m.homeAddress) lines.push(`  - Address: ${m.homeAddress}`);
      if (m.movedOutDate) lines.push(`  - Moved out: ${m.movedOutDate}${m.movedTo ? ` → ${m.movedTo}` : ""}`);
      if (m.phones.length) lines.push(`  - Phones: ${m.phones.map((p) => p.value).join(", ")}`);
      if (m.socialProfiles.length) {
        for (const s of m.socialProfiles.slice(0, 3)) lines.push(`  - ${s.platform}: [${s.url}](${s.url})`);
      }
      if (m.lookupQuery) lines.push(`  - Agent query: \`${m.lookupQuery}\``);
    }
    lines.push("");
  }

  lines.push("### Move History", "");
  if (!household.moveHistory.length) {
    lines.push("_No move-out / relocation events with dates._", "");
  } else {
    for (const mv of household.moveHistory.slice(0, 15)) {
      lines.push(
        `- **${mv.member}**${mv.date ? ` (${mv.date})` : ""}${mv.fromAddress ? ` from ${mv.fromAddress}` : ""}${mv.toAddress ? ` → ${mv.toAddress}` : ""}`,
      );
      lines.push(`  - ${mv.detail.slice(0, 140)} — [source](${mv.source})`);
    }
    lines.push("");
  }

  lines.push("### Family Phone Numbers", "");
  if (!household.familyPhones.length) {
    lines.push("_No family-specific phone numbers extracted._", "");
  } else {
    for (const p of household.familyPhones) {
      lines.push(`- ${p.value}${p.member ? ` (${p.member})` : ""}${p.relation ? ` — ${p.relation}` : ""} — ${p.source}`);
    }
    lines.push("");
  }

  lines.push("### Family Social Media", "");
  if (!household.familySocial.length) {
    lines.push("_No family social profiles linked near name mentions._", "");
  } else {
    for (const s of household.familySocial.slice(0, 20)) {
      lines.push(`- **${s.member}**${s.relation ? ` (${s.relation})` : ""} — ${s.platform}: [${s.url}](${s.url})`);
    }
  }

  return lines.join("\n");
}

export function formatLinkedPersonsMarkdown(linked: LinkedPersonIntelligence[]): string {
  if (!linked.length) return "";
  const lines: string[] = ["## Linked Person Agents (Co-resident / Household Intelligence)", ""];

  for (const lp of linked) {
    lines.push(`### ${lp.name}`, "");
    lines.push(`- **Search query:** \`${lp.query}\``);
    lines.push(`- **Discovered from:** ${lp.discoveredFrom}`);
    if (lp.relationToSubject) lines.push(`- **Relation to subject:** ${lp.relationToSubject}`);
    lines.push(`- **Confidence:** ${(lp.confidence * 100).toFixed(0)}%`);
    lines.push(`- **Saturated:** ${lp.saturated ? "yes" : "no"} — ${lp.stoppedReason}`);
    lines.push(
      `- **Pages crawled:** ${lp.crawlStats.totalPages} (${lp.crawlStats.durationMs ? `${Math.round(lp.crawlStats.durationMs / 1000)}s` : "—"})`,
      "",
    );
    lines.push(lp.executiveSummary, "");
    lines.push("**Key findings:**", "");
    for (const f of lp.keyFindings.slice(0, 8)) lines.push(`- ${f}`);
    if (lp.peopleMap.household.homeAddresses.length) {
      lines.push("", "**Home:**", "");
      for (const a of lp.peopleMap.household.homeAddresses.slice(0, 2)) {
        lines.push(`- ${a.address}`);
      }
    }
    if (lp.peopleMap.socialTrail.profiles.length) {
      lines.push("", "**Social profiles:**", "");
      for (const p of lp.peopleMap.socialTrail.profiles.slice(0, 4)) {
        lines.push(`- ${p.platform}: [${p.profileUrl}](${p.profileUrl})`);
      }
    }
    if (lp.linkedPersons.length) {
      lines.push("", "**Nested linked agents:**", "");
      for (const nested of lp.linkedPersons.slice(0, 3)) {
        lines.push(`- ${nested.name} (saturated: ${nested.saturated ? "yes" : "no"})`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
