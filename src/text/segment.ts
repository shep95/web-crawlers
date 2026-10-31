/**
 * Segmentation (UAX #29 via Intl.Segmenter / ICU) and offset bookkeeping.
 *
 * Units are kept distinct: UTF-8 bytes, UTF-16 code units (JavaScript string
 * indexes), Unicode code points, and extended grapheme clusters (what a reader
 * perceives as one character). None of them is a keystroke: input methods,
 * dead keys, autocorrect and paste all produce text without a 1:1 relation
 * to keys pressed.
 */

type Granularity = "grapheme" | "word" | "sentence";
const segmenters = new Map<string, Intl.Segmenter>();

/** Cached Intl.Segmenter; an unknown/invalid locale falls back to the root locale (ICU dictionaries still apply per script). */
export function segmenter(granularity: Granularity, locale?: string): Intl.Segmenter {
  const key = `${granularity}|${locale ?? ""}`;
  let s = segmenters.get(key);
  if (!s) {
    try {
      s = new Intl.Segmenter(locale && locale !== "und" ? locale : undefined, { granularity });
    } catch {
      s = new Intl.Segmenter(undefined, { granularity });
    }
    if (segmenters.size < 200) segmenters.set(key, s);
  }
  return s;
}

export interface Span {
  index: number;
  text: string;
  /** UTF-16 start / end (end exclusive). */
  start: number;
  end: number;
  isWordLike?: boolean;
}

/** UTF-16 start offsets of every grapheme cluster. */
export function graphemeStarts(text: string): number[] {
  const out: number[] = [];
  for (const g of segmenter("grapheme").segment(text)) out.push(g.index);
  return out;
}

export function countGraphemes(text: string): number {
  let n = 0;
  for (const _ of segmenter("grapheme").segment(text)) n++;
  return n;
}

export function countCodePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

const WORD_SEGMENT_CAP = 1_000_000;
/**
 * Word count by UAX #29 word boundaries (+ ICU dictionaries for Chinese,
 * Japanese, Thai, Khmer, Lao, Burmese), counting word-like segments only.
 * Text beyond 1,000,000 UTF-16 units is estimated by whitespace runs.
 */
export function countWords(text: string, locale?: string): number {
  let n = 0;
  for (const w of segmenter("word", locale).segment(text.length > WORD_SEGMENT_CAP ? text.slice(0, WORD_SEGMENT_CAP) : text)) if (w.isWordLike) n++;
  if (text.length > WORD_SEGMENT_CAP) n += text.slice(WORD_SEGMENT_CAP).split(/\s+/).filter(Boolean).length;
  return n;
}

export function words(text: string, locale?: string, opts: { limit?: number; wordLikeOnly?: boolean } = {}): Span[] {
  const out: Span[] = [];
  let i = 0;
  for (const w of segmenter("word", locale).segment(text)) {
    if (opts.wordLikeOnly && !w.isWordLike) continue;
    out.push({ index: i++, text: w.segment, start: w.index, end: w.index + w.segment.length, isWordLike: Boolean(w.isWordLike) });
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}

export function sentences(text: string, locale?: string, opts: { limit?: number } = {}): Span[] {
  const out: Span[] = [];
  for (const s of segmenter("sentence", locale).segment(text)) {
    if (!s.segment.trim()) continue;
    out.push({ index: out.length, text: s.segment, start: s.index, end: s.index + s.segment.length });
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}

export function countSentences(text: string, locale?: string): number {
  let n = 0;
  for (const s of segmenter("sentence", locale).segment(text)) if (s.segment.trim()) n++;
  return n;
}

const PARAGRAPH_BREAK = /(?:\r\n|\r|\n)[ \t ]*(?:(?:\r\n|\r|\n)[ \t ]*)+|\u2029/g;
/** Paragraphs separated by blank lines (or U+2029 PARAGRAPH SEPARATOR); whitespace-only paragraphs dropped. */
export function paragraphs(text: string, opts: { limit?: number } = {}): Span[] {
  const out: Span[] = [];
  let last = 0;
  const push = (start: number, end: number) => {
    const raw = text.slice(start, end);
    if (!raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    out.push({ index: out.length, text: body, start: start + lead, end: start + lead + body.length });
  };
  for (const m of text.matchAll(PARAGRAPH_BREAK)) {
    push(last, m.index);
    last = m.index + m[0].length;
    if (opts.limit !== undefined && out.length >= opts.limit) return out;
  }
  push(last, text.length);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

const LINE_BREAK = /\r\n|\n|\r|\u0085|\u2028|\u2029/g;
/** UTF-16 offsets where each line starts (mandatory breaks: LF, CR, CRLF, NEL, LS, PS). */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (const m of text.matchAll(LINE_BREAK)) out.push(m.index + m[0].length);
  return out;
}

export interface Position {
  /** UTF-16 code-unit offset (JavaScript string index). */
  utf16Offset: number;
  /** Unicode code-point offset. */
  codePointOffset: number;
  /** UTF-8 byte offset (of this text as UTF-8, not of the original file). */
  utf8Offset: number;
  /** Index of the extended grapheme cluster containing the offset. */
  graphemeOffset: number;
  /** 1-based line. */
  line: number;
  /** 1-based column in code points. */
  column: number;
  /** 1-based column in grapheme clusters. */
  graphemeColumn: number;
}

/** upper bound: number of elements ≤ x in a sorted array. */
function upperBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Converts UTF-16 offsets into every other unit in one linear sweep (graphemes and lines computed once). */
export class TextIndex {
  private gStarts: number[] | null = null;
  private lStarts: number[] | null = null;
  constructor(readonly text: string) {}

  get graphemeStarts(): number[] {
    return (this.gStarts ??= graphemeStarts(this.text));
  }
  get lineStarts(): number[] {
    return (this.lStarts ??= lineStarts(this.text));
  }

  positions(offsets: readonly number[]): Position[] {
    if (!offsets.length) return [];
    const lines = this.lineStarts;
    const gs = this.graphemeStarts;
    const wanted = new Set<number>();
    for (const o of offsets) {
      wanted.add(o);
      wanted.add(lines[upperBound(lines, o) - 1]);
    }
    const sorted = [...wanted].sort((a, b) => a - b);
    const cpAt = new Map<number, number>();
    const u8At = new Map<number, number>();
    const t = this.text;
    let cp = 0;
    let u8 = 0;
    let k = 0;
    for (let i = 0; i <= t.length && k < sorted.length; ) {
      while (k < sorted.length && sorted[k] <= i) {
        cpAt.set(sorted[k], cp);
        u8At.set(sorted[k], u8);
        k++;
      }
      if (i >= t.length) break;
      const c = t.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length && (t.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        u8 += 4;
        i += 2;
      } else {
        u8 += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        i += 1;
      }
      cp++;
    }
    return offsets.map((o) => {
      const li = upperBound(lines, o) - 1;
      const ls = lines[li];
      const g = Math.max(0, upperBound(gs, o) - 1);
      const gl = Math.max(0, upperBound(gs, ls) - 1);
      return { utf16Offset: o, codePointOffset: cpAt.get(o)!, utf8Offset: u8At.get(o)!, graphemeOffset: g, line: li + 1, column: cpAt.get(o)! - cpAt.get(ls)! + 1, graphemeColumn: g - gl + 1 };
    });
  }

  position(offset: number): Position {
    return this.positions([offset])[0];
  }
}

export function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
