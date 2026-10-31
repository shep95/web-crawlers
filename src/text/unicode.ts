/**
 * Character-level Unicode properties computed with the JavaScript regex engine
 * (`\p{…}` property escapes) and the ICU data bundled with Node — no Unicode
 * database is shipped with this service. Properties ECMAScript does not expose
 * (character names, bidi classes, numeric values of non-decimal numbers) are
 * either derived by a documented rule or omitted, never guessed.
 */

/** Unicode / ICU versions the running Node process implements (property results depend on them). */
export const UNICODE_RUNTIME = { unicode: process.versions.unicode ?? null, icu: process.versions.icu ?? null } as const;

/** General categories (UAX #44) in rough frequency order: first match wins. */
const GENERAL_CATEGORIES: Array<[string, string]> = [
  ["Ll", "Lowercase_Letter"], ["Lu", "Uppercase_Letter"], ["Lo", "Other_Letter"], ["Zs", "Space_Separator"], ["Po", "Other_Punctuation"],
  ["Nd", "Decimal_Number"], ["Cc", "Control"], ["Mn", "Nonspacing_Mark"], ["Mc", "Spacing_Mark"], ["Pd", "Dash_Punctuation"],
  ["Ps", "Open_Punctuation"], ["Pe", "Close_Punctuation"], ["Pi", "Initial_Punctuation"], ["Pf", "Final_Punctuation"], ["Pc", "Connector_Punctuation"],
  ["Sm", "Math_Symbol"], ["Sc", "Currency_Symbol"], ["Sk", "Modifier_Symbol"], ["So", "Other_Symbol"], ["Lm", "Modifier_Letter"],
  ["Lt", "Titlecase_Letter"], ["Me", "Enclosing_Mark"], ["Nl", "Letter_Number"], ["No", "Other_Number"], ["Cf", "Format"],
  ["Zl", "Line_Separator"], ["Zp", "Paragraph_Separator"], ["Cs", "Surrogate"], ["Co", "Private_Use"], ["Cn", "Unassigned"],
];
const GC_RE = GENERAL_CATEGORIES.map(([code, name]) => ({ code, name, re: new RegExp(`^\\p{gc=${code}}$`, "u") }));

/** Scripts checked with `\p{Script=…}` (name → ISO 15924 code). Code points in other scripts report script null. */
const SCRIPTS: Array<[string, string]> = [
  ["Latin", "Latn"], ["Common", "Zyyy"], ["Inherited", "Zinh"], ["Han", "Hani"], ["Cyrillic", "Cyrl"], ["Arabic", "Arab"], ["Greek", "Grek"],
  ["Hiragana", "Hira"], ["Katakana", "Kana"], ["Hangul", "Hang"], ["Devanagari", "Deva"], ["Hebrew", "Hebr"], ["Thai", "Thai"],
  ["Bengali", "Beng"], ["Tamil", "Taml"], ["Telugu", "Telu"], ["Kannada", "Knda"], ["Malayalam", "Mlym"], ["Gujarati", "Gujr"],
  ["Gurmukhi", "Guru"], ["Oriya", "Orya"], ["Sinhala", "Sinh"], ["Khmer", "Khmr"], ["Lao", "Laoo"], ["Myanmar", "Mymr"],
  ["Tibetan", "Tibt"], ["Georgian", "Geor"], ["Armenian", "Armn"], ["Ethiopic", "Ethi"], ["Syriac", "Syrc"], ["Thaana", "Thaa"],
  ["Mongolian", "Mong"], ["Bopomofo", "Bopo"], ["Yi", "Yiii"], ["Cherokee", "Cher"], ["Tifinagh", "Tfng"], ["Canadian_Aboriginal", "Cans"],
  ["Javanese", "Java"], ["Balinese", "Bali"], ["Sundanese", "Sund"], ["Tai_Le", "Tale"], ["Tai_Tham", "Lana"], ["Tai_Viet", "Tavt"],
  ["Ol_Chiki", "Olck"], ["Vai", "Vaii"], ["Adlam", "Adlm"], ["Nko", "Nkoo"], ["Samaritan", "Samr"], ["Mandaic", "Mand"],
  ["Hanifi_Rohingya", "Rohg"], ["Chakma", "Cakm"], ["Meetei_Mayek", "Mtei"], ["Lepcha", "Lepc"], ["Limbu", "Limb"], ["Buginese", "Bugi"],
  ["Batak", "Batk"], ["Tagalog", "Tglg"], ["Cham", "Cham"], ["Lisu", "Lisu"], ["Osage", "Osge"], ["Bamum", "Bamu"], ["Coptic", "Copt"],
  ["Glagolitic", "Glag"], ["Gothic", "Goth"], ["Runic", "Runr"], ["Ogham", "Ogam"], ["Braille", "Brai"], ["Cuneiform", "Xsux"],
  ["Egyptian_Hieroglyphs", "Egyp"],
];
const SCRIPT_RE = SCRIPTS.flatMap(([name, code]) => {
  try {
    return [{ name, code, re: new RegExp(`^\\p{Script=${name}}$`, "u") }];
  } catch {
    return []; // script unknown to this runtime's Unicode version
  }
});
export const SCRIPT_CODES: ReadonlyMap<string, string> = new Map(SCRIPTS);
/** Scripts written right-to-left (used for direction hints; bidi classes are not exposed by ECMAScript). */
export const RTL_SCRIPTS = new Set(["Arabic", "Hebrew", "Syriac", "Thaana", "Nko", "Samaritan", "Mandaic", "Adlam", "Hanifi_Rohingya"]);

