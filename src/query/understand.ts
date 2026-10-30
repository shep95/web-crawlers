/**
 * Query understanding: turns a whole question into a structured search plan.
 *
 *   question → lexical (language, script, tokens, phrases, abbreviations, acronyms, spelling variants, quotes)
 *            → syntax (actions, noun phrases, prepositions, negation, conjunctions)
 *            → meaning (entities, entity types, relationships, topic, concept expansions)
 *            → intent (one or more operations)
 *            → constraints (hard requirements vs soft preferences; inclusions and exclusions)
 *            → context (refinements of an earlier question in the same session)
 *
 * Every element records its basis: "stated" (the words say it), "inferred" (Void's reading of the words) or
 * "uncertain" (a guess the results must confirm). Expansions are candidate search terms, never substitutes.
 * Deterministic rules on purpose: each interpretation is explainable, testable and fast.
 */

export type Basis = "stated" | "inferred" | "uncertain";
export type Strength = "hard" | "soft";
export type Intent =
  | "discover" | "retrieve_files" | "fact" | "explain" | "compare" | "extract" | "aggregate"
  | "relationships" | "chronology" | "locate" | "verify" | "monitor";

export interface Entity { text: string; type: "country" | "organization" | "organization_category" | "topic" | "date_range" | "language" | "document_type"; value: string; basis: Basis }
export interface Relationship { subject: string; predicate: "published_by" | "about" | "funded_by" | "located_in" | "created_in"; object: string; basis: Basis }
export interface Expansion { term: string; of: string; relation: "abbreviation" | "acronym" | "synonym" | "narrower" | "related" | "spelling"; basis: "inferred" }
export interface Operation { intent: Intent; evidence: string; target?: string }

export interface QueryPlan {
  original: string;
  language: { code: string; script: string };
  normalized: string;
  exactPhrases: string[];
  operations: Operation[];
  topic: { phrase: string; terms: string[]; basis: Basis };
  expansions: Expansion[];
  entities: Entity[];
  relationships: Relationship[];
  constraints: {
    publisher?: { category: "government" | "academic" | "company" | "nonprofit" | "international"; country?: string; organization?: string; hostSuffixes: string[]; strength: Strength; basis: Basis; mode: "published_by" | "associated_with" };
    geography?: { country: string; code: string; strength: Strength; basis: Basis };
    dates?: { from: number; to: number; field: "published"; strength: Strength; basis: Basis; text: string };
    types?: { kinds: string[]; label: string; strength: Strength; basis: Basis };
    languages?: { codes: string[]; strength: Strength; basis: Basis };
    exclude: Array<{ what: string; kinds?: string[]; hostPatterns?: string[]; terms?: string[]; basis: Basis }>;
    order?: "newest" | "oldest";
    quantity?: number;
    quality?: "official" | "original";
  };
  outputs: string[];
  context: { refines: boolean; kind: "new" | "narrow" | "expand" | "correct"; carried: string[] };
  confidence: number;
  uncertain: string[];
  /** Words for the full-text index (topic + qualifiers the user typed). */
  searchTerms: string[];
  /** Queries for web discovery when the index lacks matches. */
  discoveryQueries: string[];
}

