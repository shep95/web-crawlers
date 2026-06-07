import type {
  IntelligenceEntity,
  IntelligenceTimelineEvent,
  PeopleIntelligenceMap,
  TopicPageIntel,
} from "../core/models.js";

import { extractKnowledgeDomains } from "./knowledge-intel.js";
import { emptySocialTrail, formatSocialTrailMarkdown } from "./social-trail.js";
import { emptyTemporalMap, formatTemporalMarkdown } from "./temporal-intel.js";
import { formatOrganizationMarkdown } from "./org-intel.js";
import { emptyHouseholdMap, formatHouseholdMarkdown } from "./household-intel.js";

export interface FamilyMention {
  relation: string;
  name: string;
}

export interface ConnectionMention {
  type: string;
  name: string;
  url?: string;
}

export interface ExtractedPeopleData {
  phones: string[];
  emails: string[];
  locations: string[];
  pastLocations: string[];
  origins: string[];
  family: FamilyMention[];
  connections: ConnectionMention[];
  organizations: string[];
  knowledgeDomains: string[];
  employment: Array<{ role: string; company: string; period?: string }>;
  pastEmployment: Array<{ role: string; company: string; period?: string }>;
  businesses: Array<{ name: string; type?: string }>;
  government: string[];
  workplaces: Array<{ name: string; address?: string; phone?: string }>;
  coworkers: Array<{ name: string; context?: string }>;
  compensation: string[];
}

const US_PHONE =
  /(?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4}\b/g;

const US_LOCATION =
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}),?\s+(Alabama|AL|Alaska|AK|Arizona|AZ|Arkansas|AR|California|CA|Colorado|CO|Connecticut|CT|Delaware|DE|Florida|FL|Georgia|GA|Hawaii|HI|Idaho|ID|Illinois|IL|Indiana|IN|Iowa|IA|Kansas|KS|Kentucky|KY|Louisiana|LA|Maine|ME|Maryland|MD|Massachusetts|MA|Michigan|MI|Minnesota|MN|Mississippi|MS|Missouri|MO|Montana|MT|Nebraska|NE|Nevada|NV|New Hampshire|NH|New Jersey|NJ|New Mexico|NM|New York|NY|North Carolina|NC|North Dakota|ND|Ohio|OH|Oklahoma|OK|Oregon|OR|Pennsylvania|PA|Rhode Island|RI|South Carolina|SC|South Dakota|SD|Tennessee|TN|Texas|TX|Utah|UT|Vermont|VT|Virginia|VA|Washington|WA|West Virginia|WV|Wisconsin|WI|Wyoming|WY|United States|USA)\b/g;

const US_STATE_ABBR = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}),?\s+([A-Z]{2})\b/g;

const ORIGIN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(?:born in|birthplace[:\s]+|native of|from)\s+([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3}(?:,\s*(?:FL|Florida|[A-Z]{2}))?)/gi, label: "origin" },
  { re: /\b(?:raised in|grew up in|hometown[:\s]+|originally from)\s+([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3})/gi, label: "origin" },
  { re: /\b(?:roots in|heritage from|descended from|family from)\s+([A-Za-z\s,]+?)(?:\.|,|$)/gi, label: "origin" },
];

const PAST_LOCATION_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\b(?:formerly (?:in|of|from|lived in)|previously (?:in|from|lived in)|used to live in|lived in)\s+([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3}(?:,\s*(?:FL|Florida|[A-Z]{2}))?)/gi },
  { re: /\b(?:moved from|relocated from|transferred from)\s+([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3})/gi },
  { re: /\b(?:attended|graduated from|studied at|alumni of)\s+([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,4})/gi },
];

const CURRENT_LOCATION_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\b(?:lives in|living in|based in|located in|resides in|currently in|now in|lives at|resides at)\s+([A-Z][a-z0-9]+(?:[\s,]+[A-Za-z0-9]+){0,6}(?:,\s*(?:FL|Florida|[A-Z]{2}))?)/gi },
  { re: /\b([0-9]{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court)[^,]*,?\s*[A-Z][a-z]+,?\s*(?:FL|Florida|[A-Z]{2}))\b/gi },
];

