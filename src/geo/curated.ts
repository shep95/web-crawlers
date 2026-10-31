/**
 * Hand-curated geography facts that no maintained npm package provides. Every value here is recorded in the
 * generated registry with provenance "curated" and the source named below, so it is never mistaken for package
 * data. Only well-established facts are listed; anything not reliably known is left out (and appears in the
 * registry as empty with provenance "unknown"). This module asserts no sovereignty: relationships describe how
 * an entry is administered or listed, and contested cases carry a neutral note instead of a parent.
 */

export const CURATED_SOURCE = "src/geo/curated.ts";

/** UN non-member observer States (United Nations, "Non-member States"): the only two. */
export const UN_OBSERVER_STATES: Record<string, string> = {
  VA: "Holy See: UN non-member observer State (not a UN member).",
  PS: "State of Palestine: UN non-member observer State since 2012 (not a UN member).",
};

/** UN list of Non-Self-Governing Territories (Special Committee on Decolonization), 17 entries. */
export const UN_NON_SELF_GOVERNING = ["AS", "AI", "BM", "VG", "KY", "FK", "PF", "GI", "GU", "MS", "NC", "PN", "SH", "TK", "TC", "VI", "EH"];

/** Entries with no permanent population (only rotating research, military or station staff, if any). */
export const UNINHABITED: Record<string, string> = {
  AQ: "No permanent population; governed under the Antarctic Treaty System, territorial claims held in abeyance.",
  BV: "Uninhabited island.",
  HM: "Uninhabited islands.",
  GS: "No permanent population (government officers and research staff only).",
  TF: "No permanent population (research and military staff only).",
  UM: "No permanent population (military and research personnel only on some islands).",
};

/** Entries whose international status is contested. No parent is recorded and no sovereignty is asserted. */
export const CONTESTED: Record<string, string> = {
  TW: "Governed by authorities in Taipei; claimed by the People's Republic of China. ISO 3166-1 uses the name 'Taiwan, Province of China' and ISO 3166-2:CN also lists CN-TW. This registry asserts no sovereignty.",
  PS: "UN non-member observer State; recognition varies between states. This registry asserts no position.",
  EH: "On the UN list of Non-Self-Governing Territories; contested between Morocco and the Polisario Front (Sahrawi Arab Democratic Republic). This registry asserts no sovereignty.",
};

export type RelationshipKind =
  | "special_administrative_region" | "crown_dependency" | "british_overseas_territory" | "autonomous_territory"
  | "constituent_country" | "special_municipality" | "overseas_department_region" | "overseas_collectivity"
  | "sui_generis_collectivity" | "overseas_territory" | "commonwealth" | "unincorporated_territory"
  | "minor_outlying_islands" | "external_territory" | "dependent_territory" | "free_association"
  | "integral_part" | "dependency" | "autonomous_region";

/** Kinds where the entry is administered as a dependency rather than as part of the related state's own territory. */
export const DEPENDENCY_KINDS = new Set<RelationshipKind>(["crown_dependency", "british_overseas_territory", "autonomous_territory", "constituent_country", "overseas_collectivity", "sui_generis_collectivity", "overseas_territory", "commonwealth", "unincorporated_territory", "minor_outlying_islands", "external_territory", "dependent_territory", "dependency"]);

export interface CuratedRelationship { related: string; kind: RelationshipKind; note?: string; disputed?: string }

