import { describe, expect, it, vi } from "vitest";
import { findPlaces, isoEntries, isoEntry, lookupName, nonIsoEntry, resolveCode, searchRegistry, subdivision, subdivisionsOf, tldHint, verifyRegistry, ISO_ASSIGNED_COUNT } from "../src/geo/registry.js";
import { deriveGeography } from "../src/geo/derive.js";
import { understandQuery } from "../src/query/understand.js";

// The ISO 3166-1 assigned list (alpha-2 + English short name), embedded so the registry fails this test if an entry
// silently disappears, is renamed or is added without review.
const ISO_3166_1 = `
AD Andorra
AE United Arab Emirates
AF Afghanistan
AG Antigua and Barbuda
AI Anguilla
AL Albania
AM Armenia
AO Angola
AQ Antarctica
AR Argentina
AS American Samoa
AT Austria
AU Australia
AW Aruba
AX Åland Islands
AZ Azerbaijan
BA Bosnia and Herzegovina
BB Barbados
BD Bangladesh
BE Belgium
BF Burkina Faso
BG Bulgaria
BH Bahrain
BI Burundi
BJ Benin
BL Saint Barthélemy
BM Bermuda
BN Brunei Darussalam
BO Bolivia, Plurinational State of
BQ Bonaire, Sint Eustatius and Saba
BR Brazil
BS Bahamas
BT Bhutan
BV Bouvet Island
BW Botswana
BY Belarus
BZ Belize
CA Canada
CC Cocos (Keeling) Islands
CD Congo, Democratic Republic of the
CF Central African Republic
CG Congo
CH Switzerland
CI Côte d'Ivoire
CK Cook Islands
CL Chile
CM Cameroon
CN China
CO Colombia
CR Costa Rica
CU Cuba
CV Cabo Verde
CW Curaçao
CX Christmas Island
CY Cyprus
CZ Czechia
DE Germany
DJ Djibouti
DK Denmark
DM Dominica
DO Dominican Republic
DZ Algeria
EC Ecuador
EE Estonia
EG Egypt
EH Western Sahara
ER Eritrea
ES Spain
ET Ethiopia
FI Finland
FJ Fiji
FK Falkland Islands (Malvinas)
FM Micronesia, Federated States of
FO Faroe Islands
FR France
GA Gabon
GB United Kingdom of Great Britain and Northern Ireland
GD Grenada
GE Georgia
GF French Guiana
GG Guernsey
GH Ghana
GI Gibraltar
GL Greenland
GM Gambia
GN Guinea
GP Guadeloupe
GQ Equatorial Guinea
GR Greece
GS South Georgia and the South Sandwich Islands
GT Guatemala
GU Guam
GW Guinea-Bissau
GY Guyana
HK Hong Kong
HM Heard Island and McDonald Islands
HN Honduras
HR Croatia
HT Haiti
HU Hungary
ID Indonesia
IE Ireland
IL Israel
IM Isle of Man
IN India
IO British Indian Ocean Territory
IQ Iraq
IR Iran, Islamic Republic of
IS Iceland
IT Italy
JE Jersey
JM Jamaica
JO Jordan
JP Japan
KE Kenya
KG Kyrgyzstan
KH Cambodia
KI Kiribati
KM Comoros
KN Saint Kitts and Nevis
KP Korea, Democratic People's Republic of
KR Korea, Republic of
KW Kuwait
KY Cayman Islands
KZ Kazakhstan
LA Lao People's Democratic Republic
LB Lebanon
LC Saint Lucia
LI Liechtenstein
LK Sri Lanka
LR Liberia
LS Lesotho
LT Lithuania
LU Luxembourg
LV Latvia
LY Libya
MA Morocco
MC Monaco
MD Moldova, Republic of
ME Montenegro
MF Saint Martin (French part)
MG Madagascar
MH Marshall Islands
MK North Macedonia
ML Mali
MM Myanmar
MN Mongolia
MO Macao
MP Northern Mariana Islands
MQ Martinique
MR Mauritania
MS Montserrat
MT Malta
MU Mauritius
MV Maldives
MW Malawi
MX Mexico
MY Malaysia
MZ Mozambique
NA Namibia
NC New Caledonia
NE Niger
NF Norfolk Island
NG Nigeria
NI Nicaragua
NL Netherlands, Kingdom of the
NO Norway
NP Nepal
NR Nauru
NU Niue
NZ New Zealand
OM Oman
PA Panama
PE Peru
PF French Polynesia
PG Papua New Guinea
PH Philippines
PK Pakistan
PL Poland
PM Saint Pierre and Miquelon
PN Pitcairn
PR Puerto Rico
PS Palestine, State of
PT Portugal
PW Palau
PY Paraguay
QA Qatar
RE Réunion
RO Romania
RS Serbia
RU Russian Federation
RW Rwanda
SA Saudi Arabia
SB Solomon Islands
SC Seychelles
SD Sudan
SE Sweden
SG Singapore
SH Saint Helena, Ascension and Tristan da Cunha
SI Slovenia
SJ Svalbard and Jan Mayen
SK Slovakia
SL Sierra Leone
SM San Marino
SN Senegal
SO Somalia
SR Suriname
SS South Sudan
ST Sao Tome and Principe
SV El Salvador
SX Sint Maarten (Dutch part)
SY Syrian Arab Republic
SZ Eswatini
TC Turks and Caicos Islands
TD Chad
TF French Southern Territories
TG Togo
TH Thailand
TJ Tajikistan
TK Tokelau
TL Timor-Leste
TM Turkmenistan
TN Tunisia
TO Tonga
TR Türkiye
TT Trinidad and Tobago
TV Tuvalu
TW Taiwan, Province of China
TZ Tanzania, United Republic of
UA Ukraine
UG Uganda
UM United States Minor Outlying Islands
US United States of America
UY Uruguay
UZ Uzbekistan
VA Holy See
VC Saint Vincent and the Grenadines
VE Venezuela, Bolivarian Republic of
VG Virgin Islands (British)
VI Virgin Islands (U.S.)
VN Viet Nam
VU Vanuatu
WF Wallis and Futuna
WS Samoa
YE Yemen
YT Mayotte
ZA South Africa
ZM Zambia
ZW Zimbabwe
`.trim().split("\n").map((l) => [l.slice(0, 2), l.slice(3)] as const);

