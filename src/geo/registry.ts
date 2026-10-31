/**
 * Geography registry: every ISO 3166-1 assigned entry (exactly 249), a separate non-ISO layer (XK, EU, aliases such
 * as UK→GB and EL→GR, ISO reserved codes) and ISO 3166-2 subdivisions — generated from maintained npm data by
 * scripts/build-geography.ts into geography/*.json, plus clearly labelled curated facts.
 *
 * Lookups are deterministic: names, endonyms, translations and demonyms in any script resolve to codes, multi-word
 * names win over the words inside them, and words that are also ordinary words or name several places are
 * returned with `uncertain` and their candidates — never silently asserted.
 */
import { readFileSync } from "node:fs";
import { domainToUnicode } from "node:url";
import { AMBIGUOUS, BLOCKED_PHRASES, CAPITALISED_ONLY, GENERIC_CCTLDS, NOT_IN_FREE_TEXT } from "./curated.js";

export type EntryType = "sovereign_state" | "special_administrative_region" | "dependency" | "territory" | "uninhabited_area" | "contested_status";
export type UnStatus = "member" | "observer_state" | "not_member";
export interface Alias { name: string; langs: string[]; sources: string[] }
export interface Endonym { lang: string; common: string; official: string }
export interface Region { code: string | null; name: string }

export interface GeoEntry {
  alpha2: string;
  alpha3: string;
  numeric: string;
  isoName: string;
  commonName: string;
  officialName: string | null;
  endonyms: Endonym[];
  aliases: Alias[];
  demonyms: Array<{ name: string; lang: string }>;
  languages: Array<{ tag: string; name: string }>;
  scripts: string[];
  type: EntryType;
  typeNote: string | null;
  unStatus: UnStatus;
  unNote: string | null;
  unNonSelfGoverningTerritory: boolean;
  relationship: { related: string; kind: string; note: string | null; disputed: string | null; sovereigntyAsserted: false; source: string } | null;
  alsoListedAsSubdivision: Array<{ code: string; name: string; country: string; source: string }>;
  region: { m49: string | null; region?: Region; subregion?: Region | null; intermediateRegion?: Region; source: string } | null;
  tlds: string[];
  domains: { government: string[]; academic: string[]; provenance: string };
  subdivisionCount: number;
  provenance: Record<string, unknown>;
}

export interface NonIsoEntry {
  code: string;
  alpha3: string | null;
  kind: "user_assigned_code" | "regional_organisation" | "alias" | "iso_reserved";
  name: string;
  commonName: string;
  status: string;
  statusNote: string | null;
  aliasOf: string | null;
  reservation?: string;
  endonyms: Endonym[];
  aliases: Alias[];
  demonyms: Array<{ name: string; lang: string }>;
  languages: Array<{ tag: string; name: string }>;
  members?: string[];
  unStatus: UnStatus | null;
  region: unknown;
  tlds: string[];
  tldNote: string | null;
  domains: { government: string[]; academic: string[]; provenance: string };
  provenance: Record<string, unknown>;
}

export interface Subdivision { code: string; name: string; parent: string }

interface FileHeader { schema: string; schemaVersion: number; dataVersion: string; effectiveDate: string; effectiveDateNote: string; generatedBy: string; packages: Record<string, string>; curated: string; count: number }

/** The ISO 3166-1 list has exactly this many assigned entries; anything else means data was lost or added unreviewed. */
export const ISO_ASSIGNED_COUNT = 249;

const dataDir = process.env.GEOGRAPHY_DIR ? new URL(`file://${process.env.GEOGRAPHY_DIR.replace(/\/?$/, "/")}`) : new URL("../../geography/", import.meta.url);
const readJson = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, dataDir), "utf8")) as T;

type IsoFile = FileHeader & { caveats: Record<string, string>; entries: GeoEntry[] };
type NonIsoFile = FileHeader & { notice: string; entries: NonIsoEntry[] };
type SubFile = FileHeader & { source: string; countries: number; byCountry: Record<string, Subdivision[]> };
let iso: IsoFile | null = null;
let nonIso: NonIsoFile | null = null;
let subs: SubFile | null = null;
const isoFile = (): IsoFile => (iso ??= readJson<IsoFile>("iso3166-1.json"));
const nonIsoFile = (): NonIsoFile => (nonIso ??= readJson<NonIsoFile>("non-iso.json"));
const subFile = (): SubFile => (subs ??= readJson<SubFile>("iso3166-2.json"));