const FAMILY_PATTERNS: Array<{ re: RegExp; relation: string }> = [
  { re: /\b(?:mother|mom|mama)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "mother" },
  { re: /\b(?:father|dad|papa)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "father" },
  { re: /\b(?:spouse|wife|husband|partner)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "spouse" },
  { re: /\b(?:son|daughter|child)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "child" },
  { re: /\b(?:brother|sister|sibling)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "sibling" },
  { re: /\b(?:married to|engaged to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "spouse" },
  { re: /\b(?:parent(?:s)?|guardian)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "parent" },
  { re: /\b(?:grandmother|grandma|nana)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "grandparent" },
  { re: /\b(?:grandfather|grandpa)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi, relation: "grandparent" },
];

const CONNECTION_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /\b(?:works? at|working at|employed (?:by|at)|employee of|staff at|job at)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50})/gi, type: "employer" },
  { re: /\b(?:founder of|co-founder of|created|built|owner of|owns)\s+([A-Z][A-Za-z0-9\s&.#'-]{2,50})/gi, type: "founder" },
  { re: /\b(?:CEO|CTO|COO|CFO|president|director|manager|engineer|developer|specialist|analyst|consultant|designer|architect|prompt expert)\s+(?:of|at|,?\s+at)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50})/gi, type: "executive" },
  { re: /\b(?:member of|affiliated with|associated with|part of)\s+([A-Z][A-Za-z0-9\s&.#'-]{2,50})/gi, type: "affiliation" },
  { re: /\b(?:collaborat(?:e|es|ed|ing) with|partnered with|teamed with)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50})/gi, type: "collaborator" },
];

const PAST_EMPLOYMENT_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\b(?:formerly (?:at|with)|previously (?:at|worked at)|used to work at|ex-employee of|past role at|retired from)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50})/gi },
  { re: /\b(?:former|ex-)\s+(CEO|CTO|engineer|developer|manager|director|analyst|specialist|consultant)\s+(?:at|of)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50})/gi },
];

const BUSINESS_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /\b([A-Z][A-Za-z0-9\s&.'-]{2,40})\s+(?:LLC|L\.L\.C\.|Inc\.|Corp\.|Corporation|Company|Co\.)\b/gi, type: "registered entity" },
  { re: /\b(?:registered business|business name|DBA|doing business as)[:\s]+([A-Za-z0-9\s&.'-]{2,50})/gi, type: "DBA" },
  { re: /\b(?:founded|started|launched|established)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50})/gi, type: "startup" },
];

const COMPENSATION_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\$\s?[\d,]+(?:\.\d{2})?\s*(?:\/\s?(?:hr|hour)|per hour|hourly)/gi },
  { re: /\$\s?[\d,]+(?:k|,000)?\s*(?:\/\s?(?:yr|year)|per year|annually|salary)/gi },
  { re: /\b(?:salary|compensation|pay(?:s|ing)?|earns?|income)[:\s]+\$?\s?[\d,]+(?:\.\d{2})?(?:\s*(?:\/\s?(?:hr|hour|yr|year)|per hour|per year|k|annually))?/gi },
];

const WORKPLACE_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\b(?:office(?:s)? at|store at|branch at|located at|headquarters at|building at)\s+([0-9]{0,5}\s?[A-Za-z0-9\s,.'-]{5,80})/gi },
  { re: /\b(?:company phone|office phone|business phone|main line)[:\s]+((?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4})/gi },
];

const COWORKER_PATTERNS: Array<{ re: RegExp }> = [
  { re: /\b(?:colleague|co-worker|coworker|teammate|team member|works with|partnered with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi },
];

const EXPERTISE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(prompt expert|prompt engineering|prompt engineer|AI specialist|AI expert|machine learning engineer|ML engineer)\b/gi, label: "AI / Prompt Engineering" },
  { re: /\b(cybersecurity specialist|security researcher|OSINT analyst|ethical hacker)\b/gi, label: "Cybersecurity" },
  { re: /\b(software engineer|full.?stack developer|web developer|data scientist|devops engineer)\b/gi, label: "Software Engineering" },
  { re: /\b(?:specialist in|expert in|focused on|niche in|training in|specializes in)\s+([A-Za-z0-9\s&/-]{3,40})/gi, label: "domain" },
  { re: /\b(?:niche)[:\s]+([A-Za-z0-9\s&/-]{3,40})/gi, label: "niche" },
];