describe("geography registry: ISO 3166-1", () => {
  it("holds exactly the 249 assigned entries, each with its exact ISO name, without duplicates", () => {
    expect(ISO_3166_1.length).toBe(249);
    expect(isoEntries().length).toBe(ISO_ASSIGNED_COUNT);
    expect(isoEntries().length).toBe(249);
    for (const [code, name] of ISO_3166_1) expect(isoEntry(code)?.isoName, code).toBe(name);
    expect(new Set(isoEntries().map((e) => e.alpha2)).size).toBe(249);
    expect(new Set(isoEntries().map((e) => e.alpha3)).size).toBe(249);
    expect(new Set(isoEntries().map((e) => e.numeric)).size).toBe(249);
    expect(isoEntries().map((e) => e.alpha2).sort()).toEqual(ISO_3166_1.map(([c]) => c));
    expect(verifyRegistry()).toEqual([]);
  });

  it("records codes, names, languages, region, TLDs, UN status and provenance for every entry", () => {
    for (const e of isoEntries()) {
      expect(e.alpha3, e.alpha2).toMatch(/^[A-Z]{3}$/);
      expect(e.numeric, e.alpha2).toMatch(/^\d{3}$/);
      expect(e.commonName, e.alpha2).toBeTruthy();
      expect(["member", "observer_state", "not_member"]).toContain(e.unStatus);
      expect(["sovereign_state", "special_administrative_region", "dependency", "territory", "uninhabited_area", "contested_status"]).toContain(e.type);
      expect(e.domains.provenance, e.alpha2).toMatch(/curated|unknown/);
      expect(e.provenance.codes, e.alpha2).toMatch(/^iso-3166@/);
    }
    expect(isoEntry("IND")?.alpha2).toBe("IN");
    expect(isoEntry("356")?.alpha2).toBe("IN");
    expect(isoEntry("IN")).toMatchObject({ unStatus: "member", type: "sovereign_state", tlds: [".in"], domains: { government: ["gov.in", "nic.in"] } });
    expect(isoEntry("IN")!.languages.map((l) => l.tag)).toEqual(expect.arrayContaining(["en", "hi"]));
    expect(isoEntry("IN")!.scripts).toEqual(expect.arrayContaining(["Deva", "Taml"]));
    expect(isoEntry("IN")!.region).toMatchObject({ region: { name: "Asia" }, subregion: { name: "Southern Asia" } });
    expect(isoEntries().filter((e) => e.unStatus === "member").length).toBe(193);
  });

  it("flags VA and PS as UN observer states, separate from ISO assignment", () => {
    expect(isoEntry("VA")).toMatchObject({ unStatus: "observer_state", isoName: "Holy See" });
    expect(isoEntry("PS")).toMatchObject({ unStatus: "observer_state", isoName: "Palestine, State of" });
    expect(isoEntries().filter((e) => e.unStatus === "observer_state").map((e) => e.alpha2).sort()).toEqual(["PS", "VA"]);
  });

  it("records administrative relationships without asserting sovereignty", () => {
    expect(isoEntry("GL")!.relationship).toMatchObject({ related: "DK", sovereigntyAsserted: false });
    expect(isoEntry("PR")!.relationship).toMatchObject({ related: "US", sovereigntyAsserted: false });
    for (const c of ["HK", "MO"]) expect(isoEntry(c)).toMatchObject({ type: "special_administrative_region", relationship: { related: "CN", kind: "special_administrative_region" } });
    expect(isoEntry("TW")).toMatchObject({ isoName: "Taiwan, Province of China", type: "contested_status", relationship: null });
    expect(isoEntry("TW")!.alsoListedAsSubdivision.map((s) => s.code)).toContain("CN-TW");
    expect(isoEntry("EH")!.type).toBe("contested_status");
    expect(isoEntry("AQ")!.type).toBe("uninhabited_area");
    expect(isoEntries().every((e) => !e.relationship || e.relationship.sovereigntyAsserted === false)).toBe(true);
  });
});