// ---------- lexical knowledge ----------
const ABBREVIATIONS: Record<string, string> = {
  gov: "government", govt: "government", "gov't": "government", docs: "documents", doc: "document", univ: "university", uni: "university",
  dept: "department", org: "organization", orgs: "organizations", intl: "international", natl: "national", info: "information",
  stats: "statistics", pubs: "publications", ai: "artificial intelligence", ml: "machine learning", nlp: "natural language processing",
  iot: "internet of things", llm: "large language model", llms: "large language models", cv: "computer vision", "r&d": "research and development",
  covid: "covid-19", uk: "united kingdom", us: "united states", usa: "united states", eu: "european union", uae: "united arab emirates",
};
const SPELLING: Array<[string, string]> = [["organisation", "organization"], ["programme", "program"], ["defence", "defense"], ["analyse", "analyze"], ["centre", "center"], ["licence", "license"], ["labour", "labor"], ["behaviour", "behavior"], ["modelling", "modeling"], ["catalogue", "catalog"]];
interface Org { name: string; country?: string; category: "government" | "academic" | "international" | "company"; hosts: string[] }
const ACRONYMS: Record<string, Org> = {
  isro: { name: "Indian Space Research Organisation", country: "IN", category: "government", hosts: ["isro.gov.in"] },
  drdo: { name: "Defence Research and Development Organisation", country: "IN", category: "government", hosts: ["drdo.gov.in"] },
  niti: { name: "NITI Aayog", country: "IN", category: "government", hosts: ["niti.gov.in"] },
  meity: { name: "Ministry of Electronics and Information Technology", country: "IN", category: "government", hosts: ["meity.gov.in"] },
  icmr: { name: "Indian Council of Medical Research", country: "IN", category: "government", hosts: ["icmr.gov.in"] },
  nasa: { name: "NASA", country: "US", category: "government", hosts: ["nasa.gov"] },
  nih: { name: "National Institutes of Health", country: "US", category: "government", hosts: ["nih.gov"] },
  nsf: { name: "National Science Foundation", country: "US", category: "government", hosts: ["nsf.gov"] },
  noaa: { name: "NOAA", country: "US", category: "government", hosts: ["noaa.gov"] },
  nist: { name: "NIST", country: "US", category: "government", hosts: ["nist.gov"] },
  cdc: { name: "Centers for Disease Control and Prevention", country: "US", category: "government", hosts: ["cdc.gov"] },
  esa: { name: "European Space Agency", category: "international", hosts: ["esa.int"] },
  who: { name: "World Health Organization", category: "international", hosts: ["who.int"] },
  oecd: { name: "OECD", category: "international", hosts: ["oecd.org"] },
  un: { name: "United Nations", category: "international", hosts: ["un.org"] },
  unesco: { name: "UNESCO", category: "international", hosts: ["unesco.org"] },
  imf: { name: "International Monetary Fund", category: "international", hosts: ["imf.org"] },
  ons: { name: "Office for National Statistics", country: "GB", category: "government", hosts: ["ons.gov.uk"] },
  nhs: { name: "NHS", country: "GB", category: "government", hosts: ["nhs.uk"] },
};
interface Country { code: string; names: string[]; demonyms: string[]; gov: string[]; academic: string[]; languages: string[] }
const COUNTRIES: Country[] = [
  { code: "IN", names: ["india"], demonyms: ["indian"], gov: ["gov.in", "nic.in"], academic: ["ac.in", "edu.in"], languages: ["en", "hi"] },
  { code: "US", names: ["united states", "america"], demonyms: ["american", "us"], gov: ["gov", "mil"], academic: ["edu"], languages: ["en"] },
  { code: "GB", names: ["united kingdom", "britain", "england", "scotland", "wales"], demonyms: ["british", "english", "scottish", "welsh"], gov: ["gov.uk", "nhs.uk", "parliament.uk", "gov.scot", "gov.wales"], academic: ["ac.uk"], languages: ["en"] },
  { code: "CA", names: ["canada"], demonyms: ["canadian"], gov: ["gc.ca", "canada.ca"], academic: [], languages: ["en", "fr"] },
  { code: "AU", names: ["australia"], demonyms: ["australian"], gov: ["gov.au"], academic: ["edu.au"], languages: ["en"] },
  { code: "NZ", names: ["new zealand"], demonyms: ["new zealand"], gov: ["govt.nz"], academic: ["ac.nz"], languages: ["en"] },
  { code: "IE", names: ["ireland"], demonyms: ["irish"], gov: ["gov.ie"], academic: [], languages: ["en", "ga"] },
  { code: "SG", names: ["singapore"], demonyms: ["singaporean"], gov: ["gov.sg"], academic: ["edu.sg"], languages: ["en"] },
  { code: "CN", names: ["china"], demonyms: ["chinese"], gov: ["gov.cn"], academic: ["edu.cn"], languages: ["zh"] },
  { code: "JP", names: ["japan"], demonyms: ["japanese"], gov: ["go.jp"], academic: ["ac.jp"], languages: ["ja"] },
  { code: "KR", names: ["south korea", "korea"], demonyms: ["korean", "south korean"], gov: ["go.kr"], academic: ["ac.kr"], languages: ["ko"] },
  { code: "DE", names: ["germany"], demonyms: ["german"], gov: ["bund.de"], academic: [], languages: ["de"] },
  { code: "FR", names: ["france"], demonyms: ["french"], gov: ["gouv.fr"], academic: [], languages: ["fr"] },
  { code: "ES", names: ["spain"], demonyms: ["spanish"], gov: ["gob.es"], academic: [], languages: ["es"] },
  { code: "IT", names: ["italy"], demonyms: ["italian"], gov: ["gov.it"], academic: [], languages: ["it"] },
  { code: "EU", names: ["european union", "europe"], demonyms: ["european"], gov: ["europa.eu"], academic: [], languages: ["en", "fr", "de"] },
  { code: "BR", names: ["brazil"], demonyms: ["brazilian"], gov: ["gov.br"], academic: [], languages: ["pt"] },
  { code: "MX", names: ["mexico"], demonyms: ["mexican"], gov: ["gob.mx"], academic: [], languages: ["es"] },
  { code: "ZA", names: ["south africa"], demonyms: ["south african"], gov: ["gov.za"], academic: ["ac.za"], languages: ["en"] },
  { code: "NG", names: ["nigeria"], demonyms: ["nigerian"], gov: ["gov.ng"], academic: ["edu.ng"], languages: ["en"] },
  { code: "KE", names: ["kenya"], demonyms: ["kenyan"], gov: ["go.ke"], academic: ["ac.ke"], languages: ["en", "sw"] },
  { code: "PK", names: ["pakistan"], demonyms: ["pakistani"], gov: ["gov.pk"], academic: ["edu.pk"], languages: ["en", "ur"] },
  { code: "BD", names: ["bangladesh"], demonyms: ["bangladeshi"], gov: ["gov.bd"], academic: ["ac.bd"], languages: ["bn"] },
  { code: "ID", names: ["indonesia"], demonyms: ["indonesian"], gov: ["go.id"], academic: ["ac.id"], languages: ["id"] },
  { code: "MY", names: ["malaysia"], demonyms: ["malaysian"], gov: ["gov.my"], academic: ["edu.my"], languages: ["ms", "en"] },
  { code: "PH", names: ["philippines"], demonyms: ["filipino", "philippine"], gov: ["gov.ph"], academic: ["edu.ph"], languages: ["en", "tl"] },
  { code: "IL", names: ["israel"], demonyms: ["israeli"], gov: ["gov.il"], academic: ["ac.il"], languages: ["he"] },
  { code: "AE", names: ["united arab emirates"], demonyms: ["emirati"], gov: ["gov.ae"], academic: [], languages: ["ar", "en"] },
  { code: "SA", names: ["saudi arabia"], demonyms: ["saudi"], gov: ["gov.sa"], academic: ["edu.sa"], languages: ["ar"] },
];
const LANGUAGES: Record<string, string> = { english: "en", hindi: "hi", french: "fr", german: "de", spanish: "es", chinese: "zh", mandarin: "zh", japanese: "ja", korean: "ko", arabic: "ar", portuguese: "pt", russian: "ru", urdu: "ur", bengali: "bn", tamil: "ta", italian: "it", hebrew: "he", swahili: "sw" };
// Concept map: candidate discovery terms (never substitutes). Keys are canonical topics.
const CONCEPTS: Record<string, Array<[string, Expansion["relation"]]>> = {
  "artificial intelligence": [["ai", "abbreviation"], ["machine learning", "narrower"], ["deep learning", "narrower"], ["artificial intelligence policy", "related"], ["national ai strategy", "related"], ["responsible ai", "related"]],
  "machine learning": [["ml", "abbreviation"], ["deep learning", "narrower"], ["neural networks", "narrower"], ["artificial intelligence", "related"]],
  "ai surveillance": [["computer vision", "related"], ["video analytics", "related"], ["facial recognition", "related"], ["object detection", "related"], ["automated monitoring", "related"]],
  "climate change": [["global warming", "synonym"], ["climate policy", "related"], ["greenhouse gas emissions", "related"], ["climate adaptation", "related"]],
  "covid-19": [["coronavirus", "synonym"], ["sars-cov-2", "synonym"], ["pandemic", "related"]],
  "renewable energy": [["solar energy", "narrower"], ["wind energy", "narrower"], ["clean energy", "synonym"]],
  "cybersecurity": [["cyber security", "spelling"], ["information security", "synonym"], ["data protection", "related"]],
  "blockchain": [["distributed ledger", "synonym"], ["cryptocurrency", "related"]],
  "public health": [["epidemiology", "related"], ["health policy", "related"]],
  "space": [["satellite", "related"], ["launch vehicle", "related"], ["space research", "related"]],
};
const DOC_TYPES: Array<[RegExp, string[], string]> = [
  [/\bpdfs?\b/, ["pdf"], "PDF files"],
  [/\b(?:spreadsheets?|excel|csv)\b/, ["csv", "office"], "spreadsheets"],
  [/\b(?:datasets?|data sets?|open data)\b/, ["csv", "json", "xml"], "datasets"],
  [/\b(?:images?|photos?|pictures?|photographs?)\b/, ["image"], "images"],
  [/\bvideos?\b/, ["video"], "videos"],
  [/\b(?:research papers?|papers?|studies|study|journal articles?)\b/, ["pdf", "webpage"], "research papers"],
  [/\b(?:reports?|white ?papers?|publications?|documents?|docs|files?|guidelines?|policies|policy documents?|strateg(?:y|ies) documents?)\b/, ["pdf", "office", "webpage"], "documents"],
];
const STOP = new Set("a an the of for to in on at by with from and or about into over under between during within across please me my i we our you your that which who whom whose this these those is are was were be been being any all some show give list get find search look locate retrieve fetch also only just now no not".split(" "));
const ACTIONS: Array<[RegExp, Intent]> = [
  [/\b(?:download|original (?:pdf|file|document)s?|get the (?:pdf|file)s?|pdfs? of)\b/, "retrieve_files"],
  [/\b(?:compare|comparison|versus|vs\.?|difference between)\b/, "compare"],
  [/\bhow many\b|\bnumber of\b|\bcount\b/, "aggregate"],
  [/\b(?:which|what) (?:agencies|organi[sz]ations|institutions|ministries|companies|universities)\b.*\b(?:funded|funds|sponsored|collaborated|partnered|published)\b|\bwho funded\b|\bfunded by whom\b|\brelationships?\b|\bcollaborat/, "relationships"],
  [/\b(?:extract|get all|list all|list the)\b.*\b(?:authors?|names?|fields?|emails?|funders?|dates?)\b/, "extract"],
  [/\bhow (?:did|has|have)\b.*\b(?:change|chang|evolv|develop)|\btimeline\b|\bover time\b|\bhistory of\b/, "chronology"],
  [/\b(?:is|are) (?:this|these|it|they) (?:authentic|genuine|real|official)\b|\bverify\b|\bauthentic/, "verify"],
  [/\b(?:new(?:ly)? published|latest|recent(?:ly)?|new research|this week|today)\b/, "monitor"],
  [/\bwhere (?:is|are)\b|\b(?:laborator(?:y|ies)|labs?|offices?|headquarters|located)\b.*\bin\b/, "locate"],
  [/^(?:how|why) (?:does|do|is|are|did)\b|\bexplain\b|\bwhat is\b|\bwhat are\b/, "explain"],
  [/^(?:when|who|what year|where)\b/, "fact"],
];

