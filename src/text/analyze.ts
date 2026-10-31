import { detectLanguage, type LanguageGuess } from "./language.js";
import { detectSecrets, type SecretFinding, type SecretType } from "./secrets.js";
import { countSentences, countWords, paragraphs, sentences, TextIndex, utf8Length, words, type Position, type Span } from "./segment.js";
import {
  BIDI_CLOSERS, BIDI_OPENERS, CONFUSABLES, RTL_SCRIPTS, SCRIPT_CODES, SPECIAL_CHARACTERS, UNICODE_RUNTIME,
  caseFold, describeCodePoint, generalCategory, hex, invisibleKind, isPictographic, scriptMixAllowed, scriptOf, type CodePointInfo,
} from "./unicode.js";

/** What text can and cannot tell — returned with every text-intelligence response. */
export const TEXT_LIMITS = {
  identity:
    "Text cannot reveal who typed it, on which device, from where, or which keys were pressed. That kind of data exists only as separate, consented records kept by the application a person typed into; this crawler never collects it.",
  units:
    "Offsets count characters of the text as stored, in four distinct units: UTF-8 bytes, UTF-16 code units, Unicode code points and grapheme clusters (user-perceived characters). None of them is a keystroke count: input methods, dead keys, autocorrect and paste produce text with no 1:1 relation to keys.",
  language: "Language identification is a statistical inference (n-gram model); short or mixed text is reported as uncertain or 'und'.",
  confusables: "Homoglyph detection uses a curated Latin/Cyrillic/Greek subset of the UTS #39 confusables data plus mixed-script checks per word; it is a signal, not proof of intent.",
  names: "Unicode character names are given only for the curated invisible/format/bidi characters; Node.js ships no character-name database, so other names are omitted rather than guessed.",
  secrets: "Secret detection is pattern-based. Values are always redacted — only type, confidence and location are reported — and secrets are redacted from stored text before indexing.",
  runtime: `Unicode properties and segmentation come from this Node.js runtime (Unicode ${UNICODE_RUNTIME.unicode ?? "?"}, ICU ${UNICODE_RUNTIME.icu ?? "?"}); results for newly encoded characters depend on that version.`,
} as const;

export interface Located extends Position {
  length: number;
}

export interface InvisibleFinding extends Located {
  codePoint: string;
  name?: string;
  kind: string;
  /** False when the character is doing its normal job (inside an emoji sequence, a joining script, a leading BOM). */
  suspicious: boolean;
  context?: string;
}

export interface BidiFinding extends Located {
  codePoint: string;
  name?: string;
  role: "embedding" | "override" | "isolate" | "pop" | "mark";
}

export interface ConfusableFinding extends Located {
  word: string;
  kind: "mixed-script" | "whole-script-confusable";
  scripts: string[];
  /** The word with the curated homoglyphs replaced by the Latin letters they imitate. */
  looksLike: string;
  characters: Array<{ char: string; codePoint: string; script: string | null; looksLike?: string; utf16Offset: number }>;
}

export interface SecretLocated extends Located {
  type: SecretType;
  confidence: SecretFinding["confidence"];
  redacted: string;
  likelyPlaceholder?: true;
}

interface Scan {
  utf16: number;
  codePoints: number;
  graphemes: number;
  utf8Bytes: number;
  nonAscii: number;
  combiningMarks: number;
  replacementCharacters: number;
  controlCharacters: number;
  emojiSequences: number;
  zwjSequences: number;
  rtlLetters: number;
  scripts: Map<string, number>;
  invisible: Array<{ start: number; cp: number; length: number; kind: string; suspicious: boolean; context?: string }>;
  bidi: Array<{ start: number; cp: number; role: BidiFinding["role"] }>;
  unterminatedBidi: Array<{ start: number; cp: number }>;
  graphemeStarts: number[];
}