describe("geography registry: non-ISO layer and subdivisions", () => {
  it("keeps XK out of the ISO list, in the non-ISO layer with an explanation", () => {
    expect(isoEntry("XK")).toBeUndefined();
    expect(nonIsoEntry("XK")).toMatchObject({ kind: "user_assigned_code", name: "Kosovo" });
    expect(nonIsoEntry("XK")!.status).toMatch(/not an ISO 3166-1 assignment/i);
    expect(nonIsoEntry("EU")).toMatchObject({ kind: "regional_organisation", tlds: [".eu"], domains: { government: ["europa.eu"] } });
    expect(nonIsoEntry("EU")!.status).toMatch(/not an ISO 3166-1 assignment/i);
    expect(resolveCode("UK")).toMatchObject({ layer: "non-iso", aliasOf: { alpha2: "GB" } });
    expect(resolveCode("EL")).toMatchObject({ layer: "non-iso", aliasOf: { alpha2: "GR" } });
    expect(nonIsoEntry("UK")!.status).toMatch(/not an ISO 3166-1 assignment/i);
  });

  it("exposes ISO 3166-2 subdivisions separately", () => {
    expect(subdivisionsOf("IN").length).toBeGreaterThan(30);
    expect(subdivision("US-GA")).toMatchObject({ name: "Georgia", parent: "US" });
    expect(isoEntries().some((e) => e.alpha2.includes("-"))).toBe(false);
  });
});