/** Administrative relationships of non-sovereign entries (well-established constitutional arrangements). */
export const RELATIONSHIPS: Record<string, CuratedRelationship> = {
  HK: { related: "CN", kind: "special_administrative_region" },
  MO: { related: "CN", kind: "special_administrative_region" },
  GG: { related: "GB", kind: "crown_dependency", note: "Self-governing British Crown Dependency; not part of the United Kingdom." },
  JE: { related: "GB", kind: "crown_dependency", note: "Self-governing British Crown Dependency; not part of the United Kingdom." },
  IM: { related: "GB", kind: "crown_dependency", note: "Self-governing British Crown Dependency; not part of the United Kingdom." },
  AI: { related: "GB", kind: "british_overseas_territory" },
  BM: { related: "GB", kind: "british_overseas_territory" },
  IO: { related: "GB", kind: "british_overseas_territory", disputed: "Sovereignty claimed by Mauritius; subject of a UK–Mauritius agreement signed in 2025. Status may change." },
  VG: { related: "GB", kind: "british_overseas_territory" },
  KY: { related: "GB", kind: "british_overseas_territory" },
  FK: { related: "GB", kind: "british_overseas_territory", disputed: "Sovereignty claimed by Argentina (ISO name 'Falkland Islands (Malvinas)')." },
  GI: { related: "GB", kind: "british_overseas_territory", disputed: "Sovereignty claimed by Spain." },
  MS: { related: "GB", kind: "british_overseas_territory" },
  PN: { related: "GB", kind: "british_overseas_territory" },
  SH: { related: "GB", kind: "british_overseas_territory" },
  GS: { related: "GB", kind: "british_overseas_territory", disputed: "Sovereignty claimed by Argentina." },
  TC: { related: "GB", kind: "british_overseas_territory" },
  GL: { related: "DK", kind: "autonomous_territory", note: "Autonomous territory within the Kingdom of Denmark." },
  FO: { related: "DK", kind: "autonomous_territory", note: "Autonomous territory within the Kingdom of Denmark." },
  AW: { related: "NL", kind: "constituent_country", note: "Constituent country of the Kingdom of the Netherlands." },
  CW: { related: "NL", kind: "constituent_country", note: "Constituent country of the Kingdom of the Netherlands." },
  SX: { related: "NL", kind: "constituent_country", note: "Constituent country of the Kingdom of the Netherlands." },
  BQ: { related: "NL", kind: "special_municipality", note: "Special municipalities (public bodies) of the Netherlands (Caribbean Netherlands)." },
  GF: { related: "FR", kind: "overseas_department_region" },
  GP: { related: "FR", kind: "overseas_department_region" },
  MQ: { related: "FR", kind: "overseas_department_region" },
  RE: { related: "FR", kind: "overseas_department_region" },
  YT: { related: "FR", kind: "overseas_department_region" },
  PF: { related: "FR", kind: "overseas_collectivity" },
  PM: { related: "FR", kind: "overseas_collectivity" },
  BL: { related: "FR", kind: "overseas_collectivity" },
  MF: { related: "FR", kind: "overseas_collectivity" },
  WF: { related: "FR", kind: "overseas_collectivity" },
  NC: { related: "FR", kind: "sui_generis_collectivity" },
  TF: { related: "FR", kind: "overseas_territory" },
  PR: { related: "US", kind: "commonwealth", note: "Unincorporated territory of the United States (Commonwealth)." },
  MP: { related: "US", kind: "commonwealth", note: "Unincorporated territory of the United States (Commonwealth)." },
  GU: { related: "US", kind: "unincorporated_territory" },
  AS: { related: "US", kind: "unincorporated_territory" },
  VI: { related: "US", kind: "unincorporated_territory" },
  UM: { related: "US", kind: "minor_outlying_islands" },
  CX: { related: "AU", kind: "external_territory" },
  CC: { related: "AU", kind: "external_territory" },
  NF: { related: "AU", kind: "external_territory" },
  HM: { related: "AU", kind: "external_territory" },
  TK: { related: "NZ", kind: "dependent_territory" },
  CK: { related: "NZ", kind: "free_association", note: "Self-governing in free association with New Zealand." },
  NU: { related: "NZ", kind: "free_association", note: "Self-governing in free association with New Zealand." },
  SJ: { related: "NO", kind: "integral_part", note: "Part of Norway; the Svalbard Treaty applies to Svalbard." },
  BV: { related: "NO", kind: "dependency" },
  AX: { related: "FI", kind: "autonomous_region", note: "Autonomous region of Finland." },
};

/**
 * Second-level domains reserved for government / academic use, where the convention is well known.
 * A host under one of these is evidence of who publishes it, not proof: eligibility rules vary by registry.
 * Countries not listed here have unknown suffixes (left empty, provenance "unknown").
 */