// ---------- helpers ----------
const words = (s: string) => (s.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}&'.-]*/gu) ?? []).map((w) => w.replace(/'s$/, "").replace(/[.'-]+$/, "")).filter(Boolean);
function detectScript(s: string): string {
  const scripts: Array<[string, RegExp]> = [["Devanagari", /\p{Script=Devanagari}/u], ["Arabic", /\p{Script=Arabic}/u], ["Cyrillic", /\p{Script=Cyrillic}/u], ["Han", /\p{Script=Han}/u], ["Hangul", /\p{Script=Hangul}/u], ["Hebrew", /\p{Script=Hebrew}/u], ["Greek", /\p{Script=Greek}/u], ["Bengali", /\p{Script=Bengali}/u], ["Tamil", /\p{Script=Tamil}/u], ["Hiragana/Katakana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u]];
  for (const [name, re] of scripts) if (re.test(s)) return name;
  return /\p{Script=Latin}/u.test(s) ? "Latin" : "Unknown";
}
const SCRIPT_LANG: Record<string, string> = { Devanagari: "hi", Arabic: "ar", Cyrillic: "ru", Han: "zh", Hangul: "ko", Hebrew: "he", Greek: "el", Bengali: "bn", Tamil: "ta", "Hiragana/Katakana": "ja" };
function detectLanguage(s: string, script: string): string {
  if (script !== "Latin") return SCRIPT_LANG[script] ?? "und";
  const w = words(s);
  const score = (list: string[]) => w.filter((x) => list.includes(x)).length;
  const es = score(["de", "la", "el", "los", "las", "documentos", "sobre", "gobierno", "entre", "y"]);
  const fr = score(["le", "la", "les", "des", "du", "sur", "gouvernement", "entre", "et"]);
  const de = score(["der", "die", "das", "und", "über", "zwischen", "regierung", "dokumente"]);
  const best = Math.max(es, fr, de);
  return best >= 2 ? (best === es ? "es" : best === fr ? "fr" : "de") : "en";
}
function yearOf(s: string): number | null {
  const n = Number(s);
  return n >= 1900 && n <= 2100 ? n : null;
}

/** Dates in words → an inclusive year interval. `now` anchors relative expressions ("last year"). */
export function parseDates(text: string, now = new Date()): { from: number; to: number; text: string; explicit: boolean } | null {
  const t = text.toLowerCase();
  const year = now.getUTCFullYear();
  let m = t.match(/\b(?:between|from)\s+(\d{4})\s+(?:and|to|until|till|through|-|–)\s+(\d{4})\b/) ?? t.match(/\b(\d{4})\s*(?:-|–|to|through)\s*(\d{4})\b/);
  if (m && yearOf(m[1]) && yearOf(m[2])) { const a = +m[1], b = +m[2]; return { from: Math.min(a, b), to: Math.max(a, b), text: m[0], explicit: true }; }
  m = t.match(/\b(?:since|after|from)\s+(\d{4})\b/);
  if (m && yearOf(m[1])) return { from: +m[1] + (/after/.test(m[0]) ? 1 : 0), to: year, text: m[0], explicit: true };
  m = t.match(/\b(?:before|until|prior to)\s+(\d{4})\b/);
  if (m && yearOf(m[1])) return { from: 1900, to: +m[1] - (/before|prior/.test(m[0]) ? 1 : 0), text: m[0], explicit: true };
  m = t.match(/\b(?:in|during|from|of)\s+(\d{4})\b/) ?? t.match(/\b(19\d{2}|20\d{2})\b/);
  if (m && yearOf(m[1])) return { from: +m[1], to: +m[1], text: m[0], explicit: true };
  m = t.match(/\b(?:the\s+)?(?:last|past)\s+(\d{1,2}|two|three|four|five|ten)\s+years?\b/);
  if (m) { const n = Number(m[1]) || { two: 2, three: 3, four: 4, five: 5, ten: 10 }[m[1]]!; return { from: year - n, to: year, text: m[0], explicit: false }; }
  if (/\blast year\b/.test(t)) return { from: year - 1, to: year - 1, text: "last year", explicit: false };
  if (/\bthis year\b/.test(t)) return { from: year, to: year, text: "this year", explicit: false };
  m = t.match(/\b(?:the\s+)?(19|20)(\d)0s\b/);
  if (m) { const d = Number(m[1] + m[2] + "0"); return { from: d, to: d + 9, text: m[0], explicit: true }; }
  return null;
}

/** The structured reading of one question, optionally refining the previous question in the same session. */
export function understandQuery(question: string, opts: { previous?: QueryPlan | null; now?: Date } = {}): QueryPlan {
  const original = question.trim().slice(0, 500);
  const script = detectScript(original);
  const exactPhrases = [...original.matchAll(/"([^"]{2,80})"/g)].map((m) => m[1].trim());
  // Lexical normalisation: expand abbreviations (recorded as expansions), keep quoted phrases verbatim.
  const expansions: Expansion[] = [];
  const uncertain: string[] = [];
  let text = ` ${original.toLowerCase().replace(/"[^"]*"/g, " ").replace(/[“”]/g, '"')} `;
  for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    if (re.test(text)) {
      // "us" is also a pronoun: only read it as a country next to a place-like word.
      if (abbr === "us" && !/\b(?:us|u\.s\.)\s+(?:government|gov|federal|agencies|policy|policies|documents|army|navy|congress)\b/.test(text)) continue;
      text = text.replace(re, full);
      if (!["docs", "doc", "gov", "govt", "gov't", "dept", "org", "orgs", "univ", "uni", "intl", "natl", "info", "stats", "pubs", "uk", "us", "usa", "eu", "uae"].includes(abbr)) expansions.push({ term: abbr, of: full, relation: "abbreviation", basis: "inferred" });
    }
  }
  for (const [uk, us] of SPELLING) if (text.includes(uk)) expansions.push({ term: us, of: uk, relation: "spelling", basis: "inferred" });
  else if (text.includes(us)) expansions.push({ term: uk, of: us, relation: "spelling", basis: "inferred" });
  const normalized = text.replace(/\s+/g, " ").trim();

  // Context: refinements of an earlier question.
  const prev = opts.previous ?? null;
  const correcting = /^(?:no[,.]?\s+)?i meant\b|^(?:actually|sorry)[, ]|^instead\b/.test(normalized);
  const narrowing = /^(?:only|just|now only|but only|limit (?:it|them|that) to|restrict to)\b|^(?:now\s+)?(?:exclude|without|remove|drop)\b/.test(normalized);
  const expanding = /^(?:also|and also|plus|now also|include|add)\b/.test(normalized);
  const refines = !!prev && (correcting || narrowing || expanding || /^(?:those|them|these|it|that)\b/.test(normalized) || (words(normalized).length <= 5 && !/\b(?:find|search|show|look for|what|how|who|when|where|why)\b/.test(normalized) && !!parseDates(normalized, opts.now)));

  // Intent / operations (a question can carry several).
  const operations: Operation[] = [];
  for (const [re, intent] of ACTIONS) { const m = normalized.match(re); if (m && !operations.some((o) => o.intent === intent)) operations.push({ intent, evidence: m[0] }); }
  const discoverVerb = normalized.match(/\b(?:find|search(?: for)?|look for|locate|show(?: me)?|get|retrieve|fetch|discover|list)\b/);
  if (discoverVerb || !operations.length) operations.unshift({ intent: "discover", evidence: discoverVerb?.[0] ?? "(no action word: discovery assumed)" });
  if (!discoverVerb && operations.length === 1 && operations[0].evidence.startsWith("(") && words(normalized).length >= 6 && !prev) uncertain.push("No action word; Void assumed you want sources.");

  const entities: Entity[] = [];
  const relationships: Relationship[] = [];
  const constraints: QueryPlan["constraints"] = { exclude: [] };
  const outputs: string[] = [];

  // Exclusions first, so excluded words don't become topic words.
  let body = normalized.replace(/^(?:no[,.]?\s+)?i meant\s+|^(?:actually|sorry)[, ]+|^instead\s+|^(?:now|also|and also|plus|just)\s+/, " ");
  const exclusionRe = /\b(?:exclude|excluding|except|without|but not|no|not)\s+((?:[\p{L}\p{N}'-]+(?:\s*(?:,|and|or)\s*|\s+)){0,6}?[\p{L}\p{N}'-]+)(?=$|[,.;]|\s+(?:and show|and list|show|from|between|published|in \d{4}|including|include|only))/gu;
  const fromCompanies = body.match(/\b(?:exclude|excluding|without|except|not|no)\b[^,.;]*?\b(?:from|by)\s+(?:private\s+)?(?:compan(?:y|ies)|corporations?|businesses|firms?|industry)\b/);
  if (fromCompanies) { constraints.exclude.push({ what: "private companies", hostPatterns: [".com", ".co."], basis: "stated" }); body = body.replace(fromCompanies[0], " "); }
  for (const m of body.matchAll(exclusionRe)) {
    if (/^(?:i meant|later than|earlier than)/.test(m[1])) continue;
    for (const part of m[1].split(/\s*(?:,|\band\b|\bor\b)\s*/).map((x) => x.trim()).filter(Boolean)) {
      if (/^news(?: articles?| stories| sites?)?$|^press(?: releases?)?$|^media$/.test(part)) constraints.exclude.push({ what: "news", kinds: ["feed"], hostPatterns: ["news", "times", "post", "herald", "tribune", "gazette", "bbc", "cnn", "reuters"], basis: "stated" });
      else if (/^(?:private )?compan(?:y|ies)(?: publications?| reports?)?$|^private (?:sector|firms?|companies)$|^corporate$|^businesses$/.test(part)) constraints.exclude.push({ what: "private companies", hostPatterns: [".com", ".co."], basis: "stated" });
      else if (/^(?:blogs?|forums?|social media)$/.test(part)) constraints.exclude.push({ what: part, hostPatterns: ["blog", "medium.com", "reddit.com", "forum"], basis: "stated" });
      else if (/^(?:pdfs?|images?|videos?)$/.test(part)) constraints.exclude.push({ what: part, kinds: [part.startsWith("pdf") ? "pdf" : part.startsWith("image") ? "image" : "video"], basis: "stated" });
      else if (/^duplicates?$/.test(part)) { /* uniqueness: results are always de-duplicated */ }
      else constraints.exclude.push({ what: part, terms: words(part).filter((w) => !STOP.has(w)), basis: "stated" });
    }
    body = body.replace(m[0], " ");
  }
  for (const m of original.matchAll(/(?:^|\s)-([\p{L}\p{N}]{2,})/gu)) constraints.exclude.push({ what: m[1].toLowerCase(), terms: [m[1].toLowerCase()], basis: "stated" });

  // Dates.
  const dates = parseDates(body, opts.now);
  if (dates) {
    const hard = /\b(?:only|must|strictly|between|from)\b/.test(body) || dates.explicit;
    constraints.dates = { from: dates.from, to: dates.to, field: "published", strength: hard ? "hard" : "soft", basis: dates.explicit ? "stated" : "inferred", text: dates.text };
    entities.push({ text: dates.text, type: "date_range", value: dates.from === dates.to ? String(dates.from) : `${dates.from}–${dates.to}`, basis: dates.explicit ? "stated" : "inferred" });
    if (!dates.explicit) uncertain.push(`"${dates.text}" read as ${dates.from}${dates.to !== dates.from ? "–" + dates.to : ""} (from today's date).`);
    body = body.replace(dates.text, " ");
  }
  body = body.replace(/\b(?:created|published|released|written|issued|dated)\b/g, (w) => ` ${w} `);

  // Languages: "including hindi publications", "in hindi".
  const langWords = Object.keys(LANGUAGES).filter((l) => new RegExp(`\\b${l}\\b`).test(body));
  if (langWords.length) {
    const codes = [...new Set(langWords.map((l) => LANGUAGES[l]))];
    const including = /\binclud(?:e|ing)\b/.test(body);
    constraints.languages = { codes: including ? [...new Set(["en", ...codes])] : codes, strength: including ? "soft" : /\bonly\b/.test(body) ? "hard" : "soft", basis: "stated" };
    for (const l of langWords) entities.push({ text: l, type: "language", value: LANGUAGES[l], basis: "stated" });
    body = body.replace(new RegExp(`\\b(?:including\\s+|include\\s+|in\\s+)?(?:${langWords.join("|")})(?:\\s+(?:and|or)\\s+(?:${langWords.join("|")}))*(?:\\s+(?:language\\s+)?(?:publications?|documents?|sources?|reports?|versions?))?`, "g"), " ");
  }

  // Organisations by acronym.
  for (const w of words(original)) {
    const org = ACRONYMS[w];
    if (org && (w.length > 2 || original.includes(w.toUpperCase()))) {
      // "who" and "un" are also ordinary words: read them as organisations only when written in capitals or used as a source.
      if (["who", "un"].includes(w) && !original.includes(w.toUpperCase()) && !new RegExp(`\\b${w}\\s+(?:reports?|documents?|guidelines?|publications?|data|papers?|statistics)\\b`).test(normalized)) continue;
      if (["who", "un"].includes(w) && !original.includes(w.toUpperCase())) uncertain.push(`Read "${w}" as ${org.name}.`);
      entities.push({ text: w.toUpperCase(), type: "organization", value: org.name, basis: "inferred" });
      expansions.push({ term: org.name.toLowerCase(), of: w, relation: "acronym", basis: "inferred" });
      const funded = new RegExp(`\\bfunded by\\s+(?:the\\s+)?${w}\\b`).test(normalized);
      if (funded) relationships.push({ subject: "documents", predicate: "funded_by", object: org.name, basis: "stated" });
      else if (!constraints.publisher) constraints.publisher = { category: org.category === "company" ? "company" : org.category, country: org.country, organization: org.name, hostSuffixes: org.hosts, strength: /\b(?:by|from)\s+(?:the\s+)?\w*$|published by|from\s+(?:the\s+)?/.test(normalized.split(w)[0] ?? "") ? "hard" : "soft", basis: "inferred", mode: "published_by" };
      body = body.replace(new RegExp(`\\b${w}\\b`, "g"), " ");
    }
  }

  // Country + organisation category ("indian government", "published by the government of india", "uk universities").
  const countries: Country[] = [];
  for (const c of COUNTRIES) {
    const nameHit = c.names.find((n) => new RegExp(`\\b${n}(?:'s)?\\b`).test(body));
    const demHit = c.demonyms.find((d) => d !== "us" && new RegExp(`\\b${d}\\b`).test(body));
    if (nameHit || demHit) { countries.push(c); entities.push({ text: (demHit ?? nameHit)!, type: "country", value: c.code, basis: "stated" }); }
  }
  // Two or more countries (a comparison) are subjects, not one geographic filter.
  const country: Country | undefined = countries.length === 1 ? countries[0] : undefined;
  const category: { cat: "government" | "academic" | "company" | "nonprofit" | "international"; text: string } | null =
    (body.match(/\b(?:government|governmental|ministry|ministries|federal|state|public sector|official|agency|agencies|department|departments|parliament(?:ary)?)\b/) && { cat: "government", text: body.match(/\b(?:government|governmental|ministry|ministries|federal|public sector|agency|agencies|department|departments|parliament(?:ary)?)\b/)?.[0] ?? "government" }) ||
    (body.match(/\b(?:universit(?:y|ies)|academic|college|colleges|institute of technology)\b/) && { cat: "academic", text: body.match(/\b(?:universit(?:y|ies)|academic|college|colleges)\b/)![0] }) ||
    (body.match(/\b(?:ngos?|non-profits?|nonprofits?|charit(?:y|ies)|foundations?)\b/) && { cat: "nonprofit", text: body.match(/\b(?:ngos?|non-profits?|nonprofits?|charit(?:y|ies)|foundations?)\b/)![0] }) ||
    (body.match(/\b(?:compan(?:y|ies)|corporate|industry)\b/) && !constraints.exclude.some((e) => e.what === "private companies") && { cat: "company", text: body.match(/\b(?:compan(?:y|ies)|corporate|industry)\b/)![0] }) ||
    null;
  if (category && (category.cat !== "government" || /\b(?:government|governmental|ministry|ministries|federal|agency|agencies|department|parliament)/.test(body) || /\bofficial\b/.test(body))) {
    // "documents published by the X government" → publisher; "documents about the X government" → topic association only.
    const about = new RegExp(`\\babout\\s+(?:the\\s+)?(?:\\w+\\s+){0,2}${category.text}`).test(body) && !/\b(?:by|from)\s+(?:the\s+)?(?:\w+\s+){0,2}(?:government|agenc|ministr|universit)/.test(body);
    const hosts = category.cat === "government" ? country ? country.gov : ["gov", "gov.uk", "gov.in", "gc.ca", "gov.au", "europa.eu", "int"] : category.cat === "academic" ? country ? (country.academic.length ? country.academic : []) : ["edu", "ac.uk", "ac.in"] : [];
    if (!constraints.publisher) constraints.publisher = { category: category.cat, country: country?.code, hostSuffixes: hosts, strength: about ? "soft" : "hard", basis: about ? "inferred" : "stated", mode: about ? "associated_with" : "published_by" };
    entities.push({ text: (country ? (body.match(new RegExp(`\\b(?:${[...country.demonyms, ...country.names].join("|")})\\s+${category.text}`))?.[0] ?? category.text) : category.text), type: "organization_category", value: category.cat + (country ? `:${country.code}` : ""), basis: "stated" });
    relationships.push({ subject: "documents", predicate: about ? "about" : "published_by", object: `${country ? country.names[0] + " " : ""}${category.cat}`, basis: about ? "inferred" : "stated" });
    if (!hosts.length) uncertain.push(`No known web domains for ${category.cat} sources${country ? " in " + country.names[0] : ""}; the publisher will be checked from page metadata.`);
  }
  if (countries.length > 1) relationships.push({ subject: "documents", predicate: "about", object: countries.map((c) => c.names[0]).join(" and "), basis: "stated" });
  if (country) {
    constraints.geography = { country: country.names[0], code: country.code, strength: constraints.publisher ? "hard" : "soft", basis: "stated" };
    if (!constraints.publisher) relationships.push({ subject: "documents", predicate: "located_in", object: country.names[0], basis: "inferred" });
  }
  if (/\bofficial\b/.test(body)) constraints.quality = "official";
  if (/\boriginal\b/.test(body)) constraints.quality = constraints.quality ?? "original";

  // Document types: hard when "only"/"pdf only"; soft otherwise.
  for (const [re, kinds, label] of DOC_TYPES) {
    const m = body.match(re);
    if (m) {
      const only = new RegExp(`\\bonly\\s+(?:\\w+\\s+)?${m[0]}|${m[0]}\\s+only\\b`).test(body) || label === "PDF files";
      constraints.types = { kinds, label, strength: only ? "hard" : "soft", basis: "stated" };
      entities.push({ text: m[0], type: "document_type", value: label, basis: "stated" });
      break;
    }
  }
  if (operations.some((o) => o.intent === "retrieve_files") && !constraints.types) constraints.types = { kinds: ["pdf", "office"], label: "files", strength: "soft", basis: "inferred" };

  // Ordering, quantity.
  if (/\b(?:newest|latest|most recent)(?: first)?\b|\bsort(?:ed)? by date\b/.test(body)) constraints.order = "newest";
  else if (/\boldest(?: first)?\b/.test(body)) constraints.order = "oldest";
  const qty = body.match(/\b(?:at least|top|first|up to)\s+(\d{1,4})\b/);
  if (qty) constraints.quantity = Number(qty[1]);

  // Extra operations: "show which agencies funded them" → extract funders and map agency → funds → research.
  if (/\b(?:fund(?:ed|ing|s|er|ers)?|sponsor(?:ed|s)?|grant(?:s|ed)?)\b/.test(normalized) && /\b(?:which|who|show|list|identify|map)\b/.test(normalized)) {
    outputs.push("funders");
    relationships.push({ subject: "agency", predicate: "funded_by", object: "research", basis: "stated" });
    if (!operations.some((o) => o.intent === "relationships")) operations.push({ intent: "relationships", evidence: normalized.match(/\b(?:which|who)\b[^,.]*\bfund\w*/)?.[0] ?? "funding" });
  }
  if (/\bauthors?\b/.test(normalized) && /\b(?:list|extract|show|get)\b/.test(normalized)) outputs.push("authors");
  if (/\bpublishers?\b/.test(normalized) && /\b(?:list|extract|show)\b/.test(normalized)) outputs.push("publishers");

  // Topic: what remains after structure words, preferring the phrase after "about/on/into/regarding".
  const structure = /\b(?:find|search(?: for)?|look(?:ing)? for|locate|show(?: me)?|get|retrieve|fetch|discover|list|give me|i want|i need|please|original|official|public(?:ly)? available|all|any|documents?|docs|files?|reports?|publications?|papers?|research papers?|studies|records?|sources?|pdfs?|datasets?|data|images?|videos?|government|governmental|agenc(?:y|ies)|ministr(?:y|ies)|department|departments|universit(?:y|ies)|academic|published|created|released|written|issued|dated|by|from|the|of|and|which|that|show which|funded|funding|them|newest|latest|first|oldest|only|at least|top|\d+)\b/g;
  let topicPhrase = "";
  const about = body.match(/\b(?:about|on|into|regarding|concerning|covering|related to|relating to)\s+([\p{L}\p{N}\s'-]{3,80}?)(?=$|\s+(?:created|published|released|by|from|between|in \d|during|and show|including|exclud|with|that|which)\b|[,.;])/u);
  if (about) topicPhrase = about[1];
  else {
    topicPhrase = body.replace(structure, " ");
  }
  for (const c of countries) for (const n of [...c.names, ...c.demonyms]) topicPhrase = topicPhrase.replace(new RegExp(`\\b${n}(?:'s)?\\b`, "g"), " ");
  topicPhrase = topicPhrase.replace(/\b(?:how many|how much|how|what|when|who|whom|where|why|which|were|was|is|are|do|does|did|compare|comparison|versus|vs|difference between|show me|tell me)\b/g, " ");
  topicPhrase = topicPhrase.replace(structure, (w) => (/^(?:data|research)$/.test(w) ? w : " ")).replace(/\s+/g, " ").trim();
  let topicTerms = [...new Set(words(topicPhrase).filter((w) => !STOP.has(w) && w.length > 1))];
  if (!topicTerms.length && exactPhrases.length) topicTerms = words(exactPhrases.join(" "));
  topicPhrase = topicTerms.join(" ");
  if (topicPhrase) entities.push({ text: topicPhrase, type: "topic", value: topicPhrase, basis: "stated" });

  // Concept expansions for the topic (candidates only).
  for (const [concept, related] of Object.entries(CONCEPTS)) {
    if (topicPhrase.includes(concept) || (concept === "ai surveillance" && /\bartificial intelligence\b/.test(topicPhrase) && /\bsurveillance\b/.test(topicPhrase))) {
      for (const [term, relation] of related) if (!expansions.some((e) => e.term === term) && !topicPhrase.includes(term)) expansions.push({ term, of: concept, relation, basis: "inferred" });
    }
  }

  // Refinement: carry the earlier question's meaning forward; the newer words win on conflict.
  const carried: string[] = [];
  let contextKind: QueryPlan["context"]["kind"] = "new";
  if (refines && prev) {
    contextKind = correcting ? "correct" : expanding ? "expand" : "narrow";
    if (!topicTerms.length || narrowing || correcting) {
      if (!topicTerms.length || (narrowing && !about)) { topicTerms = prev.topic.terms; topicPhrase = prev.topic.phrase; carried.push("topic"); }
    }
    for (const key of ["publisher", "geography", "dates", "types", "languages", "order", "quantity", "quality"] as const) {
      if (constraints[key] === undefined && prev.constraints[key] !== undefined) { (constraints as Record<string, unknown>)[key] = prev.constraints[key]; carried.push(key); }
    }
    if (expanding && constraints.publisher && prev.constraints.publisher && constraints.publisher.category !== prev.constraints.publisher.category) {
      constraints.publisher = { ...prev.constraints.publisher, hostSuffixes: [...new Set([...prev.constraints.publisher.hostSuffixes, ...constraints.publisher.hostSuffixes])], strength: "soft" };
    }
    constraints.exclude = [...prev.constraints.exclude.filter((e) => !constraints.exclude.some((x) => x.what === e.what)), ...constraints.exclude];
    for (const o of prev.outputs) if (!outputs.includes(o)) outputs.push(o);
    if (carried.length) for (const e of prev.entities) if (!entities.some((x) => x.type === e.type)) entities.push(e);
    for (const e of prev.expansions) if (!expansions.some((x) => x.term === e.term)) expansions.push(e);
  }

  if (!topicTerms.length) uncertain.push("No clear topic; results match the other conditions only.");
  // Search text: the topic words plus exact phrases; discovery queries add the structure back in words a web search understands.
  const searchTerms = [...new Set([...topicTerms, ...exactPhrases.flatMap((p) => words(p))])].slice(0, 12);
  const pub = constraints.publisher;
  const site = pub?.hostSuffixes.find((h) => h.includes("."));
  const yearText = constraints.dates ? (constraints.dates.from === constraints.dates.to ? String(constraints.dates.from) : `${constraints.dates.from}..${constraints.dates.to}`) : "";
  const typeWord = constraints.types?.kinds.includes("pdf") ? "filetype:pdf" : constraints.types?.label === "datasets" ? "dataset" : "";
  const discoveryQueries = [...new Set([
    [topicPhrase, pub?.organization ?? (pub ? `${country?.names[0] ?? ""} ${pub.category}` : country?.names[0] ?? ""), constraints.types?.label === "documents" ? "report" : "", yearText].join(" ").replace(/\s+/g, " ").trim(),
    site ? [topicPhrase, `site:${site}`, typeWord].join(" ").replace(/\s+/g, " ").trim() : "",
    ...expansions.filter((e) => e.relation !== "spelling").slice(0, 2).map((e) => [e.term, site ? `site:${site}` : country?.names[0] ?? "", typeWord].join(" ").replace(/\s+/g, " ").trim()),
  ].filter((x) => x && x.length > 2))].slice(0, 4);

  // Confidence: start high, lose for each guess.
  const confidence = Math.max(0.2, Math.min(1, 0.95 - uncertain.length * 0.15 - (topicTerms.length ? 0 : 0.3) - (refines && !prev ? 0.2 : 0)));
  return {
    original,
    language: { code: detectLanguage(original, script), script },
    normalized,
    exactPhrases,
    operations,
    topic: { phrase: topicPhrase, terms: topicTerms, basis: carried.includes("topic") ? "inferred" : "stated" },
    expansions,
    entities,
    relationships,
    constraints,
    outputs,
    context: { refines: refines && !!prev, kind: contextKind, carried },
    confidence: Number(confidence.toFixed(2)),
    uncertain,
    searchTerms,
    discoveryQueries,
  };
}