const GOVERNMENT_URL = /\.gov(?:\/|$)/i;
const GOVERNMENT_TEXT =
  /\b(federal employee|state employee|government employee|public servant|military|veteran|us army|us navy|department of|city of [A-Z][a-z]+|county of [A-Z][a-z]+)\b/gi;

const ORG_FROM_URL =
  /github\.com\/(?:orgs\/)?([A-Za-z0-9_-]{2,40})/i;

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function cleanCapture(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
}

function isValidPhone(p: string): boolean {
  const digits = p.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return false;
  if (/^(19|20)\d{2}/.test(digits)) return false;
  return true;
}

function matchAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(r)) {
    const cap = m[1] ?? m[0];
    if (cap) out.push(cleanCapture(cap));
  }
  return out;
}

export function extractPeopleDataFromText(text: string): ExtractedPeopleData {
  const phones = unique((text.match(US_PHONE) ?? []).filter(isValidPhone)).slice(0, 8);
  const emails = unique(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).slice(0, 8);

  const locations: string[] = [];
  const pastLocations: string[] = [];
  const origins: string[] = [];

  for (const m of text.matchAll(US_LOCATION)) locations.push(cleanCapture(m[0]));
  for (const m of text.matchAll(US_STATE_ABBR)) {
    const st = m[2];
    if (st.length === 2 && st !== "ST" && st !== "DR") locations.push(cleanCapture(m[0]));
  }

  for (const { re } of CURRENT_LOCATION_PATTERNS) {
    locations.push(...matchAll(text, re));
  }
  for (const { re } of PAST_LOCATION_PATTERNS) {
    pastLocations.push(...matchAll(text, re));
  }
  for (const { re } of ORIGIN_PATTERNS) {
    origins.push(...matchAll(text, re));
  }

  const family: FamilyMention[] = [];
  for (const { re, relation } of FAMILY_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const name = cleanCapture(m[1] ?? "");
      if (name.length >= 2 && name.length <= 60) family.push({ relation, name });
    }
  }

  const connections: ConnectionMention[] = [];
  for (const { re, type } of CONNECTION_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const name = cleanCapture(m[1] ?? "");
      if (name.length >= 2 && name.length <= 80) connections.push({ type, name });
    }
  }

  const organizations: string[] = [];
  for (const m of text.matchAll(/\b(?:at|@)\s+([A-Z][A-Za-z0-9\s&.#-]{2,40})/g)) {
    organizations.push(cleanCapture(m[1]));
  }

  const knowledgeDomains = extractKnowledgeDomains(text);
  for (const { re, label } of EXPERTISE_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      knowledgeDomains.push(cleanCapture(m[1] ?? m[0] ?? label));
    }
  }

  const employment: ExtractedPeopleData["employment"] = [];
  for (const { re, type } of CONNECTION_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const company = cleanCapture(m[1] ?? "");
      if (company.length >= 2) employment.push({ role: type, company, period: "present" });
    }
  }

  const pastEmployment: ExtractedPeopleData["pastEmployment"] = [];
  for (const { re } of PAST_EMPLOYMENT_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const company = cleanCapture(m[2] ?? m[1] ?? "");
      const role = cleanCapture(m[1] ?? "former employee");
      if (company.length >= 2) pastEmployment.push({ role, company, period: "past" });
    }
  }

  const businesses: ExtractedPeopleData["businesses"] = [];
  for (const { re, type } of BUSINESS_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const name = cleanCapture(m[1] ?? m[0] ?? "");
      if (name.length >= 2) businesses.push({ name, type });
    }
  }

  const compensation = unique(
    COMPENSATION_PATTERNS.flatMap(({ re }) => [...text.matchAll(new RegExp(re.source, re.flags))].map((m) => cleanCapture(m[0]))),
  ).slice(0, 8);

  const workplaces: ExtractedPeopleData["workplaces"] = [];
  for (const { re } of WORKPLACE_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const val = cleanCapture(m[1] ?? "");
      if (/^\(?[2-9]/.test(val.replace(/\D/g, "")) || val.replace(/\D/g, "").length >= 10) {
        workplaces.push({ name: "employer", phone: val });
      } else if (val.length >= 5) {
        workplaces.push({ name: "workplace", address: val });
      }
    }
  }

  const coworkers: ExtractedPeopleData["coworkers"] = [];
  for (const { re } of COWORKER_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const name = cleanCapture(m[1] ?? "");
      if (name.length >= 2) coworkers.push({ name, context: "colleague" });
    }
  }

  const government: string[] = [];
  for (const m of text.matchAll(GOVERNMENT_TEXT)) government.push(cleanCapture(m[0]));

  return {
    phones,
    emails,
    locations: unique(locations),
    pastLocations: unique(pastLocations),
    origins: unique(origins),
    family: unique(family.map((f) => JSON.stringify(f))).map((s) => JSON.parse(s) as FamilyMention),
    connections: unique(connections.map((c) => JSON.stringify(c))).map((s) => JSON.parse(s) as ConnectionMention),
    organizations: unique(organizations).slice(0, 15),
    knowledgeDomains: unique(knowledgeDomains),
    employment: unique(employment.map((e) => JSON.stringify(e))).map((s) => JSON.parse(s) as ExtractedPeopleData["employment"][0]),
    pastEmployment: unique(pastEmployment.map((e) => JSON.stringify(e))).map((s) => JSON.parse(s) as ExtractedPeopleData["pastEmployment"][0]),
    businesses: unique(businesses.map((b) => JSON.stringify(b))).map((s) => JSON.parse(s) as ExtractedPeopleData["businesses"][0]),
    government: unique(government),
    workplaces: unique(workplaces.map((w) => JSON.stringify(w))).map((s) => JSON.parse(s) as ExtractedPeopleData["workplaces"][0]),
    coworkers: unique(coworkers.map((c) => JSON.stringify(c))).map((s) => JSON.parse(s) as ExtractedPeopleData["coworkers"][0]),
    compensation,
  };
}