describe("geography lookups", () => {
  it("resolves names in several scripts, endonyms and demonyms", () => {
    expect(lookupName("भारत")?.code).toBe("IN");
    expect(lookupName("日本")?.code).toBe("JP");
    expect(lookupName("Deutschland")?.code).toBe("DE");
    expect(lookupName("Россия")?.code).toBe("RU");
    expect(lookupName("مصر")?.code).toBe("EG");
    expect(lookupName("Brazilian")?.code).toBe("BR");
    expect(lookupName("Côte d'Ivoire")?.code).toBe("CI");
    expect(lookupName("cote d'ivoire")?.code).toBe("CI");
    expect(lookupName("Kosovo")).toMatchObject({ code: "XK", layer: "non-iso" });
    expect(searchRegistry("Deutschland")[0]).toMatchObject({ code: "DE" });
  });

  it("marks ambiguous names uncertain instead of asserting them", () => {
    expect(lookupName("georgia")).toMatchObject({ code: "GE", candidates: ["GE", "US-GA"] });
    expect(lookupName("georgia")!.uncertain).toMatch(/US state/);
    expect(lookupName("turkey")!.uncertain).toMatch(/bird/);
    expect(lookupName("Congolese")!.candidates).toEqual(expect.arrayContaining(["CD", "CG"]));
  });

  it("finds multi-word names without matching the words inside them or common false friends", () => {
    expect(findPlaces("Papua New Guinea and Guinea-Bissau").map((m) => m.code)).toEqual(["PG", "GW"]);
    expect(findPlaces("trade across the Indian Ocean")).toEqual([]);
    expect(findPlaces("a volcanic island in New Mexico")).toEqual([]);
    expect(findPlaces("let us know")).toEqual([]);
    expect(findPlaces("日本政府の文書").map((m) => m.code)).toEqual(["JP"]);
  });

  it("treats a ccTLD as a weak hint and generic-use ccTLDs as no hint", () => {
    expect(tldHint("example.in")).toMatchObject({ cc: "IN", basis: "cctld_weak_hint" });
    expect(tldHint("example.us")).toMatchObject({ cc: "US" });
    expect(tldHint("startup.io")).toMatchObject({ cc: null, basis: "unknown" });
    expect(tldHint("example.org")).toMatchObject({ cc: null, basis: "unknown" });
  });
});

describe("result geography: hosting, publisher and subject stay separate", () => {
  it("does not conflate a .us host with the result's subject or publisher", () => {
    const g = deriveGeography({ host: "climate-archive.us", title: "Monsoon rainfall in India, 1901–2020", description: "Gridded observations", facts: { publisher: [], spatialCoverage: [] } });
    expect(g.hosting).toMatchObject({ cc: "US", basis: "cctld_weak_hint" });
    expect(g.hosting.evidence).toMatch(/weak hint/);
    expect(g.publisher).toMatchObject({ cc: null, basis: "unknown" });
    expect(g.subject.map((s) => s.cc)).toEqual(["IN"]);
  });

  it("reads the publisher country from public-sector domains and stated publishers", () => {
    expect(deriveGeography({ host: "meteo.go.ke", title: "Rainfall outlook" }).publisher).toMatchObject({ cc: "KE", basis: "public_domain_suffix" });
    expect(deriveGeography({ host: "example.org", title: "x", facts: { publisher: [{ value: "Ministry of Electronics, Government of India" }] } }).publisher).toMatchObject({ cc: "IN", basis: "publisher_statement" });
    const sub = deriveGeography({ host: "example.org", title: "Report", facts: { spatialCoverage: [{ value: "Nairobi, Kenya", field: "spatial.spatialCoverage" }] } });
    expect(sub.subject[0]).toMatchObject({ cc: "KE", fields: ["spatialCoverage"] });
  });
});

