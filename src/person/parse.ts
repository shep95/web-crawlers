/**
 * People search queries: `@human Name (location) (birthday)`.
 *
 * Parenthesised parts are optional and may come in any order; each is read as a date of birth when it parses
 * as one, otherwise as a location. Plain forms work too: `@human Jane Doe, Austin TX, born 1985`.
 */

export interface PartialDate {
  y: number;
  m?: number;
  d?: number;
  precision: "day" | "month" | "year";
  /** True when a numeric date could be read either way round (03/04/1990) and month-first was assumed. */
  ambiguous?: boolean;
  text: string;
}

export interface PersonQuery {
  raw: string;
  name: string;
  tokens: string[];
  location: string | null;
  locationParts: string[];
  born: PartialDate | null;
  warnings: string[];
}

export const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validYear = (y: number) => y >= 1000 && y <= new Date().getUTCFullYear() + 1;

function make(y: number, m: number | undefined, d: number | undefined, text: string, ambiguous = false): PartialDate | null {
  if (!validYear(y)) return null;
  if (m !== undefined && (m < 1 || m > 12)) return null;
  if (d !== undefined && (m === undefined || d < 1 || d > daysIn(y, m))) return null;
  return { y, ...(m ? { m } : {}), ...(d ? { d } : {}), precision: d ? "day" : m ? "month" : "year", ...(ambiguous ? { ambiguous } : {}), text };
}

/** Reads one date of birth from free text ("1985-03-02", "March 2, 1985", "2 Mar 1985", "03/02/1985", "1985", "born 1985"). */
export function parseBirthday(input: string): PartialDate | null {
  const s = input.trim().toLowerCase().replace(/^(?:born|b\.|dob|date of birth|birthday|bday)\s*(?:on|in|:)?\s*/, "").replace(/(\d)(st|nd|rd|th)\b/g, "$1").trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return make(+m[1], +m[2], +m[3], input.trim());
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})$/))) return make(+m[1], +m[2], undefined, input.trim());
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12) return make(y, b, a, input.trim());
    if (b > 12) return make(y, a, b, input.trim());
    return make(y, a, b, input.trim(), a !== b);
  }
  if ((m = s.match(new RegExp(`^${MONTH_RE}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})$`)))) return make(+m[3], MONTHS[m[1]], +m[2], input.trim());
  if ((m = s.match(new RegExp(`^(\\d{1,2})\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})$`)))) return make(+m[3], MONTHS[m[2]], +m[1], input.trim());
  if ((m = s.match(new RegExp(`^${MONTH_RE}\\.?,?\\s+(\\d{4})$`)))) return make(+m[2], MONTHS[m[1]], undefined, input.trim());
  if ((m = s.match(/^(\d{4})$/))) return make(+m[1], undefined, undefined, input.trim());
  return null;
}

/** Name tokens: letters (any script), apostrophes and hyphens inside names; honorifics and suffixes dropped. */
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "dame", "rev", "hon"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"]);
export function nameTokens(name: string): string[] {
  return (name.normalize("NFC").match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*\.?/gu) ?? [])
    .map((t) => t.replace(/\.$/, ""))
    .filter((t, i, all) => !(i === 0 && all.length > 1 && HONORIFICS.has(t.toLowerCase())) && !(i > 0 && SUFFIXES.has(t.toLowerCase())));
}

export function parsePersonQuery(raw: string, extra: { name?: string; location?: string; born?: string } = {}): PersonQuery {
  const warnings: string[] = [];
  let text = raw.normalize("NFC").replace(/^\s*@(?:human|person|people)\b:?/i, "").trim();
  const groups: string[] = [];
  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner: string) => { if (inner.trim()) groups.push(inner.trim()); return " "; });
  // Plain form: "Name, place, born 1985" / "Name born March 2 1985 in Austin".
  const bornInline = text.match(/\b(?:born|b\.|dob)\s*(?:on|in)?\s*([^,;]+?)(?=\s+in\s+|[,;]|$)/i);
  if (bornInline) {
    groups.push("born " + bornInline[1].trim());
    text = text.replace(bornInline[0], " ");
  }
  const inPlace = text.match(/\s+(?:from|in|of)\s+([^,;]+)$/i);
  const commaParts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  let name = commaParts[0] ?? "";
  for (const p of commaParts.slice(1)) groups.push(p);
  if (inPlace && commaParts.length === 1) {
    name = text.slice(0, inPlace.index).trim();
    groups.push(inPlace[1].trim());
  }
  if (extra.name?.trim()) name = extra.name.trim();
  let born: PartialDate | null = extra.born ? parseBirthday(extra.born) : null;
  if (extra.born && !born) warnings.push(`"${extra.born}" is not a date of birth Void can read; try 1985-03-02, March 2 1985 or 1985.`);
  const places: string[] = extra.location?.trim() ? [extra.location.trim()] : [];
  for (const g of groups) {
    const d = parseBirthday(g);
    if (d) {
      if (!born) born = d;
      else if (!extra.born) warnings.push(`More than one date of birth given; using ${born.text}.`);
    } else if (/^(?:born|b\.|dob)\b/i.test(g)) warnings.push(`"${g}" is not a date of birth Void can read; try 1985-03-02, March 2 1985 or 1985.`);
    else if (!extra.location) places.push(g);
  }
  if (born?.ambiguous) warnings.push(`${born.text} could be day-first or month-first; read as month ${born.m}, day ${born.d}.`);
  const tokens = nameTokens(name);
  if (tokens.length === 1) warnings.push("Only one name given: results include everyone with that name. Add a surname, location or birthday to narrow it down.");
  const location = places.join(", ") || null;
  return { raw, name: tokens.join(" "), tokens, location, locationParts: location ? splitLocation(location) : [], born, warnings };
}

/** US state names and postal codes, so "TX" matches pages that say "Texas" and back. */
export const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};

/** "Austin, TX" → ["austin", "texas"]; each part is matched separately and all parts must appear somewhere. */
export function splitLocation(location: string): string[] {
  const parts = location.split(/[,;/]|\s+-\s+/).map((p) => fold(p).trim()).filter((p) => p.length >= 2);
  const out: string[] = [];
  for (const p of parts) {
    // "Austin TX" without a comma: split a trailing state code.
    const m = p.match(/^(.*\S)\s+([a-z]{2})$/);
    if (m && US_STATES[m[2]]) {
      out.push(m[1], US_STATES[m[2]]);
      continue;
    }
    out.push(US_STATES[p] ?? p);
  }
  return [...new Set(out)];
}

/**
 * Lower-case and strip combining marks, one character at a time, so indexes in the folded text are indexes
 * in the original (characters whose folded form has a different length are kept as they are).
 */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += f.length === ch.length ? f : ch;
  }
  return out;
}