const RE = {
  mark: /^\p{M}$/u,
  upper: /^\p{Uppercase}$/u,
  lower: /^\p{Lowercase}$/u,
  cased: /^\p{Cased}$/u,
  folds: /^\p{Changes_When_Casefolded}$/u,
  pictographic: /^\p{Extended_Pictographic}$/u,
  emojiPresentation: /^\p{Emoji_Presentation}$/u,
  emojiModifier: /^\p{Emoji_Modifier}$/u,
  regionalIndicator: /^\p{Regional_Indicator}$/u,
  variationSelector: /^\p{Variation_Selector}$/u,
  ignorable: /^\p{Default_Ignorable_Code_Point}$/u,
  bidiControl: /^\p{Bidi_Control}$/u,
  joinControl: /^\p{Join_Control}$/u,
  whiteSpace: /^\p{White_Space}$/u,
  noncharacter: /^\p{Noncharacter_Code_Point}$/u,
  nd: /^\p{Nd}$/u,
};

/**
 * Curated names for the invisible, format and bidi-control characters this
 * service flags (Unicode character names, as published in UnicodeData.txt).
 * Names are given only for these characters — Node has no name database.
 */
export const SPECIAL_CHARACTERS: ReadonlyMap<number, { name: string; kind: "invisible" | "bidi" | "joiner" | "bom" | "filler" | "tag" | "variation-selector" }> = new Map([
  [0x00ad, { name: "SOFT HYPHEN", kind: "invisible" }],
  [0x034f, { name: "COMBINING GRAPHEME JOINER", kind: "invisible" }],
  [0x061c, { name: "ARABIC LETTER MARK", kind: "bidi" }],
  [0x115f, { name: "HANGUL CHOSEONG FILLER", kind: "filler" }],
  [0x1160, { name: "HANGUL JUNGSEONG FILLER", kind: "filler" }],
  [0x180e, { name: "MONGOLIAN VOWEL SEPARATOR", kind: "invisible" }],
  [0x200b, { name: "ZERO WIDTH SPACE", kind: "invisible" }],
  [0x200c, { name: "ZERO WIDTH NON-JOINER", kind: "joiner" }],
  [0x200d, { name: "ZERO WIDTH JOINER", kind: "joiner" }],
  [0x200e, { name: "LEFT-TO-RIGHT MARK", kind: "bidi" }],
  [0x200f, { name: "RIGHT-TO-LEFT MARK", kind: "bidi" }],
  [0x202a, { name: "LEFT-TO-RIGHT EMBEDDING", kind: "bidi" }],
  [0x202b, { name: "RIGHT-TO-LEFT EMBEDDING", kind: "bidi" }],
  [0x202c, { name: "POP DIRECTIONAL FORMATTING", kind: "bidi" }],
  [0x202d, { name: "LEFT-TO-RIGHT OVERRIDE", kind: "bidi" }],
  [0x202e, { name: "RIGHT-TO-LEFT OVERRIDE", kind: "bidi" }],
  [0x2060, { name: "WORD JOINER", kind: "invisible" }],
  [0x2061, { name: "FUNCTION APPLICATION", kind: "invisible" }],
  [0x2062, { name: "INVISIBLE TIMES", kind: "invisible" }],
  [0x2063, { name: "INVISIBLE SEPARATOR", kind: "invisible" }],
  [0x2064, { name: "INVISIBLE PLUS", kind: "invisible" }],
  [0x2066, { name: "LEFT-TO-RIGHT ISOLATE", kind: "bidi" }],
  [0x2067, { name: "RIGHT-TO-LEFT ISOLATE", kind: "bidi" }],
  [0x2068, { name: "FIRST STRONG ISOLATE", kind: "bidi" }],
  [0x2069, { name: "POP DIRECTIONAL ISOLATE", kind: "bidi" }],
  [0x3164, { name: "HANGUL FILLER", kind: "filler" }],
  [0xfeff, { name: "ZERO WIDTH NO-BREAK SPACE", kind: "bom" }],
  [0xffa0, { name: "HALFWIDTH HANGUL FILLER", kind: "filler" }],
  [0xe0001, { name: "LANGUAGE TAG", kind: "tag" }],
  [0xe007f, { name: "CANCEL TAG", kind: "tag" }],
]);

