import { scriptOf } from "./unicode.js";

/**
 * Language identification with `eld` (Efficient Language Detector, n-gram
 * model, ~60 languages). Results are inferences, reported as BCP 47 primary
 * language subtags (ISO 639-1) or "und" when the text is too short or the
 * model gives no answer. Scores are eld's normalised n-gram scores, not
 * probabilities.
 */
export interface LanguageGuess {
  /** BCP 47 tag, or "und" (undetermined). */
  tag: string;
  status: "detected" | "uncertain" | "undetermined";
  /** eld score of the top language (0–1), null when undetermined. */
  score: number | null;
  alternatives: Array<{ tag: string; score: number }>;
  /** Dominant script (ISO 15924) of the letters examined. */
  script: string | null;
  lettersExamined: number;
  method: string;
  reason?: string;
}

interface EldLike {
  detect(text: string): { language: string; getScores(): Record<string, number>; isReliable(): boolean };
}
let eldPromise: Promise<EldLike> | null = null;
/** Lazy: the extrasmall n-gram database (~1 MB, ~0.2 s to load) is loaded on first use, not at process start. */
function loadEld(): Promise<EldLike> {
  return (eldPromise ??= import("eld/extrasmall").then((m) => m.eld as unknown as EldLike).catch((err) => {
    eldPromise = null;
    throw err;
  }));
}

const DENSE_SCRIPTS = new Set(["Han", "Hiragana", "Katakana", "Hangul", "Thai", "Lao", "Khmer", "Myanmar"]);
const ISO15924: Record<string, string> = { Latin: "Latn", Cyrillic: "Cyrl", Greek: "Grek", Arabic: "Arab", Hebrew: "Hebr", Han: "Hani", Hiragana: "Hira", Katakana: "Kana", Hangul: "Hang", Devanagari: "Deva", Thai: "Thai" };

export const LANGUAGE_METHOD = "eld@2 n-gram language detection (extrasmall database)";

export async function detectLanguage(text: string, opts: { sampleChars?: number } = {}): Promise<LanguageGuess> {
  const sample = text.slice(0, opts.sampleChars ?? 20_000);
  const scripts = new Map<string, number>();
  let letters = 0;
  for (const m of sample.matchAll(/\p{L}/gu)) {
    letters++;
    const s = scriptOf(m[0].codePointAt(0)!) ?? "other";
    scripts.set(s, (scripts.get(s) ?? 0) + 1);
  }
  const dominant = [...scripts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const script = dominant ? ISO15924[dominant] ?? dominant : null;
  // Dense scripts carry more information per letter than alphabetic ones.
  const minLetters = dominant && DENSE_SCRIPTS.has(dominant) ? 4 : 12;
  const und = (reason: string): LanguageGuess => ({ tag: "und", status: "undetermined", score: null, alternatives: [], script, lettersExamined: letters, method: LANGUAGE_METHOD, reason });
  if (letters < minLetters) return und(`too short to identify (${letters} letters; needs ≥ ${minLetters})`);
  let eld: EldLike;
  try {
    eld = await loadEld();
  } catch (err) {
    return und(`language model unavailable: ${(err as Error).message.slice(0, 120)}`);
  }
  const r = eld.detect(sample);
  if (!r.language) return und("no language matched");
  const scores = Object.entries(r.getScores()).sort((a, b) => b[1] - a[1]);
  const top = scores[0]?.[1] ?? null;
  const second = scores[1]?.[1] ?? 0;
  const enough = dominant && DENSE_SCRIPTS.has(dominant) ? letters >= 10 : letters >= 40;
  const reliable = r.isReliable() && enough && (top === null || top - second > 0.005);
  return {
    tag: r.language,
    status: reliable ? "detected" : "uncertain",
    score: top === null ? null : Number(top.toFixed(3)),
    alternatives: scores.slice(1, 4).map(([tag, score]) => ({ tag, score: Number(score.toFixed(3)) })),
    script,
    lettersExamined: letters,
    method: LANGUAGE_METHOD,
    reason: reliable ? undefined : !enough ? `short text (${letters} letters): identification is uncertain` : "close or unreliable scores between candidate languages",
  };
}