export const isoEntries = (): GeoEntry[] => isoFile().entries;
export const nonIsoEntries = (): NonIsoEntry[] => nonIsoFile().entries;

let byCode: Map<string, GeoEntry> | null = null;
let nonIsoByCode: Map<string, NonIsoEntry> | null = null;
function codeMaps() {
  if (!byCode) {
    byCode = new Map();
    for (const e of isoEntries()) for (const k of [e.alpha2, e.alpha3, e.numeric]) byCode.set(k, e);
    nonIsoByCode = new Map(nonIsoEntries().map((e) => [e.code, e]));
  }
  return { byCode, nonIsoByCode: nonIsoByCode! };
}

/** An ISO entry by alpha-2, alpha-3 or numeric code (case-insensitive). */
export function isoEntry(code: string): GeoEntry | undefined {
  return codeMaps().byCode.get(/^\d{1,3}$/.test(code) ? code.padStart(3, "0") : code.toUpperCase());
}
/** A non-ISO entry (XK, EU, UK, EL, reserved codes). */
export function nonIsoEntry(code: string): NonIsoEntry | undefined {
  return codeMaps().nonIsoByCode.get(code.toUpperCase());
}
/** Resolve any code: ISO first; a non-ISO alias (UK, EL) also returns the ISO entry it stands for. */
export function resolveCode(code: string): { layer: "iso"; entry: GeoEntry } | { layer: "non-iso"; entry: NonIsoEntry; aliasOf?: GeoEntry } | null {
  const e = isoEntry(code);
  if (e) return { layer: "iso", entry: e };
  const n = nonIsoEntry(code);
  if (!n) return null;
  const target = n.aliasOf ? isoEntry(n.aliasOf) : undefined;
  return target ? { layer: "non-iso", entry: n, aliasOf: target } : { layer: "non-iso", entry: n };
}
/** Display name for a code (common name), whichever layer it is in. */
export function placeName(code: string): string {
  const r = resolveCode(code.split("-")[0]);
  const sub = code.includes("-") ? subdivision(code) : undefined;
  if (sub) return sub.name;
  return r ? r.entry.commonName : code;
}

export function subdivisionsOf(country: string): Subdivision[] {
  return subFile().byCountry[country.toUpperCase()] ?? [];
}
export function subdivision(code: string): Subdivision | undefined {
  return subdivisionsOf(code.split("-")[0]).find((s) => s.code === code.toUpperCase());
}

// ---------- names → codes ----------
/** Case and accent folding for Latin letters only (marks in Indic and other scripts are part of the letter). */
export function fold(s: string): string {
  return s.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").toLowerCase().replace(/[’ʼ]/g, "'");
}
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
// Scripts written without spaces between words: names are found by substring, not by token.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\s'.-]+$/u;

type Kind = "name" | "endonym" | "demonym" | "abbreviation" | "translation";
interface IndexHit { code: string; layer: "iso" | "non-iso"; kind: Kind; lang: string; sovereign: boolean }
const RANK: Record<Kind, number> = { name: 0, endonym: 1, demonym: 1, abbreviation: 2, translation: 3 };

export interface PlaceMatch {
  /** Best reading (ISO alpha-2, or a non-ISO code such as XK / EU). */
  code: string;
  layer: "iso" | "non-iso";
  /** The words as they appear in the text. */
  text: string;
  /** Which kind of name matched (name, endonym, demonym, abbreviation, translation). */
  kind: Kind;
  lang: string;
  start: number;
  end: number;
  /** Set when the words may not mean this place (ordinary word, several places with this name). */
  uncertain?: string;
  candidates?: string[];
}