/** Bidi formatting characters that open / close an embedding, override or isolate (UAX #9). */
export const BIDI_OPENERS = new Map<number, "embedding" | "override" | "isolate">([[0x202a, "embedding"], [0x202b, "embedding"], [0x202d, "override"], [0x202e, "override"], [0x2066, "isolate"], [0x2067, "isolate"], [0x2068, "isolate"]]);
export const BIDI_CLOSERS = new Map<number, "embedding" | "isolate">([[0x202c, "embedding"], [0x2069, "isolate"]]);

/**
 * Curated subset of the UTS #39 confusables data: Cyrillic and Greek letters
 * that render like Latin letters in common fonts. Not the full table.
 */
export const CONFUSABLES: ReadonlyMap<string, string> = new Map(Object.entries({
  // Cyrillic lowercase
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "ѕ": "s", "і": "i",
  "ј": "j", "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ѵ": "v", "ґ": "r",
  // Cyrillic uppercase
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C",
  "Т": "T", "Х": "X", "У": "Y", "Ѕ": "S", "І": "I", "Ј": "J", "Ӏ": "I", "Ԛ": "Q", "Ԝ": "W",
  // Greek lowercase
  "ο": "o", "α": "a", "ν": "v", "ρ": "p", "ι": "i", "κ": "k", "υ": "u", "χ": "x",
  // Greek uppercase
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
}));

export interface CodePointInfo {
  codePoint: string;
  decimal: number;
  utf8: string;
  utf16: string[];
  category: string;
  categoryName: string;
  script: string | null;
  scriptCode: string | null;
  /** Unicode name — only for the curated special characters (see SPECIAL_CHARACTERS). */
  name?: string;
  combiningMark: boolean;
  /** Decimal digit value (Nd only; derived from the contiguous 0–9 run rule of the Unicode stability policy). */
  numericValue?: number;
  case: { upper: boolean; lower: boolean; cased: boolean; toUpper?: string; toLower?: string; caseFolded?: string };
  emoji?: { extendedPictographic: boolean; emojiPresentation: boolean; modifier: boolean; regionalIndicator: boolean };
  /** Normalization forms of this code point in isolation, listed only when they differ from it. */
  normalization?: Partial<Record<"NFC" | "NFD" | "NFKC" | "NFKD", string>>;
  defaultIgnorable?: true;
  bidiControl?: true;
  joinControl?: true;
  variationSelector?: true;
  whiteSpace?: true;
  noncharacter?: true;
  special?: "invisible" | "bidi" | "joiner" | "bom" | "filler" | "tag" | "variation-selector";
  confusableWith?: string;
}

export const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const cpList = (s: string) => [...s].map((c) => hex(c.codePointAt(0)!)).join(" ");

const gcCache = new Map<number, { code: string; name: string }>();
export function generalCategory(cp: number): { code: string; name: string } {
  let hit = gcCache.get(cp);
  if (!hit) {
    const ch = String.fromCodePoint(cp);
    const m = GC_RE.find((g) => g.re.test(ch));
    hit = m ? { code: m.code, name: m.name } : { code: "Cn", name: "Unassigned" };
    if (gcCache.size < 50_000) gcCache.set(cp, hit);
  }
  return hit;
}

const scriptCache = new Map<number, string | null>();
export function scriptOf(cp: number): string | null {
  let hit = scriptCache.get(cp);
  if (hit === undefined) {
    const ch = String.fromCodePoint(cp);
    hit = SCRIPT_RE.find((s) => s.re.test(ch))?.name ?? null;
    if (scriptCache.size < 50_000) scriptCache.set(cp, hit);
  }
  return hit;
}

/** Decimal digit value: Nd characters are always encoded in contiguous runs 0..9, so value = distance from run start mod 10. */
export function decimalValue(cp: number): number | undefined {
  const isNd = (c: number) => c >= 0 && RE.nd.test(String.fromCodePoint(c));
  if (!isNd(cp)) return undefined;
  let start = cp;
  while (cp - start < 200 && isNd(start - 1)) start--;
  return (cp - start) % 10;
}

/** Approximate Unicode full case folding: upper→lower (Cherokee folds to uppercase). Not the CaseFolding.txt table. */
export function caseFold(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!RE.folds.test(ch)) out += ch;
    else if (scriptOf(ch.codePointAt(0)!) === "Cherokee") out += ch.toUpperCase();
    else out += ch.toUpperCase().toLowerCase();
  }
  return out;
}

