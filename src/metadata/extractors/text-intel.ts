import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { summarizeText } from "../../text/analyze.js";

/** Leading bytes of the raw body that declare an encoding (byte order marks). */
function byteOrderMark(body: Buffer): string | null {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "UTF-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "UTF-16BE";
  if (body[0] === 0xff && body[1] === 0xfe) return body[2] === 0 && body[3] === 0 ? "UTF-32LE" : "UTF-16LE";
  if (body[0] === 0 && body[1] === 0 && body[2] === 0xfe && body[3] === 0xff) return "UTF-32BE";
  return null;
}

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, figcaption, td, th, address";

/**
 * Text intelligence summary: encoding signals, Unicode normalization, scripts,
 * language (inferred), segment counts, invisible / bidi / homoglyph signals
 * and redacted secrets. Only bounded summaries are stored as observations;
 * character-level detail is computed on demand by /api/v2/text/*.
 */
export const textIntelligenceExtractor: Extractor = {
  id: "text-intel",
  version: "1.0.0",
  description: "Unicode text intelligence: encoding/BOM, normalization form, scripts, inferred language, grapheme/word/sentence/paragraph counts, invisible and bidi controls, homoglyph/mixed-script words, credential patterns (redacted).",
  kinds: ["webpage", "text", "pdf", "json", "csv", "xml", "feed", "email"],
  categories: [C.technical, C.structural, C.descriptive, C.integrity, C.privacy],
  // After local extractors, so the HTML body text / PDF text layer is available.
  phase: "enrich",
  timeoutMs: 5000,
  async run(ctx) {
    const plain = ctx.shared.get("plainText") as string | undefined;
    const text = plain ?? (ctx.kind === "pdf" ? "" : await ctx.text());
    if (!text) return;
    const basis = plain !== undefined ? (ctx.kind === "pdf" ? "pdf text layer (whitespace collapsed)" : "page body text (markup removed, whitespace collapsed)") : "decoded body text";
    const s = await summarizeText(text, { maxChars: 200_000, firstN: 20 });
    const scope = s.truncated ? `first ${s.analysedUtf16.toLocaleString("en")} of ${s.totalUtf16.toLocaleString("en")} UTF-16 units of the ${basis}` : `the ${basis}`;
    const where = `offsets are relative to ${scope}, not the original file bytes`;
    const obs = (method: string, evidence?: string) => ({ status: "observed" as const, method, evidence });

    // ---------------------------------------------------------------- technical
    ctx.add(C.technical, "textEncoding", {
      decodedCharset: (ctx.shared.get("charset") as string | undefined) ?? null,
      byteOrderMark: byteOrderMark(ctx.response.body),
      replacementCharacters: s.replacementCharacters,
      controlCharacters: s.controlCharacters,
      nonAsciiCodePoints: s.counts.nonAsciiCodePoints,
      utf8Bytes: s.counts.utf8Bytes,
    }, obs("decoded text scan (BOM, U+FFFD, C0/C1 controls)", s.replacementCharacters ? "U+FFFD present: undecodable bytes in the source, or a literal replacement character" : `analysed ${scope}`));
    ctx.add(C.technical, "unicodeNormalization", {
      form: s.normalization.form,
      isNFC: s.normalization.forms.NFC.isNormalized,
      isNFD: s.normalization.forms.NFD.isNormalized,
      isNFKC: s.normalization.forms.NFKC.isNormalized,
      isNFKD: s.normalization.forms.NFKD.isNormalized,
    }, obs("String.prototype.normalize comparison", `analysed ${scope}`));

    // ---------------------------------------------------------------- structural
    ctx.add(C.structural, "graphemeCount", s.counts.graphemes, obs("Intl.Segmenter grapheme clusters (UAX #29)", `analysed ${scope}`));
    ctx.add(C.structural, "codePointCount", s.counts.codePoints, obs("code point count", `analysed ${scope}`));
    ctx.add(C.structural, "sentenceCount", s.counts.sentences, obs("Intl.Segmenter sentences (UAX #29)", `analysed ${scope}`));
    if (ctx.kind === "webpage") {
      const $ = await ctx.dom();
      const n = $("body").find(BLOCKS).filter((_, el) => $(el).text().trim().length > 0).length;
      ctx.add(C.structural, "paragraphCount", n, obs("non-empty HTML block elements (p, li, h1–h6, blockquote, pre, td…)"));
    } else if (ctx.kind !== "pdf") {
      ctx.add(C.structural, "paragraphCount", s.counts.paragraphs, obs("blank-line separated paragraphs", `analysed ${scope}`));
    }

    // ---------------------------------------------------------------- descriptive (inferred)
    ctx.add(C.descriptive, "detectedLanguage", s.language, { status: "inferred", method: s.language.method, evidenceType: "inferred", evidence: s.language.reason ?? `score ${s.language.score}; ${s.language.lettersExamined} letters examined` });
    if (s.language.status === "detected") {
      ctx.add(C.descriptive, "language", s.language.tag, { status: "inferred", method: s.language.method, evidenceType: "inferred", evidence: `inferred from text (score ${s.language.score}), not declared by the source` });
    }
    ctx.add(C.descriptive, "scripts", s.scripts, obs("\\p{Script=…} over letters", `analysed ${scope}`));

    // ---------------------------------------------------------------- integrity (security-relevant text signals)
    ctx.add(C.integrity, "invisibleCharacters", { count: s.invisible.count, suspicious: s.invisible.suspicious, byKind: s.invisible.byKind, first: s.invisible.first }, obs("Default_Ignorable_Code_Point / Cf / tag / variation-selector scan", where));
    ctx.add(C.integrity, "bidiControls", { count: s.bidi.count, unterminated: s.bidi.unterminated, byRole: s.bidi.byRole, first: s.bidi.first, unterminatedAt: s.bidi.unterminatedAt }, obs("Bidi_Control scan with per-line embedding/isolate balance (UAX #9)", where));
    ctx.add(C.integrity, "confusableWords", { count: s.confusables.count, first: s.confusables.first }, obs("mixed-script words + curated UTS #39 Latin/Cyrillic/Greek homoglyphs", where));
    if (s.bidi.unterminated || s.invisible.suspicious || s.confusables.count) {
      const reasons = [s.bidi.unterminated ? `${s.bidi.unterminated} unterminated bidi override/embedding/isolate` : "", s.invisible.suspicious ? `${s.invisible.suspicious} invisible character(s) inside text` : "", s.confusables.count ? `${s.confusables.count} mixed-script/homoglyph word(s)` : ""].filter(Boolean);
      ctx.add(C.integrity, "textSpoofingRisk", true, { status: "inferred", method: "text-intel signals", evidence: `${reasons.join("; ")} — a signal of possible spoofing or hidden text, not proof of intent` });
    }

    // ---------------------------------------------------------------- privacy (values withheld)
    ctx.add(C.privacy, "secretsDetected", { count: s.secrets.count, byType: s.secrets.byType, first: s.secrets.first }, { status: "observed", method: "credential patterns (values redacted)", evidence: `type and location only; values are never stored or returned; ${where}`, masked: true });
    if (s.secrets.first.some((f) => f.confidence === "high")) {
      ctx.add(C.privacy, "credentialExposureWarning", true, { status: "inferred", method: "high-confidence credential pattern", evidence: "text appears to expose a credential (e.g. private key, cloud access key, token)" });
    }
  },
};