describe("query understanding with the registry", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  const u = (q: string) => understandQuery(q, { now });

  it("reads a publisher country from a demonym and uses its government domains", () => {
    const p = u("find kenyan government rainfall datasets");
    expect(p.constraints.publisher).toMatchObject({ category: "government", country: "KE", hostSuffixes: ["go.ke"], mode: "published_by" });
    expect(p.constraints.geography).toMatchObject({ code: "KE", role: "publisher" });
    expect(p.topic.phrase).toBe("rainfall");
  });

  it("tells the subject country from the publisher", () => {
    const p = u("documents about Japan published by the UN");
    expect(p.constraints.geography).toMatchObject({ code: "JP", role: "subject" });
    expect(p.constraints.publisher).toMatchObject({ organization: "United Nations", hostSuffixes: ["un.org"] });
    expect(p.constraints.publisher!.country).toBeUndefined();
    const both = u("documents about japan published by the indian government");
    expect(both.constraints.geography).toMatchObject({ code: "JP", role: "subject" });
    expect(both.constraints.publisher).toMatchObject({ country: "IN", hostSuffixes: ["gov.in", "nic.in"] });
  });

  it("flags 'georgia' as uncertain and reads names in other scripts and languages", () => {
    const g = u("find documents about georgia");
    expect(g.constraints.geography).toMatchObject({ code: "GE", basis: "uncertain", candidates: ["GE", "US-GA"] });
    expect(g.uncertain.join(" ")).toMatch(/US state/);
    expect(u("भारत सरकार कृत्रिम बुद्धिमत्ता").constraints.geography?.code).toBe("IN");
    expect(u("klimadaten aus Deutschland").constraints.geography?.code).toBe("DE");
    expect(u("climate reports published by the european union").constraints.publisher).toMatchObject({ country: "EU", hostSuffixes: ["europa.eu"] });
    expect(u("find documents about artificial intelligence from the Indian Ocean region").constraints.geography).toBeUndefined();
    expect(u("india").searchTerms).toEqual(["india"]);
  });
});

const searchMock = vi.fn();
vi.mock("../src/corpus/search.js", () => ({ searchCorpus: (...a: unknown[]) => searchMock(...a) }));
const { checkResult, askCorpus } = await import("../src/query/execute.js");

describe("plan checks use the right geography", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  const row = (id: number, host: string, title: string, extra: Record<string, unknown> = {}) => ({ resourceId: id, url: `https://${host}/r${id}`, host, title, kind: "pdf", score: 1, matchedIn: "title", facts: { publisher: [], dates: [], languages: [], funders: [], spatialCoverage: [] }, ...extra });

  it("checks 'about India' against the subject, not the ccTLD", () => {
    const plan = understandQuery("documents about india", { now });
    const onUs = checkResult(row(1, "climate-archive.us", "Monsoon rainfall in India") as never, plan);
    expect(onUs.find((c) => c.requirement.startsWith("Subject country"))).toMatchObject({ verdict: "pass" });
    const onIn = checkResult(row(2, "example.in", "Rainfall statistics") as never, plan);
    const k = onIn.find((c) => c.requirement.startsWith("Subject country"))!;
    expect(k.verdict).toBe("unknown");
    expect(k.evidence).toMatch(/not evidence of the subject/);
  });

  it("checks 'published by the Indian government' against the publisher, not the subject", () => {
    const plan = understandQuery("documents about japan published by the indian government", { now });
    const pubIn = checkResult(row(3, "example.org", "Japan trade study", { facts: { publisher: [{ field: "provenance.publisher", value: "Ministry of External Affairs, Government of India" }], dates: [], languages: [], funders: [] } }) as never, plan);
    expect(pubIn.find((c) => c.requirement.startsWith("Published by"))!.verdict).toBe("pass");
    expect(pubIn.find((c) => c.requirement.startsWith("Subject country"))!.verdict).toBe("pass");
    const pubJp = checkResult(row(4, "example.org", "India trade study", { facts: { publisher: [{ field: "provenance.publisher", value: "Ministry of Foreign Affairs, Government of Japan" }], dates: [], languages: [], funders: [] } }) as never, plan);
    expect(pubJp.find((c) => c.requirement.startsWith("Published by"))!.verdict).toBe("fail");
  });

  it("returns each checked result's separate geography", async () => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ total: 1, matchQuality: "strong", results: [row(5, "data.go.jp", "Rainfall in Kenya")], tookMs: 1 });
    const res = await askCorpus({} as never, understandQuery("rainfall", { now }), { limit: 5 });
    expect(res.results[0].geography).toMatchObject({ hosting: { cc: "JP" }, publisher: { cc: "JP", basis: "public_domain_suffix" }, subject: [{ cc: "KE" }] });
  });
});