export const isCombiningMark = (ch: string) => RE.mark.test(ch);
export const isDefaultIgnorable = (ch: string) => RE.ignorable.test(ch);
export const isBidiControl = (ch: string) => RE.bidiControl.test(ch);
export const isVariationSelector = (ch: string) => RE.variationSelector.test(ch);
export const isPictographic = (ch: string) => RE.pictographic.test(ch);

/** Tag characters U+E0000–E007F (used in emoji flag sequences and, maliciously, to hide text). */
export const isTagCharacter = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;

/** Classify a code point as invisible/format/control when it renders nothing (or nothing visible). */
export function invisibleKind(cp: number): CodePointInfo["special"] | "control" | "format" | null {
  const special = SPECIAL_CHARACTERS.get(cp);
  if (special) return special.kind;
  const ch = String.fromCodePoint(cp);
  if (isTagCharacter(cp)) return "tag";
  if (RE.variationSelector.test(ch)) return "variation-selector";
  if (RE.ignorable.test(ch)) return "invisible";
  const gc = generalCategory(cp).code;
  if (gc === "Cf") return "format";
  if (gc === "Cc" && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return "control";
  return null;
}

const infoCache = new Map<number, CodePointInfo>();
/** Full property sheet for one code point (memoised). */
export function describeCodePoint(cp: number): CodePointInfo {
  const hit = infoCache.get(cp);
  if (hit) return hit;
  const ch = String.fromCodePoint(cp);
  const gc = generalCategory(cp);
  const script = scriptOf(cp);
  const utf8 = cp >= 0xd800 && cp <= 0xdfff ? "(lone surrogate: not encodable; encoders substitute EF BF BD)" : [...Buffer.from(ch, "utf8")].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  const utf16: string[] = [];
  for (let i = 0; i < ch.length; i++) utf16.push(ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0"));
  const upper = RE.upper.test(ch);
  const lower = RE.lower.test(ch);
  const cased = RE.cased.test(ch);
  const info: CodePointInfo = {
    codePoint: hex(cp),
    decimal: cp,
    utf8,
    utf16,
    category: gc.code,
    categoryName: gc.name,
    script,
    scriptCode: script ? SCRIPT_CODES.get(script) ?? null : null,
    combiningMark: RE.mark.test(ch),
    case: { upper, lower, cased },
  };
  const special = SPECIAL_CHARACTERS.get(cp);
  if (special) info.name = special.name;
  const nv = decimalValue(cp);
  if (nv !== undefined) info.numericValue = nv;
  if (cased || RE.folds.test(ch)) {
    const u = ch.toUpperCase();
    const l = ch.toLowerCase();
    const f = caseFold(ch);
    if (u !== ch) info.case.toUpper = u;
    if (l !== ch) info.case.toLower = l;
    if (f !== ch) info.case.caseFolded = f;
  }
  const pict = RE.pictographic.test(ch);
  const ri = RE.regionalIndicator.test(ch);
  const mod = RE.emojiModifier.test(ch);
  if (pict || ri || mod) info.emoji = { extendedPictographic: pict, emojiPresentation: RE.emojiPresentation.test(ch), modifier: mod, regionalIndicator: ri };
  if (!(cp >= 0xd800 && cp <= 0xdfff)) {
    const norm: CodePointInfo["normalization"] = {};
    for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
      const n = ch.normalize(form);
      if (n !== ch) norm[form] = cpList(n);
    }
    if (Object.keys(norm).length) info.normalization = norm;
  }
  if (RE.ignorable.test(ch)) info.defaultIgnorable = true;
  if (RE.bidiControl.test(ch)) info.bidiControl = true;
  if (RE.joinControl.test(ch)) info.joinControl = true;
  if (RE.variationSelector.test(ch)) info.variationSelector = true;
  if (RE.whiteSpace.test(ch)) info.whiteSpace = true;
  if (RE.noncharacter.test(ch)) info.noncharacter = true;
  const kind = invisibleKind(cp);
  if (kind && kind !== "control" && kind !== "format") info.special = kind;
  const look = CONFUSABLES.get(ch);
  if (look) info.confusableWith = `${look} (${hex(look.codePointAt(0)!)} LATIN)`;
  if (infoCache.size < 20_000) infoCache.set(cp, info);
  return info;
}

/** UTS #39-style allowed script combinations within one word (single script, or Latin with the CJK sets). */
export function scriptMixAllowed(scripts: Set<string>): boolean {
  const s = [...scripts].filter((x) => x !== "Common" && x !== "Inherited");
  if (s.length <= 1) return true;
  const within = (allowed: string[]) => s.every((x) => allowed.includes(x));
  return within(["Latin", "Han", "Hiragana", "Katakana"]) || within(["Latin", "Han", "Bopomofo"]) || within(["Latin", "Han", "Hangul"]);
}
