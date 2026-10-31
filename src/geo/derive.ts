/**
 * Three separate geographies for one result, each with its own evidence — never merged:
 *
 *   hosting    what the host's country-code TLD hints (weak: a ccTLD is a DNS delegation, not a location)
 *   publisher  whose government / academic domain serves it, or which country its stated publisher names
 *   subject    the countries the result is about: named in its title, description or spatial-coverage metadata
 *
 * Missing evidence is "unknown" (cc: null), never a guess.
 */
import { findPlaces, placeName, publicDomainOf, tldHint, type PlaceMatch } from "./registry.js";

export interface SubjectPlace { cc: string; name: string; evidence: string; fields: string[]; uncertain?: string; candidates?: string[] }
export interface ResultGeography {
  hosting: { cc: string | null; name?: string; evidence: string; basis: "cctld_weak_hint" | "unknown" };
  publisher: { cc: string | null; name?: string; evidence: string; basis: "public_domain_suffix" | "publisher_statement" | "unknown"; alsoStated?: string[]; uncertain?: string };
  subject: SubjectPlace[];
}

type FactLike = { value: unknown; field?: string };
export interface GeographyInput {
  host?: string | null;
  title?: string | null;
  description?: string | null;
  facts?: { publisher?: FactLike[]; spatialCoverage?: FactLike[] } | null;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string").join(" ") : "");
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function deriveGeography(r: GeographyInput): ResultGeography {
  const host = (r.host ?? "").toLowerCase();

  // Hosting: the ccTLD, labelled as a weak hint.
  const tld = host ? tldHint(host) : null;
  const hosting: ResultGeography["hosting"] = tld?.cc ? { cc: tld.cc, name: placeName(tld.cc), evidence: tld.evidence, basis: "cctld_weak_hint" } : { cc: null, evidence: tld ? `unknown (${tld.evidence})` : "unknown (no host recorded)", basis: "unknown" };

  // Publisher: a known government/academic domain, else the country the stated publisher names.
  const stated: Array<{ m: PlaceMatch; text: string }> = [];
  for (const f of r.facts?.publisher ?? []) {
    const text = asText(f.value);
    for (const m of findPlaces(text)) stated.push({ m, text });
  }
  const firm = stated.filter((s) => !s.m.uncertain);
  const dom = host ? publicDomainOf(host) : null;
  let publisher: ResultGeography["publisher"];
  if (dom) {
    const others = [...new Set(firm.map((s) => s.m.code).filter((c) => c !== dom.code))];
    publisher = { cc: dom.code, name: placeName(dom.code), evidence: `served from ${host}, under ${dom.suffix} (a ${dom.kind} domain of ${placeName(dom.code)})`, basis: "public_domain_suffix", ...(others.length ? { alsoStated: others } : {}) };
  } else if (stated.length) {
    const best = firm[0] ?? stated[0];
    publisher = { cc: best.m.code, name: placeName(best.m.code), evidence: `publisher stated as "${clip(best.text)}"`, basis: "publisher_statement", ...(best.m.uncertain ? { uncertain: best.m.uncertain } : {}) };
  } else {
    publisher = { cc: null, evidence: (r.facts?.publisher ?? []).length ? `unknown (stated publisher "${clip(asText(r.facts!.publisher![0].value))}" names no country)` : "unknown (no publisher recorded and no known public-sector domain)", basis: "unknown" };
  }

  // Subject: countries named in what the result says about itself.
  const subject: SubjectPlace[] = [];
  const scan = (text: string, field: string) => {
    for (const m of findPlaces(text)) {
      const had = subject.find((s) => s.cc === m.code);
      if (had) { if (!had.fields.includes(field)) had.fields.push(field); if (!m.uncertain) delete had.uncertain; continue; }
      subject.push({ cc: m.code, name: placeName(m.code), evidence: `"${m.text}" in ${field}`, fields: [field], ...(m.uncertain ? { uncertain: m.uncertain, candidates: m.candidates } : {}) });
    }
  };
  scan(r.title ?? "", "title");
  for (const f of r.facts?.spatialCoverage ?? []) scan(asText(f.value), (f.field ?? "spatialCoverage").split(".").pop() ?? "spatialCoverage");
  scan(r.description ?? "", "description");
  return { hosting, publisher, subject: subject.slice(0, 12) };
}