export function extractOrgFromUrl(url: string): string | null {
  const m = url.match(ORG_FROM_URL);
  if (!m) return null;
  const org = m[1];
  if (["orgs", "features", "settings", "login"].includes(org.toLowerCase())) return null;
  return org;
}

export function extractGovernmentFromUrl(url: string): string | null {
  if (!GOVERNMENT_URL.test(url)) return null;
  return url;
}

export function emptyPeopleMap(): PeopleIntelligenceMap {
  return {
    locations: { current: [], past: [], origins: [] },
    connections: [],
    family: [],
    phones: [],
    emails: [],
    organizations: [],
    knowledgeDomains: [],
    employment: { current: [], past: [], compensation: [] },
    businesses: [],
    government: [],
    workplaces: [],
    coworkers: [],
    history: [],
    historicData: [],
    socialTrail: emptySocialTrail(),
    organizationMap: [],
    temporal: emptyTemporalMap(),
    household: emptyHouseholdMap(),
  };
}

export interface ProfileTerms {
  terms: string[];
}

export function entitiesFromPeopleData(
  data: ExtractedPeopleData,
  source: string,
  confidence: number,
  profile?: ProfileTerms,
): IntelligenceEntity[] {
  const entities: IntelligenceEntity[] = [];
  const add = (type: IntelligenceEntity["type"], value: string, ctx?: string) => {
    if (!value || value.length < 2) return;
    entities.push({
      type,
      value,
      confidence,
      sources: [source],
      context: ctx,
      period:
        type === "past_location" || type === "past_employment" || type === "origin"
          ? "past"
          : "present",
    });
  };

  for (const p of data.phones) add("phone", p);
  for (const e of data.emails) add("email", e);
  for (const l of data.locations) add("location", l, "current");
  for (const l of data.pastLocations) add("past_location", l, "former residence");
  for (const o of data.origins) add("origin", o, "origin/hometown");
  for (const f of data.family) add("family", `${f.relation}: ${f.name}`, f.relation);
  for (const c of data.connections) add("connection", `${c.type}: ${c.name}`, c.type);
  for (const org of data.organizations) add("organization", org);
  for (const d of data.knowledgeDomains) add("knowledge_domain", d, "expertise niche");
  for (const j of data.employment) add("employment", `${j.role} @ ${j.company}`, j.role);
  for (const j of data.pastEmployment) add("past_employment", `${j.role} @ ${j.company}`, j.role);
  for (const b of data.businesses) add("business", `${b.name}${b.type ? ` (${b.type})` : ""}`, b.type);
  for (const g of data.government) add("government", g, "government presence");
  for (const w of data.workplaces) {
    if (w.address) add("workplace", w.address, "workplace address");
    if (w.phone) add("workplace", `company phone: ${w.phone}`, "company phone");
  }
  for (const c of data.coworkers) add("coworker", c.name, c.context);
  for (const pay of data.compensation) add("compensation", pay, "pay/salary");

  if (profile) {
    for (const term of profile.terms) {
      if (term.length >= 4) {
        for (const l of data.locations) {
          if (l.toLowerCase().includes(term)) add("location", l, "query-linked");
        }
      }
    }
  }
  return entities;
}