let index: { map: Map<string, IndexHit[]>; maxTokens: number; unspaced: Array<[string, IndexHit[]]>; blocked: Set<string> } | null = null;
const tokensOf = (s: string) => (fold(s).match(TOKEN) ?? []);
// Accents are kept for names in other languages: folding Icelandic "Ísland" would make the English word "island" a place.
const lowerTokens = (s: string) => (s.normalize("NFC").toLowerCase().replace(/[’ʼ]/g, "'").match(TOKEN) ?? []);

function buildIndex() {
  const map = new Map<string, IndexHit[]>();
  let maxTokens = 1;
  const add = (name: string, hit: IndexHit) => {
    const toks = hit.kind === "name" || hit.kind === "demonym" ? tokensOf(name) : lowerTokens(name);
    if (!toks.length) return;
    const key = toks.join(" ");
    const latin = LATIN_ONLY.test(name);
    // Short and foreign-language Latin names collide with ordinary words; keep only distinctive ones.
    if (latin && hit.kind === "translation" && key.length < 5) return;
    if (latin && (hit.kind === "name" || hit.kind === "endonym" || hit.kind === "demonym") && key.length < 4 && !/^[A-Z]{2,3}$/.test(name)) return;
    if (!latin && [...key].length < 2) return;
    if (NOT_IN_FREE_TEXT.has(key) && !(hit.kind === "name" && hit.lang === "en")) return;
    if (/^[A-Z]{2,3}$/.test(name)) hit = { ...hit, kind: "abbreviation" };
    const list = map.get(key) ?? [];
    if (!list.some((h) => h.code === hit.code && h.kind === hit.kind)) list.push(hit);
    map.set(key, list);
    maxTokens = Math.max(maxTokens, Math.min(toks.length, 8));
  };
  const isoNameSources = new Set(["en", "und"]);
  for (const e of isoEntries()) {
    const base = { code: e.alpha2, layer: "iso" as const, sovereign: e.type === "sovereign_state" };
    for (const a of e.aliases) {
      const english = a.langs.includes("en");
      const native = e.endonyms.some((n) => n.common === a.name || n.official === a.name);
      const kind: Kind = english ? "name" : native ? "endonym" : a.langs.every((l) => isoNameSources.has(l)) ? "name" : "translation";
      add(a.name, { ...base, kind, lang: english ? "en" : a.langs[0] });
    }
    for (const d of e.demonyms) if (d.lang === "en") add(d.name, { ...base, kind: "demonym", lang: "en" });
  }
  for (const n of nonIsoEntries()) {
    if (n.kind !== "user_assigned_code" && n.kind !== "regional_organisation") continue;
    const base = { code: n.code, layer: "non-iso" as const, sovereign: false };
    for (const a of n.aliases) add(a.name, { ...base, kind: a.langs.includes("en") ? "name" : n.endonyms.some((x) => x.common === a.name || x.official === a.name) ? "endonym" : "translation", lang: a.langs[0] });
    for (const d of n.demonyms) if (d.lang === "en") add(d.name, { ...base, kind: "demonym", lang: "en" });
  }
  const unspaced = [...map].filter(([k]) => UNSPACED.test(k)).sort((a, b) => b[0].length - a[0].length);
  index = { map, maxTokens, unspaced, blocked: new Set(BLOCKED_PHRASES.map((p) => tokensOf(p).join(" "))) };
  return index;
}

/** Pick the reading for one name: best kind first, then a sovereign state over its own dependencies' shared names. */
function resolve(key: string, hits: IndexHit[]): Pick<PlaceMatch, "code" | "layer" | "kind" | "lang" | "uncertain" | "candidates"> {
  const best = Math.min(...hits.map((h) => RANK[h.kind]));
  let top = hits.filter((h) => RANK[h.kind] === best);
  if (new Set(top.map((h) => h.code)).size > 1 && top.some((h) => h.sovereign)) {
    const sovereign = top.filter((h) => h.sovereign);
    // "Indian" (IN and IO), "French" (FR and TF): the dependency shares the state's word.
    if (new Set(sovereign.map((h) => h.code)).size === 1) top = sovereign;
  }
  const codes = [...new Set(top.map((h) => h.code))];
  const curated = AMBIGUOUS[key];
  const first = curated ? top.find((h) => h.code === curated.candidates[0]) ?? top[0] : top[0];
  const out: ReturnType<typeof resolve> = { code: first.code, layer: first.layer, kind: first.kind, lang: first.lang };
  if (curated) { out.uncertain = curated.reason; out.candidates = [...new Set([...curated.candidates, ...codes])]; }
  else if (codes.length > 1) { out.uncertain = `"${key}" may refer to ${codes.map((c) => `${placeName(c)} (${c})`).join(" or ")}.`; out.candidates = codes; }
  return out;
}