export const DOMAINS: Record<string, { government: string[]; academic: string[] }> = {
  IN: { government: ["gov.in", "nic.in"], academic: ["ac.in", "edu.in"] },
  US: { government: ["gov", "mil"], academic: ["edu"] },
  GB: { government: ["gov.uk", "nhs.uk", "parliament.uk", "gov.scot", "gov.wales"], academic: ["ac.uk"] },
  CA: { government: ["gc.ca", "canada.ca"], academic: [] },
  AU: { government: ["gov.au"], academic: ["edu.au"] },
  NZ: { government: ["govt.nz"], academic: ["ac.nz"] },
  IE: { government: ["gov.ie"], academic: [] },
  SG: { government: ["gov.sg"], academic: ["edu.sg"] },
  CN: { government: ["gov.cn"], academic: ["edu.cn"] },
  JP: { government: ["go.jp"], academic: ["ac.jp"] },
  KR: { government: ["go.kr"], academic: ["ac.kr"] },
  DE: { government: ["bund.de"], academic: [] },
  FR: { government: ["gouv.fr"], academic: [] },
  ES: { government: ["gob.es"], academic: [] },
  IT: { government: ["gov.it"], academic: [] },
  BR: { government: ["gov.br"], academic: ["edu.br"] },
  MX: { government: ["gob.mx"], academic: ["edu.mx"] },
  ZA: { government: ["gov.za"], academic: ["ac.za"] },
  NG: { government: ["gov.ng"], academic: ["edu.ng"] },
  KE: { government: ["go.ke"], academic: ["ac.ke"] },
  PK: { government: ["gov.pk"], academic: ["edu.pk"] },
  BD: { government: ["gov.bd"], academic: ["ac.bd"] },
  ID: { government: ["go.id"], academic: ["ac.id"] },
  MY: { government: ["gov.my"], academic: ["edu.my"] },
  PH: { government: ["gov.ph"], academic: ["edu.ph"] },
  IL: { government: ["gov.il"], academic: ["ac.il"] },
  AE: { government: ["gov.ae"], academic: [] },
  SA: { government: ["gov.sa"], academic: ["edu.sa"] },
  TR: { government: ["gov.tr"], academic: ["edu.tr"] },
  AR: { government: ["gob.ar"], academic: ["edu.ar"] },
  CL: { government: ["gob.cl"], academic: [] },
  CO: { government: ["gov.co"], academic: ["edu.co"] },
  PE: { government: ["gob.pe"], academic: ["edu.pe"] },
  EG: { government: ["gov.eg"], academic: ["edu.eg"] },
  GH: { government: ["gov.gh"], academic: ["edu.gh"] },
  TZ: { government: ["go.tz"], academic: ["ac.tz"] },
  UG: { government: ["go.ug"], academic: ["ac.ug"] },
  LK: { government: ["gov.lk"], academic: ["ac.lk"] },
  NP: { government: ["gov.np"], academic: ["edu.np"] },
  TH: { government: ["go.th"], academic: ["ac.th"] },
  VN: { government: ["gov.vn"], academic: ["edu.vn"] },
  TW: { government: ["gov.tw"], academic: ["edu.tw"] },
  HK: { government: ["gov.hk"], academic: ["edu.hk"] },
  PL: { government: ["gov.pl"], academic: ["edu.pl"] },
  AT: { government: ["gv.at"], academic: ["ac.at"] },
  CH: { government: ["admin.ch"], academic: [] },
  PT: { government: ["gov.pt"], academic: [] },
  GR: { government: ["gov.gr"], academic: [] },
  UA: { government: ["gov.ua"], academic: ["edu.ua"] },
  RW: { government: ["gov.rw"], academic: [] },
  IR: { government: ["gov.ir"], academic: ["ac.ir"] },
  JO: { government: ["gov.jo"], academic: [] },
  QA: { government: ["gov.qa"], academic: [] },
  KW: { government: ["gov.kw"], academic: [] },
  OM: { government: ["gov.om"], academic: [] },
  MT: { government: ["gov.mt"], academic: [] },
  CY: { government: ["gov.cy"], academic: [] },
  JM: { government: ["gov.jm"], academic: [] },
};

/** Common names that the packages do not carry, kept for backward compatibility with the earlier hand-written list. */
export const EXTRA_ALIASES: Record<string, { names?: string[]; demonyms?: string[]; note: string }> = {
  GB: { names: ["Britain", "England", "Scotland", "Wales", "Northern Ireland"], demonyms: ["Scottish", "Welsh"], note: "Constituent countries of the United Kingdom (ISO 3166-2:GB lists them as GB-ENG, GB-SCT, GB-WLS, GB-NIR)." },
  US: { names: ["America"], note: "'America' also names the continents; matches are marked uncertain." },
  SA: { demonyms: ["Saudi"], note: "Common short demonym." },
  PH: { demonyms: ["Philippine"], note: "Adjective form." },
  KR: { names: ["Korea"], note: "Also used for North Korea; matches are marked uncertain." },
};

