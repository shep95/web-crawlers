import { createRequire } from "node:module";
import { continents, countries, languages as countryLanguages } from "countries-list";
import { iso6393 } from "iso-639-3";
import { FORMATS } from "../metadata/formats.js";

/**
 * Diversity-first discovery rotation.
 *
 * Each rotation slot picks one value from every dimension:
 *   ccTLD        all ISO 3166 country-code TLDs from the IANA root zone (npm `tlds`),
 *                interleaved round-robin across continents (countries-list) so that
 *                consecutive slots never stay in one region
 *   gTLD         every other IANA TLD (generic, sponsored, brand, IDN), strided
 *   language     every ISO 639-1 language that is an official/national language
 *                somewhere (countries-list), mapped to ISO 639-3 (npm `iso-639-3`)
 *                because Common Crawl's `languages` field uses 639-3
 *   MIME family  derived from the format registry (formats.ts): only families with
 *                a parser, rotated so documents, data, media, geo, scientific,
 *                subtitles, web archives… all get turns
 *   source family the kinds of discovery inputs (catalog, index, feed, archive, …)
 *
 * The starting offset is derived from wall-clock time (so replicas and restarts agree
 * without coordination) — no country, language or domain is a privileged default.
 * Budgets are fixed per slot by the caller; coverage of what each slot actually
 * produced is recorded and reported (see `RotationCoverage`).
 */
const require = createRequire(import.meta.url);
const IANA_TLDS = require("tlds") as string[];

export interface CcTld {
  tld: string;
  country: string | null;
  continent: string | null;
  languages: string[];
}

let ccCache: CcTld[] | null = null;
/** All 2-letter ccTLDs from the IANA list, with country metadata where ISO 3166 knows them. */
export function ccTlds(): CcTld[] {
  if (ccCache) return ccCache;
  const C = countries as Record<string, { name: string; continent: string; languages: string[] }>;
  ccCache = IANA_TLDS.filter((t) => /^[a-z]{2}$/.test(t))
    .sort()
    .map((tld) => {
      const code = tld === "uk" ? "GB" : tld === "ac" ? "AC" : tld.toUpperCase();
      const c = C[code];
      return { tld, country: c?.name ?? null, continent: c?.continent ?? null, languages: c?.languages ?? [] };
    });
  return ccCache;
}

/** Generic/sponsored/brand/IDN TLDs: everything in the IANA root zone that is not a 2-letter ccTLD. */
export function genericTlds(): string[] {
  return IANA_TLDS.filter((t) => !/^[a-z]{2}$/.test(t)).sort();
}

/**
 * Interleave ccTLDs by continent proportionally: each continent's entries are spread
 * evenly over the whole cycle (key = (rank + ½) / group size), so every window of the
 * rotation mixes regions — small continents (Oceania, South America, Antarctica) are not
 * bunched at the start and large ones are not left to dominate the tail.
 */
export function interleavedCcTlds(): CcTld[] {
  const groups = new Map<string, CcTld[]>();
  for (const c of ccTlds()) {
    const k = c.continent ?? "??";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const order = [...Object.keys(continents), "??"];
  return [...groups]
    .flatMap(([k, g]) => g.map((c, i) => ({ c, key: (i + 0.5) / g.length, tie: order.indexOf(k) })))
    .sort((a, b) => a.key - b.key || a.tie - b.tie)
    .map((x) => x.c);
}

export interface RotationLanguage {
  iso6391: string;
  iso6393: string;
  name: string;
}

let langCache: RotationLanguage[] | null = null;
export function rotationLanguages(): RotationLanguage[] {
  if (langCache) return langCache;
  const used = new Set(Object.values(countries as Record<string, { languages: string[] }>).flatMap((c) => c.languages));
  const by1 = new Map(iso6393.filter((l) => l.iso6391).map((l) => [l.iso6391!, l]));
  const L = countryLanguages as Record<string, { name: string }>;
  langCache = [...used]
    .filter((c) => by1.has(c))
    .sort()
    .map((c) => ({ iso6391: c, iso6393: by1.get(c)!.iso6393, name: L[c]?.name ?? by1.get(c)!.name }));
  return langCache;
}

/** MIME families with at least one parser-backed format, from the registry. */
export function mimeFamilies(): Array<{ family: string; mimes: string[] }> {
  const m = new Map<string, Set<string>>();
  for (const f of FORMATS) {
    if ((f.status !== "implemented" && f.status !== "partial") || !f.mimes.length) continue;
    const s = m.get(f.family) ?? new Set<string>();
    for (const x of f.mimes) s.add(x);
    m.set(f.family, s);
  }
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([family, s]) => ({ family, mimes: [...s] }));
}

export const SOURCE_FAMILIES = ["web_index", "catalog", "repository", "feed", "archive", "operator_seed"] as const;

export interface RotationSlot {
  index: number;
  ccTld: CcTld;
  gTld: string;
  language: RotationLanguage;
  mimeFamily: string;
  mime: string;
  sourceFamily: (typeof SOURCE_FAMILIES)[number];
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
/** A stride coprime with n, near n·φ, so successive picks spread across the list. */
function stride(n: number): number {
  let s = Math.max(1, Math.round(n * 0.618));
  while (gcd(s, n) !== 1) s++;
  return s;
}

export class DiscoveryRotation {
  private cc = interleavedCcTlds();
  private g = genericTlds();
  private langs = rotationLanguages();
  private fams = mimeFamilies();
  private gStride = stride(this.g.length);
  private lStride = stride(this.langs.length);
  constructor(public offset = Math.floor(Date.now() / (6 * 3600_000))) {}

  slot(i: number): RotationSlot {
    const n = this.offset + i;
    const fam = this.fams[n % this.fams.length];
    return {
      index: n,
      ccTld: this.cc[n % this.cc.length],
      gTld: this.g[(n * this.gStride) % this.g.length],
      language: this.langs[(n * this.lStride) % this.langs.length],
      mimeFamily: fam.family,
      mime: fam.mimes[Math.floor(n / this.fams.length) % fam.mimes.length],
      sourceFamily: SOURCE_FAMILIES[n % SOURCE_FAMILIES.length],
    };
  }

  /** Size of each dimension (how many slots a full cycle takes). */
  get dimensions() {
    return { ccTlds: this.cc.length, gTlds: this.g.length, languages: this.langs.length, mimeFamilies: this.fams.length, sourceFamilies: SOURCE_FAMILIES.length };
  }
}

/** What one rotation run sampled and produced — recorded as a crawler event per run. */
export interface RotationCoverage {
  source: string;
  at: string;
  queries: Array<{ dimension: "ccTld" | "gTld" | "language" | "pinned_domain"; value: string; mime: string; items: number; error?: string }>;
  totals: { queries: number; items: number; distinctTlds: number; distinctHosts: number };
}