export function buildPeopleMap(
  intelPages: TopicPageIntel[],
  timeline: IntelligenceTimelineEvent[],
  profile: ProfileTerms,
): PeopleIntelligenceMap {
  const all: IntelligenceEntity[] = [];

  for (const intel of intelPages) {
    const conf = Math.min(0.95, 0.35 + intel.relevance);
    const blob = [
      intel.title,
      intel.githubBio,
      intel.metaDescription,
      ...intel.headings,
      ...intel.profileItems,
      ...intel.snippets,
    ].join(" ");

    const extracted = extractPeopleDataFromText(blob);
    for (const p of intel.phones ?? []) extracted.phones.push(p);
    for (const e of intel.emails) extracted.emails.push(e);
    for (const l of intel.locations) extracted.locations.push(l);
    for (const l of intel.pastLocations ?? []) extracted.pastLocations.push(l);
    for (const o of intel.origins ?? []) extracted.origins.push(o);
    for (const f of intel.family ?? []) extracted.family.push(f);
    for (const c of intel.connections ?? []) extracted.connections.push(c);

    for (const link of intel.socialLinks) {
      const org = extractOrgFromUrl(link);
      if (org) extracted.organizations.push(org);
      extracted.connections.push({ type: "social_profile", name: link, url: link });
    }
    const gov = extractGovernmentFromUrl(intel.url);
    if (gov) extracted.government.push(gov);
    for (const d of intel.knowledgeDomains ?? []) extracted.knowledgeDomains.push(d);
    for (const j of intel.employment ?? []) extracted.employment.push(j);
    for (const j of intel.pastEmployment ?? []) extracted.pastEmployment.push(j);
    for (const b of intel.businesses ?? []) extracted.businesses.push(b);
    for (const w of intel.workplaces ?? []) extracted.workplaces.push(w);
    for (const c of intel.coworkers ?? []) extracted.coworkers.push(c);
    for (const g of intel.government ?? []) extracted.government.push(g);
    for (const p of intel.compensation ?? []) extracted.compensation.push(p);

    all.push(...entitiesFromPeopleData(extracted, intel.url, conf, profile));
  }

  const merged = mergePeopleEntities(all);

  const historicData = timeline
    .filter((e) => e.label === "Wayback snapshot" || e.date !== "present")
    .reduce<Array<{ period: string; url: string; findings: string[]; sources: string[] }>>((acc, e) => {
      const existing = acc.find((h) => h.period === e.date && h.url === e.source);
      if (existing) {
        if (e.detail) existing.findings.push(e.detail);
      } else {
        acc.push({
          period: e.date,
          url: e.source,
          findings: e.detail ? [e.detail] : [],
          sources: [e.source],
        });
      }
      return acc;
    }, []);

  return {
    locations: {
      current: merged.filter((e) => e.type === "location"),
      past: merged.filter((e) => e.type === "past_location"),
      origins: merged.filter((e) => e.type === "origin"),
    },
    connections: merged.filter((e) => e.type === "connection"),
    family: merged.filter((e) => e.type === "family"),
    phones: merged.filter((e) => e.type === "phone"),
    emails: merged.filter((e) => e.type === "email"),
    organizations: merged.filter((e) => e.type === "organization"),
    knowledgeDomains: merged.filter((e) => e.type === "knowledge_domain"),
    employment: {
      current: merged.filter((e) => e.type === "employment"),
      past: merged.filter((e) => e.type === "past_employment"),
      compensation: merged.filter((e) => e.type === "compensation"),
    },
    businesses: merged.filter((e) => e.type === "business"),
    government: merged.filter((e) => e.type === "government"),
    workplaces: merged.filter((e) => e.type === "workplace"),
    coworkers: merged.filter((e) => e.type === "coworker"),
    history: timeline,
    historicData: historicData.slice(0, 40),
    socialTrail: emptySocialTrail(),
    organizationMap: [],
    temporal: emptyTemporalMap(),
    household: emptyHouseholdMap(),
  };
}