const mergeHits = (a?: IndexHit[], b?: IndexHit[]) => (a && b ? [...a, ...b] : a ?? b);

/** Every place named in a text, longest names first, without overlaps. */
export function findPlaces(text: string): PlaceMatch[] {
  const idx = index ?? buildIndex();
  const src = text.normalize("NFC");
  const toks = [...src.matchAll(TOKEN)].map((m) => ({ raw: m[0], f: fold(m[0]), l: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length }));
  const out: PlaceMatch[] = [];
  for (let i = 0; i < toks.length; ) {
    let used = 0;
    for (let n = Math.min(idx.maxTokens, toks.length - i); n >= 1 && !used; n--) {
      const span = toks.slice(i, i + n);
      const exact = span.map((t) => t.l).join(" ");
      let key = span.map((t) => t.f).join(" ");
      if (idx.blocked.has(key)) { used = n; break; }
      // Names in other languages match with their accents; English names also match without them ("Cote d'Ivoire").
      const hits = mergeHits(idx.map.get(exact), exact === key ? undefined : idx.map.get(key)?.filter((h) => h.kind === "name" || h.kind === "demonym"));
      if (!hits) continue;
      if (idx.map.has(exact)) key = exact;
      const raw = src.slice(span[0].start, span[n - 1].end);
      const r = resolve(key, hits);
      // Codes-as-words (UAE, DRC) only in capitals; ordinary words that are also names only when capitalised.
      if (r.kind === "abbreviation" && raw !== raw.toUpperCase()) continue;
      if (CAPITALISED_ONLY.has(key) && !/^\p{Lu}/u.test(raw)) continue;
      out.push({ ...r, text: raw, start: span[0].start, end: span[n - 1].end });
      used = n;
    }
    i += used || 1;
  }
  if (UNSPACED.test(src)) {
    const lower = src.toLowerCase();
    for (const [key, hits] of idx.unspaced) {
      for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + key.length)) {
        const end = at + key.length;
        if (out.some((m) => at < m.end && end > m.start)) continue;
        out.push({ ...resolve(key, hits), text: src.slice(at, end), start: at, end });
      }
    }
    out.sort((a, b) => a.start - b.start);
  }
  return out;
}

/** Exact lookup of one name (any language or script), code, or demonym. */
export function lookupName(name: string): PlaceMatch | null {
  const q = name.trim();
  if (!q) return null;
  const idx = index ?? buildIndex();
  const exact = lowerTokens(q).join(" ");
  const key = tokensOf(q).join(" ");
  const hits = mergeHits(idx.map.get(exact), exact === key ? undefined : idx.map.get(key)?.filter((h) => h.kind === "name" || h.kind === "demonym"));
  if (hits) return { ...resolve(idx.map.has(exact) ? exact : key, hits), text: q, start: 0, end: q.length };
  const byCodeHit = /^[A-Za-z]{2,3}$|^\d{3}$/.test(q) ? resolveCode(q) : null;
  if (byCodeHit) return { code: byCodeHit.layer === "iso" ? byCodeHit.entry.alpha2 : byCodeHit.entry.code, layer: byCodeHit.layer, kind: "abbreviation", lang: "und", text: q, start: 0, end: q.length };
  return null;
}

