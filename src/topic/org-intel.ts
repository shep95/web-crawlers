import type {
  OrganizationAddressLink,
  OrganizationEntityType,
  OrganizationIntel,
  OrganizationSubjectLink,
  PageRecord,
  PeopleIntelligenceMap,
  TopicPageIntel,
} from "../core/models.js";
import type { TopicProfile } from "./index.js";

const LEGAL_FORM_RE = /\b(LLC|L\.L\.C\.|Inc\.|Incorporated|Corp\.|Corporation|Company|Co\.|LP|LLP|PLLC)\b/i;

const OWNERSHIP_PATTERNS: Array<{ re: RegExp; linkType: OrganizationSubjectLink["linkType"]; detail: string }> = [
  { re: /\b(?:founder of|co-founder of|founded|started|launched|established|owner of|owns|my company|our company)\s+/i, linkType: "founder", detail: "founder/owner language" },
  { re: /\b(?:CEO|president|owner)\s+(?:of|at)\s+/i, linkType: "executive", detail: "executive/owner title" },
  { re: /\b(?:works? at|working at|employed at|employee of|staff at)\s+/i, linkType: "employee", detail: "employment language" },
  { re: /\b(?:registered agent|principal address|mailing address)[:\s]/i, linkType: "address_match", detail: "registered filing address context" },
];