function mergePeopleEntities(entities: IntelligenceEntity[]): IntelligenceEntity[] {
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

export function formatPeopleMapMarkdown(map: PeopleIntelligenceMap): string {
  const lines: string[] = ["## People Intelligence Map", ""];

  const section = (title: string, items: IntelligenceEntity[]) => {
    lines.push(`### ${title}`, "");
    if (!items.length) {
      lines.push("_No data extracted from public pages._", "");
      return;
    }
    for (const e of items.slice(0, 20)) {
      const ctx = e.context ? ` (${e.context})` : "";
      const src = e.sources.slice(0, 2).join(", ");
      lines.push(`- **${e.value}**${ctx} — confidence ${(e.confidence * 100).toFixed(0)}% — ${src}`);
    }
    lines.push("");
  };

  section("Current Locations", map.locations.current);
  section("Past Locations", map.locations.past);
  section("Origins / Hometown / Roots", map.locations.origins);
  section("Knowledge Domains & Expertise Niches", map.knowledgeDomains);
  section("Current Employment", map.employment.current);
  section("Past Employment & Job History", map.employment.past);
  section("Compensation (Salary / Hourly)", map.employment.compensation);
  section("Businesses & LLCs", map.businesses);
  section("Government Presence", map.government);
  section("Workplaces (Addresses & Company Phones)", map.workplaces);
  section("Co-workers & Colleagues", map.coworkers);
  section("Phone Numbers (Personal)", map.phones);
  section("Email Addresses", map.emails);
  section("Family & Relatives", map.family);
  section("Connections (Professional & Social)", map.connections);
  section("Organizations & Affiliations", map.organizations);

  lines.push(formatHouseholdMarkdown(map.household));
  lines.push(formatSocialTrailMarkdown(map.socialTrail));
  lines.push(formatOrganizationMarkdown(map.organizationMap));
  lines.push(formatTemporalMarkdown(map.temporal));

  lines.push("### Past History & Timeline", "");
  if (!map.history.length) {
    lines.push("_No timeline events recorded._", "");
  } else {
    for (const e of map.history.slice(0, 25)) {
      lines.push(`- **${e.date}** — ${e.label}: ${e.detail ?? e.source}`);
    }
    lines.push("");
  }

  lines.push("### Historic Data (Internet Archive & Past Captures)", "");
  if (!map.historicData.length) {
    lines.push("_No archival snapshots in this run — omit `--no-archive` to include Wayback history._", "");
  } else {
    for (const h of map.historicData.slice(0, 15)) {
      lines.push(`- **${h.period}** — ${h.url}`);
      for (const f of h.findings.slice(0, 2)) lines.push(`  - ${f.slice(0, 180)}`);
    }
  }

  return lines.join("\n");
}