/** Registry search for the API: codes, then names containing the query (any language). */
export function searchRegistry(q: string, limit = 50): Array<{ layer: "iso" | "non-iso"; code: string; matched: string }> {
  const f = tokensOf(q).join(" ");
  if (!f) return [];
  const out: Array<{ layer: "iso" | "non-iso"; code: string; matched: string; rank: number }> = [];
  const exact = lookupName(q);
  if (exact) out.push({ layer: exact.layer, code: exact.code, matched: exact.text, rank: 0 });
  for (const e of isoEntries()) {
    if (out.some((o) => o.code === e.alpha2)) continue;
    const hit = e.aliases.find((a) => tokensOf(a.name).join(" ").includes(f)) ?? e.demonyms.find((d) => tokensOf(d.name).join(" ").includes(f));
    if (hit) out.push({ layer: "iso", code: e.alpha2, matched: hit.name, rank: tokensOf(hit.name).join(" ").startsWith(f) ? 1 : 2 });
  }
  for (const n of nonIsoEntries()) {
    if (out.some((o) => o.code === n.code)) continue;
    const hit = [n.name, n.commonName, ...n.aliases.map((a) => a.name)].find((x) => tokensOf(x).join(" ").includes(f));
    if (hit || n.code === q.toUpperCase()) out.push({ layer: "non-iso", code: n.code, matched: hit ?? n.code, rank: 3 });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, limit).map(({ rank: _rank, ...x }) => x);
}

// ---------- domains ----------
let tldIndex: Map<string, { code: string; layer: "iso" | "non-iso" } | null> | null = null;
function tlds() {
  if (tldIndex) return tldIndex;
  const all = new Map<string, Array<{ code: string; layer: "iso" | "non-iso" }>>();
  const put = (tld: string, code: string, layer: "iso" | "non-iso") => { const k = tld.replace(/^\./, "").toLowerCase(); all.set(k, [...(all.get(k) ?? []), { code, layer }]); };
  for (const e of isoEntries()) for (const t of e.tlds) put(t, e.alpha2, "iso");
  for (const n of nonIsoEntries()) if (n.kind === "regional_organisation") for (const t of n.tlds) put(t, n.code, "non-iso");
  tldIndex = new Map();
  // A TLD listed for several entries (.us for US and UM) belongs to the entry whose code it spells, else to none.
  for (const [k, list] of all) tldIndex.set(k, list.length === 1 ? list[0] : list.find((x) => x.code.toLowerCase() === k) ?? null);
  return tldIndex;
}

export interface HostCountryHint { cc: string | null; layer?: "iso" | "non-iso"; tld: string; evidence: string; basis: "cctld_weak_hint" | "unknown" }
/** What a host's top-level domain hints about a country. A weak hint only: a TLD is a DNS delegation, not a location. */
export function tldHint(host: string): HostCountryHint {
  const label = (host.toLowerCase().split(".").pop() ?? "").trim();
  const tld = label.startsWith("xn--") ? domainToUnicode(label) || label : label;
  if (!tld) return { cc: null, tld: "", evidence: "no host", basis: "unknown" };
  if (GENERIC_CCTLDS.includes(tld)) return { cc: null, tld, evidence: `.${tld} is a country-code TLD widely registered for generic use; it says nothing about any country`, basis: "unknown" };
  const hit = tlds().get(tld);
  if (!hit) return { cc: null, tld, evidence: tld.length === 2 || tld !== label ? `.${tld} is not a ccTLD this registry recognises` : `.${tld} is a generic TLD`, basis: "unknown" };
  return { cc: hit.code, layer: hit.layer, tld, evidence: `served under .${tld}, the ccTLD of ${placeName(hit.code)} — a weak hint only: a ccTLD is not where a site is hosted or who runs it`, basis: "cctld_weak_hint" };
}