const ADDRESS_RE =
  /\b(\d{1,5}\s+[A-Za-z0-9\s]+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place|Cir|Circle)(?:\s+(?:Apt|Unit|Suite|Ste|#)\s?[A-Za-z0-9-]+)?[^,]*,?\s*[A-Za-z\s]+,?\s*(?:FL|Florida|[A-Z]{2})(?:\s+\d{5})?)\b/gi;

function normalizeOrgName(name: string): string {
  return name.toLowerCase().replace(/\s+(llc|inc|corp|corporation|co\.?)$/i, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function extractLegalForm(name: string): string | undefined {
  const m = name.match(LEGAL_FORM_RE);
  return m?.[1]?.replace(/\./g, "");
}

function companyNamesFromPeopleMap(map: PeopleIntelligenceMap): string[] {
  const names = new Set<string>();

  for (const e of map.employment.current) {
    const co = e.value.split("@").pop()?.trim();
    if (co) names.add(co);
  }
  for (const e of map.employment.past) {
    const co = e.value.split("@").pop()?.trim();
    if (co) names.add(co);
  }
  for (const e of map.businesses) names.add(e.value.split("(")[0].trim());
  for (const e of map.organizations) names.add(e.value);
  for (const e of map.connections) {
    if (e.context === "employer" || e.context === "founder") {
      const n = e.value.split(":").pop()?.trim();
      if (n) names.add(n);
    }
  }

  return [...names].filter((n) => n.length >= 3);
}

function subjectTerms(profile: TopicProfile): string[] {
  return [...profile.terms, ...profile.phrases].filter((t) => t.length >= 3);
}

function nameInOrg(orgName: string, profile: TopicProfile): boolean {
  const norm = normalizeOrgName(orgName);
  for (const term of subjectTerms(profile)) {
    if (term.length >= 4 && norm.includes(term)) return true;
  }
  return false;
}

function addressesOverlap(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (na.length < 8 || nb.length < 8) return false;
  const aParts = na.split(" ").filter((p) => p.length > 2);
  const matches = aParts.filter((p) => nb.includes(p)).length;
  return matches >= Math.min(3, aParts.length);
}

function classifyEntityType(
  orgName: string,
  ctx: string,
  profile: TopicProfile,
): { entityType: OrganizationEntityType; isOwned: boolean; reason?: string } {
  for (const { re, linkType } of OWNERSHIP_PATTERNS) {
    if (re.test(ctx)) {
      if (linkType === "founder" || linkType === "executive") {
        return { entityType: "owned_business", isOwned: true, reason: "founder/owner/executive language near org mention" };
      }
      if (linkType === "employee") {
        return { entityType: "employer", isOwned: false, reason: "employment language near org mention" };
      }
    }
  }
  if (LEGAL_FORM_RE.test(orgName)) {
    if (nameInOrg(orgName, profile)) {
      return { entityType: "owned_business", isOwned: true, reason: "registered entity name contains subject name terms" };
    }
    return { entityType: "registered_entity", isOwned: false, reason: "registered legal entity (LLC/Inc/Corp)" };
  }
  if (/\b(?:affiliated|member of|partner)\b/i.test(ctx)) {
    return { entityType: "affiliation", isOwned: false };
  }
  return { entityType: "unknown", isOwned: false };
}

function extractOrgDetailsFromText(
  orgName: string,
  text: string,
  source: string,
  homeAddresses: string[],
  profile: TopicProfile,
): {
  addresses: OrganizationAddressLink[];
  phones: OrganizationIntel["phones"];
  subjectLinks: OrganizationSubjectLink[];
  entityType: OrganizationEntityType;
  isOwned: boolean;
  ownershipReason?: string;
  legalForm?: string;
} {
  const normOrg = normalizeOrgName(orgName);
  const windows: string[] = [];
  const lower = text.toLowerCase();
  const orgLower = orgName.toLowerCase();
  let idx = lower.indexOf(orgLower);
  while (idx >= 0 && windows.length < 12) {
    windows.push(text.slice(Math.max(0, idx - 200), idx + orgName.length + 200));
    idx = lower.indexOf(orgLower, idx + orgName.length);
  }
  if (!windows.length && normOrg.length >= 4) {
    idx = lower.indexOf(normOrg);
    if (idx >= 0) windows.push(text.slice(Math.max(0, idx - 200), idx + normOrg.length + 200));
  }

  const addresses: OrganizationAddressLink[] = [];
  const phones: OrganizationIntel["phones"] = [];
  const subjectLinks: OrganizationSubjectLink[] = [];
  let entityType: OrganizationEntityType = "unknown";
  let isOwned = false;
  let ownershipReason: string | undefined;
  let legalForm = extractLegalForm(orgName);

  for (const ctx of windows) {
    const classified = classifyEntityType(orgName, ctx, profile);
    if (classified.entityType !== "unknown") {
      entityType = classified.entityType;
      isOwned = classified.isOwned;
      ownershipReason = classified.reason;
    }
    if (!legalForm) legalForm = extractLegalForm(ctx);

    for (const { re, linkType, detail } of OWNERSHIP_PATTERNS) {
      if (re.test(ctx)) {
        subjectLinks.push({ linkType, detail, confidence: 0.7, source });
      }
    }

    for (const m of ctx.matchAll(ADDRESS_RE)) {
      const addr = m[0].replace(/\s+/g, " ").trim();
      const linked = homeAddresses.some((h) => addressesOverlap(h, addr));
      addresses.push({
        address: addr,
        addressType: /\b(?:registered|principal|mailing|agent)\b/i.test(ctx) ? "registered" : "business",
        linkedToSubjectHome: linked,
        linkReason: linked ? "address matches subject home/residence on file" : undefined,
        source,
      });
      if (linked) {
        subjectLinks.push({
          linkType: "address_match",
          detail: `Org address overlaps subject residence: ${addr}`,
          confidence: 0.75,
          source,
        });
        if (!isOwned) {
          isOwned = true;
          entityType = "owned_business";
          ownershipReason = "organization address matches subject home address";
        }
      }
    }

    const phoneMatches = ctx.match(/(?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4}/g) ?? [];
    for (const p of phoneMatches) phones.push({ value: p, source });
  }

  if (nameInOrg(orgName, profile) && !isOwned) {
    isOwned = true;
    entityType = "owned_business";
    ownershipReason = "organization name includes subject name terms";
    subjectLinks.push({
      linkType: "name_match",
      detail: "Org name contains subject name tokens",
      confidence: 0.6,
      source,
    });
  }

  return {
    addresses,
    phones,
    subjectLinks,
    entityType,
    isOwned,
    ownershipReason,
    legalForm,
  };
}

export function buildOrganizationIntelMap(
  intelPages: TopicPageIntel[],
  peopleMap: PeopleIntelligenceMap,
  profile: TopicProfile,
  allPages: PageRecord[],
  loadBody: (page: PageRecord) => string,
): OrganizationIntel[] {
  const orgNames = companyNamesFromPeopleMap(peopleMap);
  const homeAddresses = [
    ...peopleMap.locations.current.map((e) => e.value),
    ...peopleMap.workplaces.filter((w) => w.context?.includes("address")).map((e) => e.value),
    ...intelPages.flatMap((i) => i.locations ?? []),
  ];

  const results: OrganizationIntel[] = [];

  for (const orgName of orgNames) {
    const norm = normalizeOrgName(orgName);
    const relatedPages: string[] = [];
    const sources = new Set<string>();
    let addresses: OrganizationAddressLink[] = [];
    let phones: OrganizationIntel["phones"] = [];
    let subjectLinks: OrganizationSubjectLink[] = [];
    let entityType: OrganizationEntityType = "unknown";
    let isOwned = false;
    let ownershipReason: string | undefined;
    let legalForm = extractLegalForm(orgName);
    let confidence = 0.45;

    for (const intel of intelPages) {
      const blob = [
        intel.title,
        intel.githubBio,
        intel.metaDescription,
        ...intel.headings,
        ...intel.profileItems,
        ...intel.snippets,
      ].join("\n");
      if (!blob.toLowerCase().includes(norm.split(" ")[0]) && !blob.toLowerCase().includes(orgName.toLowerCase())) {
        continue;
      }
      relatedPages.push(intel.url);
      sources.add(intel.url);
      confidence = Math.max(confidence, 0.4 + intel.relevance);
      const extracted = extractOrgDetailsFromText(orgName, blob, intel.url, homeAddresses, profile);
      addresses.push(...extracted.addresses);
      phones.push(...extracted.phones);
      subjectLinks.push(...extracted.subjectLinks);
      if (extracted.entityType !== "unknown") entityType = extracted.entityType;
      if (extracted.isOwned) {
        isOwned = true;
        ownershipReason = extracted.ownershipReason;
      }
      if (extracted.legalForm) legalForm = extracted.legalForm;
    }

    for (const page of allPages) {
      const body = loadBody(page);
      if (!body || body.length < 80) continue;
      const lower = body.toLowerCase();
      if (!lower.includes(orgName.toLowerCase()) && !lower.includes(norm)) continue;
      relatedPages.push(page.url);
      sources.add(page.url);
      const extracted = extractOrgDetailsFromText(orgName, body.slice(0, 100000), page.url, homeAddresses, profile);
      addresses.push(...extracted.addresses);
      phones.push(...extracted.phones);
      subjectLinks.push(...extracted.subjectLinks);
      if (extracted.entityType !== "unknown") entityType = extracted.entityType;
      if (extracted.isOwned) {
        isOwned = true;
        ownershipReason = extracted.ownershipReason;
      }
      if (extracted.legalForm) legalForm = extracted.legalForm;
    }

    for (const biz of peopleMap.businesses) {
      if (normalizeOrgName(biz.value).includes(norm) || norm.includes(normalizeOrgName(biz.value))) {
        entityType = "owned_business";
        isOwned = true;
        ownershipReason = ownershipReason ?? "listed under subject businesses/LLCs";
        if (biz.context) legalForm = legalForm ?? biz.context;
      }
    }

    const isRegistered = Boolean(legalForm || LEGAL_FORM_RE.test(orgName));

    results.push({
      name: orgName,
      normalizedName: norm,
      legalForm,
      entityType: isOwned ? "owned_business" : entityType,
      isLikelyOwnedBySubject: isOwned,
      ownershipReason,
      isRegisteredEntity: isRegistered,
      addresses: dedupeAddresses(addresses),
      phones: dedupePhones(phones),
      subjectLinks: dedupeSubjectLinks(subjectLinks),
      relatedPages: [...new Set(relatedPages)].slice(0, 10),
      sources: [...sources].slice(0, 10),
      confidence: Math.min(0.95, confidence),
    });
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

function dedupeAddresses(items: OrganizationAddressLink[]): OrganizationAddressLink[] {
  const map = new Map<string, OrganizationAddressLink>();
  for (const a of items) {
    const key = a.address.toLowerCase();
    map.set(key, map.get(key) ?? a);
  }
  return [...map.values()];
}

function dedupePhones(items: OrganizationIntel["phones"]): OrganizationIntel["phones"] {
  const map = new Map<string, OrganizationIntel["phones"][0]>();
  for (const p of items) map.set(p.value, p);
  return [...map.values()];
}

function dedupeSubjectLinks(items: OrganizationSubjectLink[]): OrganizationSubjectLink[] {
  const map = new Map<string, OrganizationSubjectLink>();
  for (const s of items) {
    const key = `${s.linkType}:${s.detail}`;
    const existing = map.get(key);
    if (!existing || s.confidence > existing.confidence) map.set(key, s);
  }
  return [...map.values()];
}

export function formatOrganizationMarkdown(orgs: OrganizationIntel[]): string {
  const lines: string[] = ["## Organization & Company Intelligence", ""];

  if (!orgs.length) {
    lines.push("_No companies/organizations mapped from crawled data._", "");
    return lines.join("\n");
  }

  for (const org of orgs) {
    const owned = org.isLikelyOwnedBySubject ? "**likely his/their company**" : "**external company/employer**";
    const reg = org.isRegisteredEntity ? `registered ${org.legalForm ?? "entity"}` : "informal/unregistered name";
    lines.push(`### ${org.name}`, "");
    lines.push(`- **Classification:** ${owned} · ${reg} · type: ${org.entityType}`);
    if (org.ownershipReason) lines.push(`- **Ownership link:** ${org.ownershipReason}`);
    if (org.legalForm) lines.push(`- **Legal form:** ${org.legalForm}`);
    lines.push(`- **Confidence:** ${(org.confidence * 100).toFixed(0)}%`);

    if (org.subjectLinks.length) {
      lines.push("- **Connection to subject:**");
      for (const link of org.subjectLinks.slice(0, 5)) {
        lines.push(`  - ${link.linkType}: ${link.detail} (${(link.confidence * 100).toFixed(0)}%) — ${link.source}`);
      }
    }

    if (org.addresses.length) {
      lines.push("- **Addresses:**");
      for (const a of org.addresses.slice(0, 5)) {
        const home = a.linkedToSubjectHome ? " ⚠ **matches subject home/residence**" : "";
        lines.push(`  - [${a.addressType}] ${a.address}${home} — ${a.source}`);
      }
    }

    if (org.phones.length) {
      lines.push(`- **Phones:** ${org.phones.slice(0, 3).map((p) => p.value).join(", ")}`);
    }

    if (org.relatedPages.length) {
      lines.push("- **Related pages:**");
      for (const u of org.relatedPages.slice(0, 4)) lines.push(`  - [${u}](${u})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function collectOrganizationSeeds(orgs: OrganizationIntel[]): string[] {
  const seeds: string[] = [];
  for (const org of orgs.slice(0, 5)) {
    const q = encodeURIComponent(org.name);
    seeds.push(`https://github.com/search?q=${q}&type=repositories`);
    seeds.push(`https://github.com/search?q=${q}&type=users`);
    if (org.isRegisteredEntity || org.legalForm) {
      const base = org.name.replace(/\s+(LLC|Inc|Corp\.?)/i, "").trim();
      seeds.push(
        `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=EntityName&searchNameOrder=${encodeURIComponent(base.toUpperCase())}`,
      );
    }
  }
  return [...new Set(seeds)].slice(0, 8);
}
