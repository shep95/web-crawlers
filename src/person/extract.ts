/**
 * What one page says about one person: where the name appears, dated events in those sentences, facts that tell
 * namesakes apart (stated birth date, age, place), with contact details masked in everything returned.
 */
import { redactSecrets } from "../corpus/redact.js";
import { fold, MONTHS, type PartialDate, type PersonQuery } from "./parse.js";

const L = "[\\p{L}\\p{N}]";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches the name in folded text: "first [middle | initial] last", "last, first", and "f. last" when the query
 * gives a full first name. Single-word names match the word alone.
 */
export function nameMatcher(q: PersonQuery): RegExp {
  const t = q.tokens.map((x) => esc(fold(x)).replace(/['’]/g, "['’]?").replace(/-/g, "[- ]?"));
  if (t.length === 1) return new RegExp(`(?<!${L})${t[0]}(?!${L})`, "gu");
  const first = t[0], last = t[t.length - 1], mids = t.slice(1, -1);
  const middle = mids.length ? `(?:\\s+(?:${mids.join("\\s+")}|${mids.map((m) => m[0]).join("\\.?\\s+")}\\.?))?` : `(?:\\s+[\\p{L}][\\p{L}'’-]{0,20}\\.?)?`;
  const forms = [`${first}${middle}\\s+${last}`, `${last},\\s+${first}(?!\\s*,)`];
  if (fold(q.tokens[0]).length > 1) forms.push(`${esc(fold(q.tokens[0])[0])}\\.\\s?${mids.length ? "(?:[\\p{L}]\\.\\s?)?" : ""}${last}`);
  return new RegExp(`(?<!${L})(?:${forms.join("|")})(?!${L})`, "gu");
}

// ---------------------------------------------------------------- privacy

/** Contact details are never returned: people search shows what public pages say, not how to reach someone. */
export function maskContacts(s: string): { text: string; masked: number } {
  let masked = 0;
  const hit = (label: string) => () => { masked++; return `[${label} hidden]`; };
  let text = redactSecrets(s).text;
  text = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, hit("email"));
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, hit("ID number"));
  text = text.replace(/(?<![\w/])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w/])/g, (m) => (m.replace(/\D/g, "").length >= 9 && !/^\d{4}\s*[-–]\s*\d{4}$/.test(m.trim()) ? hit("phone")() : m));
  text = text.replace(/\b\d{1,6}\s+(?:[A-Z][\w'-]*\.?\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?(?:,?\s+(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g, hit("street address"));
  return { text, masked };
}

// ---------------------------------------------------------------- dates

export interface FoundDate extends PartialDate {
  index: number;
  end: number;
}

const MONTH_ALT = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const DATE_PATTERNS: Array<{ re: RegExp; read: (m: RegExpExecArray) => [number, number?, number?, boolean?] }> = [
  { re: /\b(1[0-9]\d\d|20\d\d)-(\d{1,2})-(\d{1,2})\b/g, read: (m) => [+m[1], +m[2], +m[3]] },
  { re: new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), read: (m) => [+m[3], MONTHS[m[1].toLowerCase()], +m[2]] },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\.?,?\\s+(\\d{4})\\b`, "gi"), read: (m) => [+m[3], MONTHS[m[2].toLowerCase()], +m[1]] },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, read: (m) => (+m[1] > 12 ? [+m[3], +m[2], +m[1]] : [+m[3], +m[1], +m[2], +m[2] <= 12 && m[1] !== m[2]]) },
  { re: new RegExp(`\\b(${MONTH_ALT})\\.?,?\\s+(?:of\\s+)?(\\d{4})\\b`, "gi"), read: (m) => [+m[2], MONTHS[m[1].toLowerCase()]] },
  // Bare years, not inside larger numbers, prices, measurements or ranges of counts.
  { re: /(?<![\d,.$£€#-]|\d\s)\b(1[5-9]\d\d|20\d\d)\b(?![\d,%]|\s?(?:km|kg|m\b|ft|lbs?|people|students|employees|members|copies|units|words|pages|feet|miles|meters|dollars|euros|points))/gi, read: (m) => [+m[1]] },
];

/** Every date written in a span of text, earliest-matching pattern first, without overlaps. */
export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  const taken: Array<[number, number]> = [];
  const thisYear = new Date().getUTCFullYear();
  for (const p of DATE_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      const [y, mo, d, ambiguous] = p.read(m);
      if (y < 1000 || y > thisYear + 1) continue;
      if (mo !== undefined && (mo < 1 || mo > 12)) continue;
      if (d !== undefined && (d < 1 || d > new Date(Date.UTC(y, mo!, 0)).getUTCDate())) continue;
      taken.push([s, e]);
      out.push({ y, ...(mo ? { m: mo } : {}), ...(d ? { d } : {}), precision: d ? "day" : mo ? "month" : "year", ...(ambiguous ? { ambiguous: true } : {}), text: m[0], index: s, end: e });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export const dateKey = (d: { y: number; m?: number; d?: number }) => d.y * 10000 + (d.m ?? 0) * 100 + (d.d ?? 0);
export const isoOf = (d: { y: number; m?: number; d?: number }) => `${String(d.y).padStart(4, "0")}${d.m ? "-" + String(d.m).padStart(2, "0") : ""}${d.d ? "-" + String(d.d).padStart(2, "0") : ""}`;

// ---------------------------------------------------------------- events

export const EVENT_KINDS: Array<[string, RegExp]> = [
  ["birth", /\b(born|birth|b\.\s?\d)/i],
  ["death", /\b(died|dies|passed away|death|obituary|funeral|in memoriam|late)\b/i],
  ["legal", /\b(arrested|charged|convicted|sentenced|sued|lawsuit|indicted|pleaded|acquitted|court|trial|verdict)\b/i],
  ["election", /\b(elected|re-elected|sworn in|campaign|candidate|nominated|ran for|won the (?:primary|election)|seat)\b/i],
  ["education", /\b(graduated|graduate of|alumn\w*|degree|diploma|studied|enrolled|phd|doctorate|bachelor|master'?s|thesis|university|college|school)\b/i],
  ["award", /\b(award\w*|won|prize|honou?red|medal|recogni[sz]ed|fellowship|inducted)\b/i],
  ["career", /\b(joined|hired|appointed|named|promoted|became|founded|co-founded|started|launched|resigned|retired|stepped down|ceo|director|president|chair\w*|executive|manager|works? (?:at|for)|employed|career)\b/i],
  ["publication", /\b(published|wrote|writes|author\w*|released|book|album|paper|article|essay|film|novel|single|exhibition|debut)\b/i],
  ["family", /\b(married|wedding|divorced|engaged|son of|daughter of|father|mother|husband|wife|children|grand\w+)\b/i],
  ["sports", /\b(scored|signed with|drafted|season|championship|olympic\w*|tournament|league|coach\w*|match|race)\b/i],
  ["residence", /\b(moved to|lives in|living in|relocated|resident of|hometown|grew up in|native of)\b/i],
  ["speech", /\b(said|says|told|interview\w*|spoke|speaks|announced|statement|testified)\b/i],
];
export const kindOf = (sentence: string) => EVENT_KINDS.find(([, re]) => re.test(sentence))?.[0] ?? "mention";

export interface PersonEvent {
  date: { iso: string; y: number; m?: number; d?: number; precision: PartialDate["precision"]; text: string; ambiguous?: boolean };
  kind: string;
  text: string;
  /**
   * "name": the sentence names the person; "following": the next sentence continues about them (He/She/They…);
   * "surname": on a page that names them in full, a later sentence uses the surname alone ("Lovelace died in 1852").
   */
  via: "name" | "following" | "surname";
  sortKey: number;
}

export interface BirthFact {
  y: number;
  m?: number;
  d?: number;
  /** stated: "born March 2, 1985" / "(1985–2020)"; age: "Jane Doe, 38," on a page dated 2023 (±1 year). */
  how: "stated" | "age";
  yMin: number;
  yMax: number;
  text: string;
}

export interface PageReading {
  mentions: number;
  inTitle: boolean;
  sentences: string[];
  events: PersonEvent[];
  birth: BirthFact[];
  death: { y: number; text: string } | null;
  location: { matched: string[]; missing: string[] };
  roles: string[];
  masked: number;
}

/** Sentence containing [s, e) in text, by scanning for sentence ends around it (bounded to 600 characters each way). */
function sentenceAround(text: string, s: number, e: number): [number, number] {
  let a = s;
  const minA = Math.max(0, s - 600);
  while (a > minA) {
    const c = text[a - 1];
    if (c === "\n" || ((c === " " || c === "\t") && /[.!?]["'”’)]?$/.test(text.slice(Math.max(0, a - 3), a - 1)) && !/\b(?:[A-Z]|Mr|Mrs|Ms|Dr|St|Jr|Sr|No|Mt|Prof|vs|etc|[A-Z][a-z]{0,2})\.$/.test(text.slice(Math.max(0, a - 6), a - 1)))) break;
    a--;
  }
  let b = e;
  const maxB = Math.min(text.length, e + 600);
  while (b < maxB) {
    const c = text[b];
    if (c === "\n") break;
    if (/[.!?]/.test(c) && (b + 1 >= text.length || /\s/.test(text[b + 1])) && !/\b(?:[A-Z]|Mr|Mrs|Ms|Dr|St|Jr|Sr|No|Mt|Prof|vs|etc)$/.test(text.slice(Math.max(0, b - 5), b))) {
      b++;
      break;
    }
    b++;
  }
  return [a, b];
}

const PRONOUN_START = /^\s*["“]?(?:he|she|they|his|her|their|him|them)\b/i;
const ROLE_RE = /\b(?:is|was|as|became|served as|works as|worked as)\s+(?:an?|the)\s+((?:[\p{Ll}-]+\s+){0,3}(?:professor|teacher|author|writer|journalist|reporter|engineer|scientist|researcher|doctor|physician|nurse|lawyer|attorney|judge|senator|representative|mayor|governor|councilmember|council member|ceo|founder|co-founder|president|director|manager|executive|artist|musician|singer|actor|actress|athlete|player|coach|designer|developer|architect|photographer|chef|entrepreneur|investor|officer|official|economist|historian|editor|producer|filmmaker|poet|pastor|student|volunteer|analyst|consultant|chair\w*|member))\b/giu;

/** Reads one page's stored text for the person named by `re` (folded text; offsets match the original). */
export function readPage(doc: { title: string; description: string; body: string }, q: PersonQuery, re: RegExp, pageYear: number | null): PageReading {
  const text = [doc.title, doc.description, doc.body].filter(Boolean).join("\n");
  const folded = fold(text);
  const spans: Array<[number, number]> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded))) {
    // A middle word between first and last name must be capitalised in the page ("Jane Q. Doe", "Jane Ann Doe",
    // not "Jane and Doe").
    const words = text.slice(m.index, m.index + m[0].length).split(/\s+/);
    if (q.tokens.length === 2 && words.length === 3 && !/^\p{Lu}/u.test(words[1])) continue;
    spans.push([m.index, m.index + m[0].length]);
    if (spans.length > 400) break;
  }
  const titleFolded = fold(doc.title ?? "");
  re.lastIndex = 0;
  const inTitle = re.test(titleFolded);
  re.lastIndex = 0;

  const sentences: Array<{ a: number; b: number; via: PersonEvent["via"]; at: number }> = [];
  const seen = new Set<string>();
  for (const [s, e] of spans) {
    const [a, b] = sentenceAround(text, s, e);
    const k = `${a}:${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    sentences.push({ a, b, via: "name", at: s });
    // One following sentence that continues with a pronoun is about the same person.
    const [na, nb] = sentenceAround(text, Math.min(text.length, b + 1), Math.min(text.length, b + 2));
    if (na >= b && nb > na && PRONOUN_START.test(text.slice(na, nb)) && !seen.has(`${na}:${nb}`)) {
      seen.add(`${na}:${nb}`);
      sentences.push({ a: na, b: nb, via: "following", at: na });
    }
  }

  // News style refers to people by surname after the first full mention. Only on pages that name the person in
  // full, only capitalised, and not as part of a street or place name.
  if (spans.length && q.tokens.length >= 2) {
    const last = fold(q.tokens[q.tokens.length - 1]);
    const sre = new RegExp(`(?<!${L})${esc(last)}(?!${L})`, "gu");
    let n = 0;
    while ((m = sre.exec(folded)) && n < 200) {
      const at = m.index;
      if (spans.some(([a, b]) => at >= a && at < b)) continue;
      if (!/^\p{Lu}/u.test(text[at])) continue;
      if (/^\s+(?:street|st\.?|avenue|ave|road|rd|boulevard|lane|drive|park|county|city|hall|school|university|college|institute|foundation|prize|award|building|centre|center|bridge|river|lake|mountain|station|island)\b/i.test(text.slice(at + m[0].length, at + m[0].length + 14))) continue;
      const [a, b] = sentenceAround(text, at, at + m[0].length);
      if (seen.has(`${a}:${b}`) || sentences.some((x) => a < x.b && b > x.a)) continue;
      seen.add(`${a}:${b}`);
      sentences.push({ a, b, via: "surname", at });
      n++;
    }
  }

  let masked = 0;
  const events: PersonEvent[] = [];
  const out: string[] = [];
  const birth: BirthFact[] = [];
  let death: PageReading["death"] = null;
  const roles = new Set<string>();
  for (const s of sentences.slice(0, 200)) {
    const raw = text.slice(s.a, s.b).replace(/\s+/g, " ").trim();
    if (!raw) continue;
    // Long "sentences" (PDF text without punctuation) are shown as a window around the name.
    const nameAt = Math.max(0, text.slice(s.a, s.at).replace(/\s+/g, " ").trimStart().length);
    const clean = maskContacts(clip(raw, nameAt));
    masked += clean.masked;
    if (s.via === "name" && out.length < 40) out.push(clean.text);
    for (const r of raw.matchAll(ROLE_RE)) if (roles.size < 8) roles.add(r[1].toLowerCase().trim());
    // Only dates near the name (or the pronoun/surname that stands for it) are about this person: long
    // "sentences" in PDF text can hold many people and years.
    const dates = findDates(raw).filter((d) => Math.abs(d.index - nameAt) <= NEAR);
    // Birth: "born <date>" / "(born <date>)" / "b. 1970" just after the name, or a lifespan "(1931–2012)".
    // Only forms tied to the name: "Name (born …", "Name, born …", "Name was born …", "She was born …".
    const tied = s.via === "following"
      ? raw.match(/^\s*["“]?(?:he|she|they)\s+(?:was|were)\s+(?=born\s)/i)
      : raw.slice(nameAt).match(/^[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){0,4}?\s*(?:\(\s*|,\s*|\s+(?:was|is)\s+)(?=(?:born|b\.)\s)/u);
    const bornAt = tied ? (s.via === "following" ? 0 : nameAt) + tied[0].length : -1;
    if (bornAt >= 0) {
      const d = dates.find((x) => x.index > bornAt && x.index - bornAt < 60);
      if (d) birth.push({ y: d.y, m: d.m, d: d.d, how: "stated", yMin: d.y, yMax: d.y, text: clean.text });
    }
    const lifeM = s.via === "name" ? raw.slice(nameAt, nameAt + 120).match(/^[^()]{0,40}\((?:born\s+)?(1[5-9]\d\d|20\d\d)\s*[–—-]\s*(1[5-9]\d\d|20\d\d)?\s*\)/) : null;
    const life = lifeM ? Object.assign([lifeM[0].slice(lifeM[0].indexOf("(")), lifeM[1], lifeM[2]], { index: nameAt + lifeM[0].indexOf("(") }) : null;
    if (life) {
      birth.push({ y: +life[1], how: "stated", yMin: +life[1], yMax: +life[1], text: clean.text });
      if (life[2]) death = { y: +life[2], text: clean.text };
    }
    const diedTied = s.via === "following"
      ? raw.match(/^\s*["“]?(?:he|she|they)\s+(?=died\b|passed away\b)/i)
      : raw.slice(nameAt).match(/^[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){0,4}?(?:,\s*who\s+|\s+)(?=died\b|passed away\b)/u);
    const diedAt = diedTied ? (s.via === "following" ? 0 : nameAt) + diedTied[0].length : -1;
    if (diedAt >= 0 && !death) {
      const d = dates.find((x) => x.index > diedAt && x.index - diedAt < 60);
      if (d) death = { y: d.y, text: clean.text };
    }
    // Age as written in news style: "Jane Doe, 38, of Austin" — gives a birth year within one year.
    if (pageYear && s.via === "name") {
      const age = fold(raw).match(new RegExp(`(?:${re.source}),\\s+(?:age\\s+|aged\\s+)?(\\d{1,3}),`, "u"));
      const a = age ? Number(age[age.length - 1]) : NaN;
      if (a >= 1 && a <= 115) birth.push({ y: pageYear - a, how: "age", yMin: pageYear - a - 1, yMax: pageYear - a, text: clean.text });
    }
    const kind = kindOf(raw.length <= CLIP ? raw : raw.slice(Math.max(0, nameAt - 150), nameAt + NEAR));
    const lifeAt = life ? life.index : -1;
    for (const d of dates.slice(0, 6)) {
      events.push({
        date: { iso: isoOf(d), y: d.y, ...(d.m ? { m: d.m } : {}), ...(d.d ? { d: d.d } : {}), precision: d.precision, text: d.text, ...(d.ambiguous ? { ambiguous: true } : {}) },
        kind: lifeAt >= 0 && d.index >= lifeAt && d.end <= lifeAt + life![0].length ? (d.y === +life![1] ? "birth" : "death") : bornAt >= 0 && Math.abs(d.index - bornAt) < 60 ? "birth" : kind,
        // Each event's text is a window around its date (and the name, when they are close).
        text: raw.length <= CLIP ? clean.text : maskContacts(clip(raw, Math.abs(d.index - nameAt) < CLIP - 80 ? Math.min(d.index, nameAt) : d.index)).text,
        via: s.via,
        sortKey: dateKey(d),
      });
    }
  }

  const matched: string[] = [], missing: string[] = [];
  for (const part of q.locationParts) (new RegExp(`(?<!${L})${esc(part)}(?!${L})`, "u").test(folded) ? matched : missing).push(part);
  return { mentions: spans.length, inTitle, sentences: out, events: dedupeEvents(events), birth, death, location: { matched, missing }, roles: [...roles], masked };
}

const CLIP = 420;
/** How far from the name (in characters) a date may be and still be attributed to the person. */
const NEAR = 250;
/** At most CLIP characters of text, starting a little before `at`, with ellipses where cut. */
export function clip(text: string, at: number): string {
  if (text.length <= CLIP) return text;
  let a = Math.max(0, Math.min(at - 120, text.length - CLIP));
  if (a > 0) { const sp = text.indexOf(" ", a); if (sp > 0 && sp - a < 20) a = sp + 1; }
  let b = Math.min(text.length, a + CLIP);
  if (b < text.length) { const sp = text.lastIndexOf(" ", b); if (sp > a + CLIP - 30) b = sp; }
  return (a > 0 ? "…" : "") + text.slice(a, b) + (b < text.length ? "…" : "");
}

function dedupeEvents(events: PersonEvent[]): PersonEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = `${e.date.iso}|${e.text.slice(0, 120)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** How a page's stated birth facts compare with the birthday searched for. */
export function birthAgreement(born: PartialDate | null, facts: BirthFact[]): "match" | "conflict" | "unknown" {
  if (!born || !facts.length) return "unknown";
  let agrees = false;
  for (const f of facts) {
    if (born.y < f.yMin || born.y > f.yMax) {
      if (f.how === "stated") return "conflict";
      continue;
    }
    if (f.how === "stated" && born.m && f.m && (born.m !== f.m || (born.d && f.d && born.d !== f.d))) return "conflict";
    agrees = true;
  }
  return agrees ? "match" : facts.some((f) => f.how === "stated") ? "conflict" : "unknown";
}