let domainIndex: Array<{ suffix: string; code: string; layer: "iso" | "non-iso"; kind: "government" | "academic" }> | null = null;
/** Known government / academic domain suffixes (curated where well known; most countries have none recorded). */
export function domainSuffixes() {
  if (domainIndex) return domainIndex;
  domainIndex = [];
  for (const e of isoEntries()) for (const kind of ["government", "academic"] as const) for (const s of e.domains[kind]) domainIndex.push({ suffix: s, code: e.alpha2, layer: "iso", kind });
  for (const n of nonIsoEntries()) for (const kind of ["government", "academic"] as const) for (const s of n.domains[kind]) domainIndex.push({ suffix: s, code: n.code, layer: "non-iso", kind });
  domainIndex.sort((a, b) => b.suffix.length - a.suffix.length);
  return domainIndex;
}
/** The country whose government / academic domain a host sits under (gov.in, go.jp, ac.uk, europa.eu, .gov …). */
export function publicDomainOf(host: string): { code: string; layer: "iso" | "non-iso"; kind: "government" | "academic"; suffix: string } | null {
  const h = host.toLowerCase();
  return domainSuffixes().find((d) => h === d.suffix || h.endsWith("." + d.suffix)) ?? null;
}
/** Government / academic suffixes for a code (empty when not reliably known). */
export function domainsFor(code: string): { government: string[]; academic: string[]; provenance: string } {
  const r = resolveCode(code);
  if (!r) return { government: [], academic: [], provenance: "unknown" };
  return r.layer === "non-iso" && r.aliasOf ? r.aliasOf.domains : r.entry.domains;
}

// ---------- integrity and summary ----------
/** Problems with the loaded data; an empty list means the registry is complete and consistent. */
export function verifyRegistry(): string[] {
  const problems: string[] = [];
  const list = isoEntries();
  if (list.length !== ISO_ASSIGNED_COUNT) problems.push(`ISO 3166-1 list has ${list.length} entries, expected ${ISO_ASSIGNED_COUNT}`);
  if (isoFile().count !== list.length) problems.push(`header count ${isoFile().count} ≠ ${list.length} entries`);
  for (const k of ["alpha2", "alpha3", "numeric"] as const) {
    const seen = new Set<string>();
    for (const e of list) { if (seen.has(e[k])) problems.push(`duplicate ${k} ${e[k]}`); seen.add(e[k]); }
  }
  for (const e of list) {
    if (!/^[A-Z]{2}$/.test(e.alpha2) || !/^[A-Z]{3}$/.test(e.alpha3) || !/^\d{3}$/.test(e.numeric)) problems.push(`malformed codes for ${e.alpha2}`);
    if (!e.isoName) problems.push(`${e.alpha2} has no ISO name`);
    if (e.relationship && e.relationship.sovereigntyAsserted !== false) problems.push(`${e.alpha2} asserts sovereignty`);
  }
  for (const n of nonIsoEntries()) {
    if (isoEntry(n.code) && n.code.length === 2) problems.push(`non-ISO code ${n.code} collides with an ISO assignment`);
    if (!n.status) problems.push(`non-ISO ${n.code} has no status`);
  }
  return problems;
}

export function registryMeta() {
  const f = isoFile();
  return { schema: f.schema, schemaVersion: f.schemaVersion, dataVersion: f.dataVersion, effectiveDate: f.effectiveDate, effectiveDateNote: f.effectiveDateNote, packages: f.packages, curated: f.curated, caveats: f.caveats, nonIsoNotice: nonIsoFile().notice };
}

export function registrySummary() {
  const count = <T>(list: T[], key: (x: T) => string) => list.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
  const list = isoEntries();
  return {
    iso3166_1: { assigned: list.length, byType: count(list, (e) => e.type), byUnStatus: count(list, (e) => e.unStatus), byRegion: count(list, (e) => e.region?.region?.name ?? "none") },
    nonIso: { entries: nonIsoEntries().length, byKind: count(nonIsoEntries(), (e) => e.kind) },
    iso3166_2: { subdivisions: subFile().count, countries: subFile().countries, source: subFile().source },
    domains: { countriesWithKnownGovernmentSuffixes: list.filter((e) => e.domains.government.length).length, countriesWithUnknownSuffixes: list.filter((e) => e.domains.provenance === "unknown").length },
  };
}

/** The compact form used in listings. */
export function compactEntry(e: GeoEntry) {
  return { code: e.alpha2, alpha3: e.alpha3, numeric: e.numeric, name: e.isoName, commonName: e.commonName, type: e.type, unStatus: e.unStatus, region: e.region?.region?.name ?? null, subregion: e.region?.subregion?.name ?? null, tlds: e.tlds, languages: e.languages.map((l) => l.tag) };
}