/**
 * Names that are also ordinary words or name more than one place. A match is kept but marked uncertain,
 * with the reason; `candidates` lists every entry the word might mean.
 */
export const AMBIGUOUS: Record<string, { candidates: string[]; reason: string }> = {
  georgia: { candidates: ["GE", "US-GA"], reason: "Georgia is both a country (GE) and a US state (US-GA)." },
  turkey: { candidates: ["TR"], reason: "'turkey' is also a bird; the country's ISO short name is Türkiye." },
  jordan: { candidates: ["JO"], reason: "'Jordan' is also a personal name and a river." },
  chad: { candidates: ["TD"], reason: "'Chad' is also a personal name." },
  jersey: { candidates: ["JE", "US-NJ"], reason: "'jersey' is also a garment and part of 'New Jersey' (US state)." },
  guinea: { candidates: ["GN", "GQ", "GW", "PG"], reason: "'Guinea' is part of several country names and of the word 'guinea pig'." },
  congo: { candidates: ["CD", "CG"], reason: "'Congo' names two countries (CD and CG) and a river." },
  korea: { candidates: ["KR", "KP"], reason: "'Korea' may mean the Republic of Korea (KR) or the Democratic People's Republic of Korea (KP)." },
  america: { candidates: ["US"], reason: "'America' also names the continents." },
  macedonia: { candidates: ["MK"], reason: "'Macedonia' is also a region of Greece; the country's ISO short name is North Macedonia." },
  "virgin islands": { candidates: ["VG", "VI"], reason: "British (VG) and U.S. (VI) Virgin Islands." },
  niger: { candidates: ["NE"], reason: "'Niger' is also a river and part of 'Nigeria'." },
  panama: { candidates: ["PA"], reason: "'Panama' is also a hat and a canal." },
  chile: { candidates: ["CL"], reason: "'chile' is also a spelling of the pepper." },
  man: { candidates: ["IM"], reason: "'man' is an ordinary word." },
};
/** Ambiguous words that are ignored unless capitalised in the text (in lower case they are far more often ordinary words). */
export const CAPITALISED_ONLY = new Set(["chad", "jersey", "man"]);

/** Phrases that contain a country name or demonym but do not refer to that country. */
export const BLOCKED_PHRASES = [
  "indian ocean", "american indian", "american indians", "native american", "native americans", "latin america", "latin american",
  "south america", "south american", "north america", "north american", "central america", "central american", "pan american",
  "new mexico", "new jersey", "new england", "new south wales", "british columbia", "new guinea", "guinea pig", "guinea pigs",
  "french fries", "french toast", "turkish delight", "dutch oven", "swiss cheese", "german measles", "spanish flu", "danish pastry",
  "chinese medicine", "brussels sprouts", "west indies", "east indies", "indian summer", "georgia tech", "jersey city",
];

/**
 * Country-code TLDs that are widely registered for generic, non-national use (Google Search Central's list of
 * domains it treats as generic). For these a ccTLD says nothing about any country.
 */
export const GENERIC_CCTLDS = ["ad", "as", "bz", "cc", "cd", "co", "dj", "fm", "io", "la", "me", "ms", "nu", "sc", "sr", "su", "tv", "tk", "ws"];

/** EU institutions' language list and membership (Treaty on European Union; Regulation No 1). */
export const EU = {
  languages: ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv"],
  members: ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
};

/**
 * Names in other languages (or alternative spellings) that are also English words, cities or personal names
 * ("island" is Icelandic/Danish/Czech for Iceland; "norfolk" is Czech for Norfolk Island and an English county).
 * They stay in the registry as aliases but are not used to find places in free text.
 */
export const NOT_IN_FREE_TEXT = new Set([
  "island", "norfolk", "benign", "columbia", "chili", "swede", "tunis", "maurice", "salvador", "dominique", "grenade", "granada",
  "emirates", "cocos", "timor", "comoro", "chine", "yamal", "rasha", "guiana", "prathet", "mkutano", "norra", "jersi", "cook", "christmas",
]);
