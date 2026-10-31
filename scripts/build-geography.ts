/**
 * Generates the geography registry data files from maintained npm packages plus the clearly labelled curated
 * facts in src/geo/curated.ts:
 *
 *   geography/iso3166-1.json  all 249 ISO 3166-1 assigned entries (codes, names, endonyms, aliases, languages, …)
 *   geography/non-iso.json    codes that are NOT ISO 3166-1 assignments (XK, EU, UK/EL aliases, ISO reserved codes)
 *   geography/iso3166-2.json  ISO 3166-2 subdivisions, by country (kept separate from the 249 list)
 *
 * Usage: npm run geography:build [-- --allow-removals] [-- --date=YYYY-MM-DD]
 * The build refuses to write a list that is not exactly 249 entries, or that silently drops an entry present in
 * the previous file (pass --allow-removals after an ISO 3166 Maintenance Agency change).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { iso31661, iso31661Reserved, iso31662 } from "iso-3166";
import { unM49 } from "un-m49";
import { iso6393, iso6393To1 } from "iso-639-3";
import * as C from "../src/geo/curated.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "geography");
const args = process.argv.slice(2);
const today = args.find((a) => a.startsWith("--date="))?.slice(7) ?? new Date().toISOString().slice(0, 10);

interface WorldCountry {
  name: { common: string; official: string; native?: Record<string, { official: string; common: string }> };
  tld?: string[]; cca2: string; ccn3?: string; cca3: string; independent?: boolean | null; status: string; unMember: boolean;
  altSpellings?: string[]; region?: string; subregion?: string; languages?: Record<string, string>;
  translations?: Record<string, { official: string; common: string }>; demonyms?: Record<string, { f: string; m: string }>;
}
const pkgVersion = (name: string) => (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: string; license?: string });
const PACKAGES = Object.fromEntries(["iso-3166", "world-countries", "i18n-iso-countries", "un-m49", "iso-639-3"].map((n) => [n, `${n}@${pkgVersion(n).version}`]));
const SRC = { iso: PACKAGES["iso-3166"], wc: PACKAGES["world-countries"], i18n: PACKAGES["i18n-iso-countries"], m49: PACKAGES["un-m49"], lang: PACKAGES["iso-639-3"], curated: C.CURATED_SOURCE };

const world = require("world-countries/countries.json") as WorldCountry[];
const wcByA2 = new Map(world.map((w) => [w.cca2, w]));
const i18nDir = join(root, "node_modules", "i18n-iso-countries", "langs");
const i18n = readdirSync(i18nDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(i18nDir, f), "utf8")) as { locale: string; countries: Record<string, string | string[]> });

// ISO 639-2/3 → shortest BCP 47 language subtag (ISO 639-1 when it exists).
const to1 = iso6393To1 as Record<string, string>;
const by2B = new Map(iso6393.filter((l) => l.iso6392B).map((l) => [l.iso6392B!, l.iso6393]));
const langName = new Map(iso6393.map((l) => [l.iso6393, l.name]));
const bcp47 = (code: string): string => { const three = langName.has(code) ? code : by2B.get(code) ?? code; return to1[three] ?? three; };

// ISO 15924 script of each character class we can recognise in endonyms.
const SCRIPTS: Array<[string, RegExp]> = [
  ["Latn", /\p{Script=Latin}/u], ["Cyrl", /\p{Script=Cyrillic}/u], ["Arab", /\p{Script=Arabic}/u], ["Hani", /\p{Script=Han}/u], ["Hira", /\p{Script=Hiragana}/u],
  ["Kana", /\p{Script=Katakana}/u], ["Hang", /\p{Script=Hangul}/u], ["Deva", /\p{Script=Devanagari}/u], ["Beng", /\p{Script=Bengali}/u], ["Taml", /\p{Script=Tamil}/u],
  ["Telu", /\p{Script=Telugu}/u], ["Knda", /\p{Script=Kannada}/u], ["Mlym", /\p{Script=Malayalam}/u], ["Gujr", /\p{Script=Gujarati}/u], ["Guru", /\p{Script=Gurmukhi}/u],
  ["Orya", /\p{Script=Oriya}/u], ["Sinh", /\p{Script=Sinhala}/u], ["Thai", /\p{Script=Thai}/u], ["Laoo", /\p{Script=Lao}/u], ["Khmr", /\p{Script=Khmer}/u],
  ["Mymr", /\p{Script=Myanmar}/u], ["Tibt", /\p{Script=Tibetan}/u], ["Grek", /\p{Script=Greek}/u], ["Hebr", /\p{Script=Hebrew}/u], ["Armn", /\p{Script=Armenian}/u],
  ["Geor", /\p{Script=Georgian}/u], ["Ethi", /\p{Script=Ethiopic}/u], ["Thaa", /\p{Script=Thaana}/u], ["Mong", /\p{Script=Mongolian}/u], ["Tfng", /\p{Script=Tifinagh}/u],
  ["Cher", /\p{Script=Cherokee}/u], ["Cans", /\p{Script=Canadian_Aboriginal}/u], ["Nkoo", /\p{Script=Nko}/u], ["Vaii", /\p{Script=Vai}/u],
];
const scriptsOf = (names: string[]) => SCRIPTS.filter(([, re]) => names.some((n) => re.test(n))).map(([code]) => code);

// UN M.49 hierarchy (country → intermediate region → subregion → region).
const m49ByCode = new Map(unM49.map((r) => [r.code, r]));
const m49ByA3 = new Map(unM49.filter((r) => r.iso3166).map((r) => [r.iso3166!, r]));
function m49Of(a3: string) {
  const self = m49ByA3.get(a3);
  if (!self) return null;
  const out: Record<string, { code: string; name: string }> = {};
  for (let p = self.parent ? m49ByCode.get(self.parent) : undefined; p && p.type > 0; p = p.parent ? m49ByCode.get(p.parent) : undefined) {
    out[p.type === 1 ? "region" : p.type === 2 ? "subregion" : "intermediateRegion"] = { code: p.code, name: p.name };
  }
  return { m49: self.code, ...out };
}

type Alias = { name: string; langs: string[]; sources: string[] };
function aliasCollector() {
  const map = new Map<string, Alias>();
  const add = (name: string | undefined, lang: string, source: string) => {
    const n = (name ?? "").normalize("NFC").trim();
    if (!n) return;
    const key = n.toLowerCase();
    const a = map.get(key) ?? { name: n, langs: [], sources: [] };
    if (!a.langs.includes(lang)) a.langs.push(lang);
    if (!a.sources.includes(source)) a.sources.push(source);
    map.set(key, a);
  };
  return { add, list: () => [...map.values()] };
}
const i18nNames = (a2: string) => i18n.flatMap((l) => { const v = l.countries[a2]; return (Array.isArray(v) ? v : v ? [v] : []).map((name) => ({ name, lang: l.locale })); });
const demonymsOf = (w?: WorldCountry) => [...new Set(Object.values(w?.demonyms ?? {}).flatMap((d) => [d.m, d.f]).filter(Boolean))];
const demonymsByLang = (w?: WorldCountry) => Object.entries(w?.demonyms ?? {}).flatMap(([lang, d]) => [...new Set([d.m, d.f].filter(Boolean))].map((name) => ({ name, lang: bcp47(lang) })));

// ISO 3166-2 subdivisions, by country (code, name, parent).
const subdivisions: Record<string, Array<{ code: string; name: string; parent: string }>> = {};
for (const s of iso31662) (subdivisions[s.code.split("-")[0]] ??= []).push({ code: s.code, name: s.name, parent: s.parent });

// Non-sovereign entries that ISO 3166-2 also lists as a subdivision of another country (matched on English names and
// endonyms only: translations produce false matches such as an English county that shares a word with an island).
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\b(?:sar|sheng)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// A subdivision is credited to one entry only: English-name matches claim first, endonym matches take what is left
// (so Sint Maarten's French endonym "Saint-Martin" does not claim FR-MF, which is Saint Martin's).
const claimed = new Map<string, string>();
const englishNames = (a2: string) => { const w = wcByA2.get(a2); return [iso31661.find((e) => e.alpha2 === a2)!.name, w?.name.common ?? "", w?.name.official ?? ""]; };
const nativeNames = (a2: string) => Object.values(wcByA2.get(a2)?.name.native ?? {}).flatMap((n) => [n.common, n.official]);
for (const pass of [englishNames, nativeNames]) for (const iso of iso31661) {
  if (wcByA2.get(iso.alpha2)?.independent) continue;
  const wanted = new Set(pass(iso.alpha2).map(fold).filter((n) => n.length > 2));
  for (const s of iso31662) if (!s.code.startsWith(iso.alpha2 + "-") && !claimed.has(s.code) && wanted.has(fold(s.name))) claimed.set(s.code, iso.alpha2);
}
const crossListed = (a2: string) => iso31662.filter((s) => claimed.get(s.code) === a2).map((s) => ({ code: s.code, name: s.name, country: s.code.split("-")[0], source: SRC.iso }));

const entries = iso31661.map((iso) => {
  const w = wcByA2.get(iso.alpha2);
  const a2 = iso.alpha2;
  const al = aliasCollector();
  al.add(iso.name, "en", SRC.iso);
  if (w) {
    al.add(w.name.common, "en", SRC.wc);
    al.add(w.name.official, "en", SRC.wc);
    for (const [lang, n] of Object.entries(w.name.native ?? {})) { al.add(n.common, bcp47(lang), SRC.wc); al.add(n.official, bcp47(lang), SRC.wc); }
    for (const [lang, n] of Object.entries(w.translations ?? {})) { al.add(n.common, bcp47(lang), SRC.wc); al.add(n.official, bcp47(lang), SRC.wc); }
    for (const s of w.altSpellings ?? []) if (s !== a2 && s !== iso.alpha3) al.add(s, "und", SRC.wc);
  }
  for (const n of i18nNames(a2)) al.add(n.name, n.lang, SRC.i18n);
  const extra = C.EXTRA_ALIASES[a2];
  for (const n of extra?.names ?? []) al.add(n, "en", SRC.curated);
  const endonyms = Object.entries(w?.name.native ?? {}).map(([lang, n]) => ({ lang: bcp47(lang), common: n.common, official: n.official }));
  const demonyms = [...demonymsByLang(w), ...(extra?.demonyms ?? []).map((name) => ({ name, lang: "en" }))];
  const rel = C.RELATIONSHIPS[a2];
  const type = w?.independent ? "sovereign_state"
    : rel?.kind === "special_administrative_region" ? "special_administrative_region"
    : C.UNINHABITED[a2] ? "uninhabited_area"
    : C.CONTESTED[a2] ? "contested_status"
    : rel && C.DEPENDENCY_KINDS.has(rel.kind) ? "dependency"
    : "territory";
  const unStatus = C.UN_OBSERVER_STATES[a2] ? "observer_state" : w?.unMember ? "member" : "not_member";
  const region = m49Of(iso.alpha3);
  const domains = C.DOMAINS[a2];
  return {
    alpha2: a2,
    alpha3: iso.alpha3,
    numeric: iso.numeric,
    isoName: iso.name,
    commonName: w?.name.common ?? iso.name,
    officialName: w?.name.official ?? null,
    endonyms,
    aliases: al.list(),
    demonyms,
    languages: Object.entries(w?.languages ?? {}).map(([code, name]) => ({ tag: bcp47(code), name })),
    scripts: scriptsOf(endonyms.flatMap((e) => [e.common, e.official])),
    type,
    typeNote: C.UNINHABITED[a2] ?? C.CONTESTED[a2] ?? rel?.note ?? null,
    unStatus,
    unNote: C.UN_OBSERVER_STATES[a2] ?? (a2 === "VA" && w?.unMember ? "world-countries marks the Holy See as a UN member; it is a non-member observer State." : null),
    unNonSelfGoverningTerritory: C.UN_NON_SELF_GOVERNING.includes(a2),
    relationship: rel ? { related: rel.related, kind: rel.kind, note: rel.note ?? null, disputed: rel.disputed ?? null, sovereigntyAsserted: false, source: SRC.curated } : null,
    alsoListedAsSubdivision: crossListed(a2),
    region: region ? { ...region, source: SRC.m49 } : w?.region ? { m49: null, region: { code: null, name: w.region }, subregion: w.subregion ? { code: null, name: w.subregion } : null, source: `${SRC.wc} (not UN M.49: the UN Statistics Division does not list this entry)` } : null,
    tlds: w?.tld ?? [],
    domains: domains ? { government: domains.government, academic: domains.academic, provenance: SRC.curated } : { government: [], academic: [], provenance: "unknown" },
    subdivisionCount: subdivisions[a2]?.length ?? 0,
    provenance: {
      codes: SRC.iso, isoName: SRC.iso, names: [SRC.wc, SRC.i18n, ...(extra ? [SRC.curated] : [])], languages: w?.languages ? `${SRC.wc}; tags via ${SRC.lang}` : "unknown",
      scripts: "derived from the characters of the endonyms", type: `${SRC.wc} (independent flag)${rel || C.UNINHABITED[a2] || C.CONTESTED[a2] ? " + " + SRC.curated : ""}`,
      unStatus: C.UN_OBSERVER_STATES[a2] ? SRC.curated : SRC.wc, region: region ? SRC.m49 : SRC.wc, tlds: SRC.wc,
    },
  };
});

if (entries.length !== 249) throw new Error(`ISO 3166-1 list has ${entries.length} entries, expected 249`);
if (new Set(entries.map((e) => e.alpha2)).size !== 249) throw new Error("duplicate alpha-2 codes");
if (entries.some((e) => e.alpha2 === "XK")) throw new Error("XK is not an ISO 3166-1 assignment");
const isoFile = join(outDir, "iso3166-1.json");
if (existsSync(isoFile) && !args.includes("--allow-removals")) {
  const prev = (JSON.parse(readFileSync(isoFile, "utf8")) as { entries: Array<{ alpha2: string }> }).entries.map((e) => e.alpha2);
  const gone = prev.filter((c) => !entries.some((e) => e.alpha2 === c));
  if (gone.length) throw new Error(`entries would disappear: ${gone.join(", ")} (re-run with --allow-removals if ISO withdrew them)`);
}

// ---------- non-ISO layer ----------
const reserved = new Map(iso31661Reserved.map((r) => [r.alpha2, r]));
const reservedStatus = (code: string) => { const r = reserved.get(code); return r ? `${r.state.replace(/-/g, " ")} in ISO 3166-1 (${SRC.iso}): not an assigned ISO 3166-1 code` : null; };
const xk = wcByA2.get("XK")!;
const xkAliases = aliasCollector();
xkAliases.add(xk.name.common, "en", SRC.wc); xkAliases.add(xk.name.official, "en", SRC.wc);
for (const [lang, n] of Object.entries(xk.name.native ?? {})) { xkAliases.add(n.common, bcp47(lang), SRC.wc); xkAliases.add(n.official, bcp47(lang), SRC.wc); }
for (const [lang, n] of Object.entries(xk.translations ?? {})) { xkAliases.add(n.common, bcp47(lang), SRC.wc); xkAliases.add(n.official, bcp47(lang), SRC.wc); }
for (const n of i18nNames("XK")) xkAliases.add(n.name, n.lang, SRC.i18n);
const nonIso = [
  {
    code: "XK", alpha3: xk.cca3, kind: "user_assigned_code", name: "Kosovo", commonName: xk.name.common,
    status: "Not an ISO 3166-1 assignment. XK is in the user-assigned range (XA–XZ) and is used by the European Commission, other international bodies and many data sets for Kosovo.",
    statusNote: "Kosovo's status is contested; this registry asserts no sovereignty. ISO 3166-2:RS lists RS-KM 'Kosovo-Metohija'.",
    aliasOf: null,
    endonyms: Object.entries(xk.name.native ?? {}).map(([lang, n]) => ({ lang: bcp47(lang), common: n.common, official: n.official })),
    aliases: xkAliases.list(), demonyms: demonymsByLang(xk), languages: Object.entries(xk.languages ?? {}).map(([code, name]) => ({ tag: bcp47(code), name })),
    unStatus: "not_member", region: { name: xk.region ?? null, subregion: xk.subregion ?? null, source: `${SRC.wc} (not UN M.49)` },
    tlds: xk.tld ?? [], tldNote: "Listed by world-countries; not a delegated top-level domain in the DNS root to this registry's knowledge.",
    domains: { government: [], academic: [], provenance: "unknown" },
    provenance: { names: [SRC.wc, SRC.i18n], status: SRC.curated },
  },
  {
    code: "EU", alpha3: null, kind: "regional_organisation", name: "European Union", commonName: "European Union",
    status: `Not an ISO 3166-1 assignment: EU is ${reservedStatus("EU") ?? "not listed by ISO"}; it denotes a regional organisation of member states, not a country.`,
    statusNote: null, aliasOf: null, endonyms: [], aliases: [{ name: "European Union", langs: ["en"], sources: [SRC.curated] }], demonyms: [], languages: C.EU.languages.map((tag) => ({ tag, name: langName.get(iso6393.find((l) => l.iso6391 === tag)?.iso6393 ?? "") ?? tag })),
    members: C.EU.members, unStatus: "not_member", unNote: "The EU participates in the UN General Assembly as an observer organisation, not as a State.", region: null,
    tlds: [".eu"], tldNote: "Delegated ccTLD for the European Union; a .eu domain does not identify any member state.",
    domains: { government: ["europa.eu"], academic: [], provenance: SRC.curated },
    provenance: { names: SRC.curated, status: `${SRC.iso} + ${SRC.curated}` },
  },
  {
    code: "UK", alpha3: null, kind: "alias", name: "United Kingdom", commonName: "United Kingdom", aliasOf: "GB",
    status: `Not an ISO 3166-1 assignment: UK is ${reservedStatus("UK") ?? "not listed by ISO"}. The ISO code for the United Kingdom is GB; .uk is the UK's ccTLD.`,
    statusNote: null, endonyms: [], aliases: [], demonyms: [], languages: [], unStatus: null, region: null, tlds: [".uk"], tldNote: null,
    domains: { government: [], academic: [], provenance: "see GB" }, provenance: { status: `${SRC.iso} + ${SRC.curated}` },
  },
  {
    code: "EL", alpha3: null, kind: "alias", name: "Greece", commonName: "Greece", aliasOf: "GR",
    status: `Not an ISO 3166-1 assignment${reservedStatus("EL") ? `: EL is ${reservedStatus("EL")}` : " (not reserved in ISO 3166-1 per " + SRC.iso + ")"}. EU institutions (Eurostat, the Interinstitutional Style Guide) use EL for Greece; the ISO code is GR.`,
    statusNote: null, endonyms: [], aliases: [], demonyms: [], languages: [], unStatus: null, region: null, tlds: [], tldNote: null,
    domains: { government: [], academic: [], provenance: "see GR" }, provenance: { status: SRC.curated },
  },
  ...iso31661Reserved.filter((r) => !["EU", "UK"].includes(r.alpha2)).map((r) => ({
    code: r.alpha2, alpha3: null, kind: "iso_reserved", name: r.name, commonName: r.name, aliasOf: null,
    status: `Not an ISO 3166-1 assignment: ${r.state.replace(/-/g, " ")} (${SRC.iso}).`, reservation: r.state,
    statusNote: null, endonyms: [], aliases: [], demonyms: [], languages: [], unStatus: null, region: null, tlds: [], tldNote: null,
    domains: { government: [], academic: [], provenance: "unknown" }, provenance: { status: SRC.iso },
  })),
];
if (nonIso.some((n) => entries.some((e) => e.alpha2 === n.code))) throw new Error("a non-ISO code collides with an ISO assignment");

const header = (schema: string) => ({
  schema, schemaVersion: 1, dataVersion: today, effectiveDate: today,
  effectiveDateNote: `Snapshot of the package versions below, generated on ${today}. ISO 3166 changes published after those releases are not included.`,
  generatedBy: "scripts/build-geography.ts", packages: PACKAGES, curated: C.CURATED_SOURCE,
});
mkdirSync(outDir, { recursive: true });
// One entry per line: small diffs when a package update changes an entry, and an easy line count to review.
const lines = (obj: Record<string, unknown>, list: unknown[]) => `${JSON.stringify(obj, null, 1).replace(/\n}$/, "")},\n "entries": [\n${list.map((e) => "  " + JSON.stringify(e)).join(",\n")}\n ]\n}\n`;
writeFileSync(isoFile, lines({
  ...header("omnispider.geography.iso3166-1"),
  caveats: {
    tlds: "A country-code TLD is a DNS delegation, not a jurisdiction: many ccTLDs are registered worldwide (e.g. .io, .tv, .co), and a site's TLD says nothing reliable about where it is hosted or who publishes it.",
    type: "type describes how an entry is administered (sovereign_state, special_administrative_region, dependency, territory, uninhabited_area, contested_status); it is not a statement about sovereignty.",
    unStatus: "unStatus is UN membership (member, observer_state, not_member), kept separate from ISO 3166-1 assignment.",
    relationships: "relationship records an administrative arrangement and its kind; sovereigntyAsserted is always false. Contested cases carry a neutral note and no parent.",
    domains: "Government/academic domain suffixes are listed only where the convention is well known; otherwise empty with provenance 'unknown'.",
  },
  count: entries.length,
}, entries));
writeFileSync(join(outDir, "non-iso.json"), lines({ ...header("omnispider.geography.non-iso"), notice: "None of these codes is an ISO 3166-1 assignment. Each entry's status explains what it is.", count: nonIso.length }, nonIso));
writeFileSync(join(outDir, "iso3166-2.json"), JSON.stringify({ ...header("omnispider.geography.iso3166-2"), source: SRC.iso, count: iso31662.length, countries: Object.keys(subdivisions).length, byCountry: subdivisions }) + "\n");
console.log(`wrote ${entries.length} ISO 3166-1 entries, ${nonIso.length} non-ISO entries, ${iso31662.length} subdivisions → ${outDir}`);