const JOINING_OK = new Set(["Arabic", "Syriac", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Khmer", "Myanmar", "Mongolian", "Hebrew", "Thaana", "Tibetan"]);
const ZWSP_OK = new Set(["Thai", "Lao", "Khmer", "Myanmar", "Tibetan", "Javanese", "Balinese"]);
const LINE_END = /^[\n\r\u0085\u2028\u2029]$/;

function letterScriptNear(text: string, i: number, dir: -1 | 1): string | null {
  for (let j = i, steps = 0; j >= 0 && j < text.length && steps < 4; j += dir, steps++) {
    const cp = text.codePointAt(j)!;
    if (cp >= 0xdc00 && cp <= 0xdfff) continue;
    const s = scriptOf(cp);
    if (s && s !== "Common" && s !== "Inherited") return s;
    if (!invisibleKind(cp) && generalCategory(cp).code[0] !== "M") return null;
  }
  return null;
}

/** One linear pass over graphemes and code points: counts, scripts, invisible and bidi characters. */
function scan(text: string): Scan {
  const s: Scan = {
    utf16: text.length, codePoints: 0, graphemes: 0, utf8Bytes: 0, nonAscii: 0, combiningMarks: 0, replacementCharacters: 0, controlCharacters: 0,
    emojiSequences: 0, zwjSequences: 0, rtlLetters: 0, scripts: new Map(), invisible: [], bidi: [], unterminatedBidi: [], graphemeStarts: [],
  };
  let stack: Array<{ start: number; cp: number; type: "embedding" | "override" | "isolate" }> = [];
  const closeLine = () => {
    for (const o of stack) s.unterminatedBidi.push({ start: o.start, cp: o.cp });
    stack = [];
  };
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const g of seg.segment(text)) {
    s.graphemes++;
    s.graphemeStarts.push(g.index);
    const cluster = g.segment;
    const emoji = cluster.length > 1 && [...cluster].some((c) => isPictographic(c) || /\p{Regional_Indicator}/u.test(c));
    if (emoji) {
      s.emojiSequences++;
      if (cluster.includes("‍")) s.zwjSequences++;
    }
    let off = g.index;
    for (const ch of cluster) {
      const cp = ch.codePointAt(0)!;
      s.codePoints++;
      s.utf8Bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (cp >= 0x80) s.nonAscii++;
      if (cp === 0xfffd) s.replacementCharacters++;
      if (LINE_END.test(ch)) closeLine();
      if (cp >= 0x80 || /[A-Za-z]/.test(ch)) {
        if (/\p{M}/u.test(ch)) s.combiningMarks++;
        if (/\p{L}/u.test(ch)) {
          const sc = scriptOf(cp) ?? "other";
          s.scripts.set(sc, (s.scripts.get(sc) ?? 0) + 1);
          if (RTL_SCRIPTS.has(sc)) s.rtlLetters++;
        }
      }
      const kind = cp < 0x20 || cp >= 0x7f ? invisibleKind(cp) : null;
      if (kind === "control") s.controlCharacters++;
      if (kind === "bidi") {
        const opener = BIDI_OPENERS.get(cp);
        const closer = BIDI_CLOSERS.get(cp);
        s.bidi.push({ start: off, cp, role: opener ?? (closer ? "pop" : "mark") });
        if (opener) stack.push({ start: off, cp, type: opener });
        else if (closer === "isolate") {
          const at = stack.map((x) => x.type).lastIndexOf("isolate");
          if (at >= 0) stack = stack.slice(0, at);
        } else if (closer === "embedding" && stack.length && stack[stack.length - 1].type !== "isolate") stack.pop();
      } else if (kind && kind !== "control") {
        let suspicious = true;
        let context: string | undefined;
        if (emoji && (cp === 0x200d || kind === "variation-selector" || kind === "tag")) [suspicious, context] = [false, "part of an emoji sequence"];
        else if (cp === 0xfeff && off === 0) [suspicious, context] = [false, "byte order mark at start of text"];
        else if (cp === 0x00ad) [suspicious, context] = [false, "soft hyphen (invisible hyphenation hint)"];
        else if (kind === "variation-selector") [suspicious, context] = [false, "variation selector"];
        else if (cp === 0x200c || cp === 0x200d) {
          const before = letterScriptNear(text, off - 1, -1);
          if (before && JOINING_OK.has(before)) [suspicious, context] = [false, `joiner in ${before} text`];
        } else if (cp === 0x200b) {
          const before = letterScriptNear(text, off - 1, -1);
          if (before && ZWSP_OK.has(before)) [suspicious, context] = [false, `word separator in ${before} text`];
        }
        s.invisible.push({ start: off, cp, length: ch.length, kind, suspicious, context });
      }
      off += ch.length;
    }
  }
  closeLine();
  return s;
}

interface WordScan {
  words: number;
  confusables: Array<Omit<ConfusableFinding, keyof Located> & { start: number; length: number }>;
}

/** Word-level homoglyph checks: mixed scripts in one word, and whole-word lookalikes in Latin-dominant text. */
function scanWords(text: string, locale: string | undefined, dominantScript: string | null, limit: number): WordScan {
  const out: WordScan = { words: 0, confusables: [] };
  for (const w of new Intl.Segmenter(locale, { granularity: "word" }).segment(text)) {
    if (!w.isWordLike) continue;
    out.words++;
    if (out.confusables.length >= limit) continue;
    const word = w.segment;
    if (word.length < 2 || /^[\x00-\x7f]*$/.test(word)) continue;
    const scripts = new Set<string>();
    let letters = 0;
    let lookalikes = 0;
    for (const ch of word) {
      if (!/\p{L}/u.test(ch)) continue;
      letters++;
      const sc = scriptOf(ch.codePointAt(0)!);
      if (sc && sc !== "Common" && sc !== "Inherited") scripts.add(sc);
      if (CONFUSABLES.has(ch)) lookalikes++;
    }
    const mixed = !scriptMixAllowed(scripts);
    const whole = !mixed && dominantScript === "Latin" && scripts.size === 1 && (scripts.has("Cyrillic") || scripts.has("Greek")) && letters >= 3 && lookalikes === letters;
    if (!mixed && !whole) continue;
    const chars: ConfusableFinding["characters"] = [];
    let off = w.index;
    // Characters outside the word's majority script (or every lookalike, for whole-script confusables).
    const counts = new Map<string, number>();
    for (const ch of word) {
      const sc = scriptOf(ch.codePointAt(0)!);
      if (sc) counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
    const majority = [...counts].filter(([k]) => k !== "Common" && k !== "Inherited").sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const ch of word) {
      const sc = scriptOf(ch.codePointAt(0)!);
      if ((whole && CONFUSABLES.has(ch)) || (mixed && sc && sc !== majority && sc !== "Common" && sc !== "Inherited") || (mixed && CONFUSABLES.has(ch))) {
        if (chars.length < 20) chars.push({ char: ch, codePoint: hex(ch.codePointAt(0)!), script: sc, looksLike: CONFUSABLES.get(ch), utf16Offset: off });
      }
      off += ch.length;
    }
    out.confusables.push({
      word,
      kind: mixed ? "mixed-script" : "whole-script-confusable",
      scripts: [...scripts],
      looksLike: [...word].map((c) => CONFUSABLES.get(c) ?? c).join("").normalize("NFKC"),
      characters: chars,
      start: w.index,
      length: word.length,
    });
  }
  return out;
}

function dominant(scripts: Map<string, number>): string | null {
  return [...scripts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function scriptList(scripts: Map<string, number>) {
  const total = [...scripts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...scripts].sort((a, b) => b[1] - a[1]).map(([script, letters]) => ({ script, code: SCRIPT_CODES.get(script) ?? null, letters, share: Number((letters / total).toFixed(4)) }));
}

function normalizationOf(text: string) {
  const forms = {} as Record<"NFC" | "NFD" | "NFKC" | "NFKD", { isNormalized: boolean; utf16: number; codePoints: number; utf8Bytes: number }>;
  for (const f of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
    const n = text.normalize(f);
    forms[f] = { isNormalized: n === text, utf16: n.length, codePoints: [...n].length, utf8Bytes: utf8Length(n) };
  }
  const form = forms.NFC.isNormalized ? "NFC" : forms.NFD.isNormalized ? "NFD" : "none (mixed composed/decomposed)";
  return { form, forms, caseFoldingChangesText: caseFold(text) !== text };
}

function locate<T extends { start: number; length: number }>(index: TextIndex, items: T[]): Array<Omit<T, "start"> & Located> {
  const pos = index.positions(items.map((i) => i.start));
  return items.map((it, k) => {
    const { start: _s, ...rest } = it;
    return { ...rest, ...pos[k], length: it.length };
  });
}

/** Replace any secret inside [start, end) by its redaction marker. */
function masked(text: string, start: number, end: number, secrets: SecretFinding[]): string {
  const hits = secrets.filter((s) => s.start < end && s.end > start);
  if (!hits.length) return text.slice(start, end);
  let out = "";
  let at = start;
  for (const h of hits) {
    out += text.slice(at, Math.max(at, h.start)) + h.redacted;
    at = Math.max(at, h.end);
  }
  return out + text.slice(Math.min(at, end), end);
}

// ------------------------------------------------------------------ summary (pipeline)

export interface TextSummary {
  analysedUtf16: number;
  totalUtf16: number;
  truncated: boolean;
  counts: { utf16: number; codePoints: number; graphemes: number; utf8Bytes: number; words: number; sentences: number; paragraphs: number; lines: number; nonAsciiCodePoints: number; combiningMarks: number; emojiSequences: number; zwjSequences: number };
  language: LanguageGuess;
  scripts: ReturnType<typeof scriptList>;
  rtlLetters: number;
  normalization: ReturnType<typeof normalizationOf>;
  replacementCharacters: number;
  controlCharacters: number;
  invisible: { count: number; suspicious: number; byKind: Record<string, number>; first: InvisibleFinding[] };
  bidi: { count: number; unterminated: number; byRole: Record<string, number>; first: BidiFinding[]; unterminatedAt: Located[] };
  confusables: { count: number; first: ConfusableFinding[] };
  secrets: { count: number; byType: Record<string, number>; first: SecretLocated[] };
}

const named = (cp: number) => {
  const name = SPECIAL_CHARACTERS.get(cp)?.name;
  return name ? { name } : {};
};
const tally = <T>(items: T[], key: (t: T) => string) => items.reduce<Record<string, number>>((acc, it) => ((acc[key(it)] = (acc[key(it)] ?? 0) + 1), acc), {});

/** Bounded summary of a document's text (stored as observations; character-level detail is computed on demand). */
export async function summarizeText(full: string, opts: { maxChars?: number; firstN?: number; lang?: string } = {}): Promise<TextSummary> {
  const max = opts.maxChars ?? 200_000;
  let text = full.length > max ? full.slice(0, max) : full;
  // Never cut a surrogate pair in half.
  if (text.length < full.length && /[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  const n = opts.firstN ?? 20;
  const secrets = detectSecrets(text);
  const s = scan(text);
  const index = new TextIndex(text);
  const dom = dominant(s.scripts);
  const lang = await detectLanguage(secrets.length ? masked(text, 0, text.length, secrets) : text);
  const locale = opts.lang ?? (lang.status === "detected" ? lang.tag : undefined);
  const ws = scanWords(text, locale, dom, n);
  const invisibleSuspicious = s.invisible.filter((x) => x.suspicious);
  const invisibleShown = [...invisibleSuspicious, ...s.invisible.filter((x) => !x.suspicious)].slice(0, n).sort((a, b) => a.start - b.start);
  return {
    analysedUtf16: text.length,
    totalUtf16: full.length,
    truncated: text.length < full.length,
    counts: {
      utf16: s.utf16, codePoints: s.codePoints, graphemes: s.graphemes, utf8Bytes: s.utf8Bytes, words: ws.words, sentences: countSentences(text, locale),
      paragraphs: paragraphs(text).length, lines: index.lineStarts.length, nonAsciiCodePoints: s.nonAscii, combiningMarks: s.combiningMarks, emojiSequences: s.emojiSequences, zwjSequences: s.zwjSequences,
    },
    language: lang,
    scripts: scriptList(s.scripts).slice(0, 12),
    rtlLetters: s.rtlLetters,
    normalization: normalizationOf(text),
    replacementCharacters: s.replacementCharacters,
    controlCharacters: s.controlCharacters,
    invisible: {
      count: s.invisible.length,
      suspicious: invisibleSuspicious.length,
      byKind: tally(s.invisible, (x) => x.kind),
      first: locate(index, invisibleShown).map(({ cp, ...x }): InvisibleFinding => ({ ...x, codePoint: hex(cp), ...named(cp) })),
    },
    bidi: {
      count: s.bidi.length,
      unterminated: s.unterminatedBidi.length,
      byRole: tally(s.bidi, (x) => x.role),
      first: locate(index, s.bidi.slice(0, n).map((b) => ({ ...b, length: 1 }))).map(({ cp, ...x }): BidiFinding => ({ ...x, codePoint: hex(cp), ...named(cp) })),
      unterminatedAt: locate(index, s.unterminatedBidi.slice(0, n).map((b) => ({ start: b.start, length: 1 }))),
    },
    confusables: { count: ws.confusables.length, first: locate(index, ws.confusables) as ConfusableFinding[] },
    secrets: {
      count: secrets.length,
      byType: tally(secrets, (x) => x.type),
      first: locate(index, secrets.slice(0, n).map((f) => ({ start: f.start, length: f.length, type: f.type, confidence: f.confidence, redacted: f.redacted, ...(f.likelyPlaceholder ? { likelyPlaceholder: f.likelyPlaceholder } : {}) }))),
    },
  };
}

// ------------------------------------------------------------------ full analysis (on demand)

export interface CharacterEntry extends Partial<CodePointInfo> {
  index: number;
  utf16Offset: number;
  utf8Offset: number;
  graphemeIndex: number;
  line: number;
  column: number;
  char?: string;
  /** Set (and every property withheld) when the character is part of a detected secret. */
  redacted?: SecretType;
}

export interface GraphemeEntry {
  index: number;
  text?: string;
  utf16Offset: number;
  codePointOffset: number;
  utf8Offset: number;
  codePoints: number;
  utf16Units: number;
  utf8Bytes: number;
  codePointList?: string[];
  emojiSequence?: true;
  zwjSequence?: true;
  redacted?: SecretType;
}

export interface SpanEntry {
  index: number;
  text: string;
  isWordLike?: boolean;
  start: Position;
  utf16Length: number;
  codePoints: number;
  graphemes: number;
  utf8Bytes: number;
}

export interface TextAnalysis extends Omit<TextSummary, "analysedUtf16" | "totalUtf16" | "truncated"> {
  characters: CharacterEntry[];
  graphemes: GraphemeEntry[];
  words: SpanEntry[];
  sentences: SpanEntry[];
  paragraphs: SpanEntry[];
  segmentationLocale: string | null;
  truncated: { characters: boolean; segments: boolean };
  unicode: typeof UNICODE_RUNTIME;
  limits: typeof TEXT_LIMITS;
}

/** Character / grapheme / word / sentence / paragraph analysis of a short text (API: ≤ 2,000 code points). */
export async function analyzeText(text: string, opts: { lang?: string; maxCharacters?: number; maxSegments?: number } = {}): Promise<TextAnalysis> {
  const maxChars = opts.maxCharacters ?? 2_000;
  const maxSeg = opts.maxSegments ?? 500;
  const summary = await summarizeText(text, { maxChars: Math.max(text.length, 1), firstN: 200, lang: opts.lang });
  const secrets = detectSecrets(text);
  const secretAt = (o: number) => secrets.find((s) => o >= s.start && o < s.end);
  const index = new TextIndex(text);
  const locale = opts.lang ?? (summary.language.status === "detected" ? summary.language.tag : undefined);

  // Characters (code points) with their grapheme membership.
  const offsets: number[] = [];
  for (let i = 0; i < text.length && offsets.length < maxChars; ) {
    offsets.push(i);
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  }
  const pos = index.positions(offsets);
  const characters: CharacterEntry[] = offsets.map((o, k) => {
    const p = pos[k];
    const base = { index: p.codePointOffset, utf16Offset: o, utf8Offset: p.utf8Offset, graphemeIndex: p.graphemeOffset, line: p.line, column: p.column };
    const secret = secretAt(o);
    if (secret) return { ...base, redacted: secret.type };
    const cp = text.codePointAt(o)!;
    return { ...base, char: String.fromCodePoint(cp), ...describeCodePoint(cp) };
  });

  const gs = index.graphemeStarts;
  const gPos = index.positions(gs.slice(0, maxChars));
  const graphemes: GraphemeEntry[] = gPos.map((p, k) => {
    const end = k + 1 < gs.length ? gs[k + 1] : text.length;
    const seg = text.slice(p.utf16Offset, end);
    const cps = [...seg];
    const secret = secretAt(p.utf16Offset);
    const emoji = cps.length > 1 && cps.some((c) => isPictographic(c) || /\p{Regional_Indicator}/u.test(c));
    return {
      index: k, utf16Offset: p.utf16Offset, codePointOffset: p.codePointOffset, utf8Offset: p.utf8Offset, codePoints: cps.length, utf16Units: seg.length, utf8Bytes: utf8Length(seg),
      ...(secret ? { redacted: secret.type } : { text: seg, codePointList: cps.map((c) => hex(c.codePointAt(0)!)) }),
      ...(emoji && !secret ? { emojiSequence: true as const } : {}),
      ...(emoji && !secret && seg.includes("‍") ? { zwjSequence: true as const } : {}),
    };
  });

  const spanEntries = (spans: Span[]): SpanEntry[] => {
    const p = index.positions(spans.map((s) => s.start));
    return spans.map((s, k) => {
      const t = text.slice(s.start, s.end);
      const cps = [...t].length;
      return { index: s.index, text: masked(text, s.start, s.end, secrets), ...(s.isWordLike !== undefined ? { isWordLike: s.isWordLike } : {}), start: p[k], utf16Length: t.length, codePoints: cps, graphemes: upperBoundCount(gs, s.end - 1) - upperBoundCount(gs, s.start - 1), utf8Bytes: utf8Length(t) };
    });
  };
  const w = words(text, locale, { limit: maxSeg + 1 });
  const se = sentences(text, locale, { limit: maxSeg + 1 });
  const pa = paragraphs(text, { limit: maxSeg + 1 });
  const { analysedUtf16: _a, totalUtf16: _t, truncated: _tr, ...rest } = summary;
  return {
    ...rest,
    counts: { ...summary.counts, words: countWords(text, locale) },
    characters,
    graphemes,
    words: spanEntries(w.slice(0, maxSeg)),
    sentences: spanEntries(se.slice(0, maxSeg)),
    paragraphs: spanEntries(pa.slice(0, maxSeg)),
    segmentationLocale: locale ?? null,
    truncated: { characters: offsets.length < summary.counts.codePoints, segments: w.length > maxSeg || se.length > maxSeg || pa.length > maxSeg },
    unicode: UNICODE_RUNTIME,
    limits: TEXT_LIMITS,
  };
}

/** Number of elements ≤ x. */
function upperBoundCount(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ exact occurrences

export interface Occurrence extends Position {
  length: { utf16: number; codePoints: number; graphemes: number; utf8Bytes: number };
  /** True when the match starts and ends on grapheme-cluster boundaries (e.g. "e" inside "é" is not). */
  graphemeAligned: boolean;
  context: { before: string; match: string; after: string };
}

/** Every exact (code-unit-identical, non-overlapping) occurrence of `q` in `text`, with positions in all units and ±context. */
export function findOccurrences(text: string, q: string, opts: { limit?: number; context?: number; index?: TextIndex } = {}): { occurrences: Occurrence[]; total: number; truncated: boolean } {
  const limit = opts.limit ?? 100;
  const ctx = opts.context ?? 60;
  if (!q) return { occurrences: [], total: 0, truncated: false };
  const starts: number[] = [];
  let total = 0;
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
    total++;
    if (starts.length < limit) starts.push(i);
    if (total > 100_000) break;
  }
  if (!starts.length) return { occurrences: [], total, truncated: total > 0 };
  const index = opts.index ?? new TextIndex(text);
  const gs = index.graphemeStarts;
  const gsSet = new Set(gs);
  const pos = index.positions(starts);
  const qLen = { utf16: q.length, codePoints: [...q].length, graphemes: 0, utf8Bytes: utf8Length(q) };
  const back = (from: number, n: number) => {
    let i = from;
    for (let k = 0; k < n && i > 0; k++) i -= i >= 2 && /[\udc00-\udfff]/.test(text[i - 1]) && /[\ud800-\udbff]/.test(text[i - 2]) ? 2 : 1;
    return gs[Math.max(0, upperBoundCount(gs, i) - 1)] ?? 0;
  };
  const fwd = (from: number, n: number) => {
    let i = from;
    for (let k = 0; k < n && i < text.length; k++) i += text.codePointAt(i)! > 0xffff ? 2 : 1;
    const g = gs[upperBoundCount(gs, i - 1)];
    return g === undefined ? text.length : g;
  };
  const occurrences = starts.map((st, k) => {
    const end = st + q.length;
    const gEnd = upperBoundCount(gs, end - 1);
    return {
      ...pos[k],
      length: { ...qLen, graphemes: gEnd - pos[k].graphemeOffset },
      graphemeAligned: gsSet.has(st) && (end === text.length || gsSet.has(end)),
      context: { before: text.slice(back(st, ctx), st), match: text.slice(st, end), after: text.slice(end, fwd(end, ctx)) },
    };
  });
  return { occurrences, total, truncated: total > starts.length };
}

/** Code point analysis of a query that is a single grapheme cluster. */
export function graphemeAnalysis(q: string): { grapheme: string; codePoints: Array<CodePointInfo & { char: string }> } | null {
  const seg = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(q)];
  if (seg.length !== 1) return null;
  return { grapheme: q, codePoints: [...q].map((c) => ({ char: c, ...describeCodePoint(c.codePointAt(0)!) })) };
}
