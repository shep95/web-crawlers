import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeText, findOccurrences, graphemeAnalysis, summarizeText, TEXT_LIMITS } from "../src/text/analyze.js";
import { detectLanguage } from "../src/text/language.js";
import { detectSecrets, redactForIndex, redactSecrets } from "../src/text/secrets.js";
import { countGraphemes, countWords, paragraphs, sentences, TextIndex, words } from "../src/text/segment.js";
import { describeCodePoint, UNICODE_RUNTIME } from "../src/text/unicode.js";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import type { ResourceRecord } from "../src/metadata/types.js";
import type { Corpus } from "../src/corpus/types.js";
import { buildApp } from "../src/api.js";
import { loadConfig } from "../src/core/config.js";
import { backends } from "./helpers/backends.js";
import * as F from "./fixtures/build.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // AWS's documented example key id (fake)
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const field = (r: ResourceRecord, cat: number, name: string) => r.fields.find((f) => f.category === cat && f.field === name);

describe("character analysis and offsets", () => {
  it("ASCII: 'h' in hello is byte 0, U+0068, UTF-8 68", async () => {
    const a = await analyzeText("hello");
    expect(a.characters[0]).toMatchObject({ char: "h", index: 0, utf16Offset: 0, utf8Offset: 0, graphemeIndex: 0, line: 1, column: 1, codePoint: "U+0068", utf8: "68", utf16: ["0068"], category: "Ll", categoryName: "Lowercase_Letter", script: "Latin", scriptCode: "Latn" });
    expect(a.counts).toMatchObject({ utf16: 5, codePoints: 5, graphemes: 5, utf8Bytes: 5, words: 1 });
    expect(a.characters[4]).toMatchObject({ char: "o", utf8Offset: 4, column: 5 });
    expect(a.limits).toEqual(TEXT_LIMITS);
    expect(a.limits.identity).toMatch(/cannot reveal who typed it/);
  });

  it("multibyte offsets: é, 日本語 and a ZWJ emoji sequence keep bytes, code points, UTF-16 units and graphemes distinct", async () => {
    const text = "aé日本語👩‍💻!";
    const a = await analyzeText(text);
    const at = (ch: string) => a.characters.find((c) => c.char === ch)!;
    expect(at("é")).toMatchObject({ codePoint: "U+00E9", utf8: "C3 A9", utf16Offset: 1, utf8Offset: 1, index: 1 });
    expect(at("日")).toMatchObject({ codePoint: "U+65E5", utf8: "E6 97 A5", utf16Offset: 2, utf8Offset: 3, index: 2, script: "Han" });
    expect(at("語")).toMatchObject({ utf16Offset: 4, utf8Offset: 9 });
    const woman = at("👩");
    expect(woman).toMatchObject({ codePoint: "U+1F469", utf8: "F0 9F 91 A9", utf16: ["D83D", "DC69"], utf16Offset: 5, utf8Offset: 12, index: 5, graphemeIndex: 5 });
    expect(at("‍")).toMatchObject({ codePoint: "U+200D", name: "ZERO WIDTH JOINER", graphemeIndex: 5, joinControl: true });
    expect(at("💻").graphemeIndex).toBe(5); // same grapheme cluster as 👩
    const g = a.graphemes[5];
    expect(g).toMatchObject({ text: "👩‍💻", codePoints: 3, utf16Units: 5, utf8Bytes: 11, emojiSequence: true, zwjSequence: true, codePointList: ["U+1F469", "U+200D", "U+1F4BB"] });
    expect(at("!")).toMatchObject({ utf16Offset: 10, utf8Offset: 23, index: 8, graphemeIndex: 6 });
    expect(a.counts).toMatchObject({ utf16: 11, codePoints: 9, graphemes: 7, utf8Bytes: 24, emojiSequences: 1, zwjSequences: 1 });
    // The ZWJ inside the emoji is doing its job: counted, not flagged as suspicious.
    expect(a.invisible).toMatchObject({ count: 1, suspicious: 0 });
  });

  it("combining marks: e + U+0301 vs precomposed é (NFC/NFD)", async () => {
    const decomposed = "é";
    const composed = "é";
    expect(decomposed.normalize("NFC")).toBe(composed);
    expect(countGraphemes(decomposed)).toBe(1);
    const d = await analyzeText(decomposed);
    expect(d.counts).toMatchObject({ codePoints: 2, graphemes: 1, combiningMarks: 1 });
    expect(d.characters[1]).toMatchObject({ codePoint: "U+0301", category: "Mn", combiningMark: true, script: "Inherited", graphemeIndex: 0 });
    expect(d.normalization.form).toBe("NFD");
    expect(d.normalization.forms.NFC).toMatchObject({ isNormalized: false, codePoints: 1 });
    const c = await analyzeText(composed);
    expect(c.normalization.form).toBe("NFC");
    expect(c.characters[0].normalization).toEqual({ NFD: "U+0065 U+0301", NFKD: "U+0065 U+0301" });
    expect((await summarizeText(`${composed} ${decomposed}`)).normalization.form).toMatch(/^none/);
    // Exact search does not conflate them; a bare "e" inside the cluster is reported as not grapheme-aligned.
    const occ = findOccurrences(`café café`, "e");
    expect(occ.total).toBe(1);
    expect(occ.occurrences[0]).toMatchObject({ utf16Offset: 8, graphemeAligned: false });
  });

  it("case, digits and numeric values", () => {
    expect(describeCodePoint(0x0661)).toMatchObject({ category: "Nd", numericValue: 1, script: "Arabic" }); // ARABIC-INDIC DIGIT ONE
    expect(describeCodePoint(0x0967)).toMatchObject({ category: "Nd", numericValue: 1, script: "Devanagari" });
    expect(describeCodePoint(0x0037).numericValue).toBe(7);
    expect(describeCodePoint(0x00bd).numericValue).toBeUndefined(); // ½ is No: value not derivable without the UCD — omitted, not guessed
    expect(describeCodePoint(0x00df).case).toMatchObject({ lower: true, toUpper: "SS", caseFolded: "ss" });
    expect(describeCodePoint(0x0041).name).toBeUndefined(); // names only for the curated special characters
  });

  it("RTL text: Arabic/Hebrew scripts and bidi controls are flagged; an unterminated override is reported", async () => {
    const ok = await summarizeText("Shalom: ⁧שלום עולם⁩ and مرحبا‏ بالعالم.");
    expect(ok.scripts.map((s) => s.script)).toEqual(expect.arrayContaining(["Hebrew", "Arabic", "Latin"]));
    expect(ok.rtlLetters).toBeGreaterThan(10);
    expect(ok.bidi).toMatchObject({ count: 3, unterminated: 0, byRole: { isolate: 1, pop: 1, mark: 1 } });
    expect(ok.bidi.first[0]).toMatchObject({ codePoint: "U+2067", name: "RIGHT-TO-LEFT ISOLATE", utf16Offset: 8 });
    const trojan = await summarizeText("access = \"user‮ ⁦// admin⁩ ⁦\"\nnext line");
    expect(trojan.bidi.unterminated).toBe(2); // the RLO and the second LRI never close on their line
    expect(trojan.bidi.unterminatedAt[0]).toMatchObject({ line: 1, utf16Offset: 14 });
  });

  it("Devanagari conjunct क्ष is one grapheme cluster of three code points", async () => {
    const a = await analyzeText("क्ष");
    expect(a.counts.codePoints).toBe(3);
    expect(a.characters.map((c) => c.codePoint)).toEqual(["U+0915", "U+094D", "U+0937"]);
    // Unicode 15.1 added Indic conjunct rules to grapheme clusters (GB9c); older runtimes split after the virama.
    const expected = Number.parseFloat(UNICODE_RUNTIME.unicode ?? "0") >= 15.1 ? 1 : 2;
    expect(a.counts.graphemes).toBe(expected);
    expect(countGraphemes("क्षत्रिय")).toBe(expected === 1 ? 3 : 5);
  });

  it("word segmentation without spaces: Thai, Chinese, Japanese", () => {
    const thai = words("สวัสดีครับวันนี้อากาศดี", "th", { wordLikeOnly: true }).map((w) => w.text);
    expect(thai.length).toBeGreaterThanOrEqual(4);
    expect(thai.join("")).toBe("สวัสดีครับวันนี้อากาศดี");
    expect(thai).toContain("สวัสดี");
    const zh = words("我们今天去北京大学", "zh", { wordLikeOnly: true }).map((w) => w.text);
    expect(zh.length).toBeGreaterThanOrEqual(3);
    expect(zh).toContain("我们");
    const ja = words("日本語のテキストを分割します", "ja", { wordLikeOnly: true }).map((w) => w.text);
    expect(ja).toContain("日本語");
    expect(ja.length).toBeGreaterThanOrEqual(4);
    expect(countWords("我们今天去北京大学")).toBe(zh.length);
    expect(sentences("一つ目。二つ目。", "ja")).toHaveLength(2);
    expect(paragraphs("First para.\n\n\nSecond\npara.\n \nThird.").map((p) => p.text)).toEqual(["First para.", "Second\npara.", "Third."]);
  });

  it("finds a hidden ZWSP inside hel​lo with its position; ZWSP between Thai words is not suspicious", async () => {
    const s = await summarizeText("say hel​lo\nworld");
    expect(s.invisible).toMatchObject({ count: 1, suspicious: 1, byKind: { invisible: 1 } });
    expect(s.invisible.first[0]).toMatchObject({ codePoint: "U+200B", name: "ZERO WIDTH SPACE", suspicious: true, utf16Offset: 7, codePointOffset: 7, utf8Offset: 7, graphemeOffset: 7, line: 1, column: 8 });
    const occ = findOccurrences("say hel​lo\nworld", "​");
    expect(occ.occurrences[0]).toMatchObject({ line: 1, column: 8, utf8Offset: 7, context: { before: "say hel", after: "lo\nworld" } });
    const thai = await summarizeText("สวัสดี​ครับ");
    expect(thai.invisible).toMatchObject({ count: 1, suspicious: 0 });
  });

  it("flags Cyrillic 'а' in pаypal as a mixed-script confusable, and whole-word lookalikes in Latin text", async () => {
    const s = await summarizeText("Please log in to your pаypal account to continue with the payment.");
    expect(s.confusables.count).toBe(1);
    expect(s.confusables.first[0]).toMatchObject({ word: "pаypal", kind: "mixed-script", looksLike: "paypal", scripts: ["Latin", "Cyrillic"], utf16Offset: 22 });
    expect(s.confusables.first[0].characters).toEqual([{ char: "а", codePoint: "U+0430", script: "Cyrillic", looksLike: "a", utf16Offset: 23 }]);
    const whole = await summarizeText("Please sign in at раура today and confirm your details there.");
    expect(whole.confusables.first[0]).toMatchObject({ word: "раура", kind: "whole-script-confusable", looksLike: "paypa" });
    // Genuine Russian text and Japanese mixed Han/Kana words are not flagged.
    expect((await summarizeText("Привет, как дела у тебя сегодня? Всё хорошо.")).confusables.count).toBe(0);
    expect((await summarizeText("食べる 東京タワー カタカナ")).confusables.count).toBe(0);
  });

  it("language detection returns BCP 47 tags with status; short text is und", async () => {
    expect(await detectLanguage("The committee published its annual report on regional rainfall and river levels yesterday.")).toMatchObject({ tag: "en", status: "detected", script: "Latn" });
    expect(await detectLanguage("hello")).toMatchObject({ tag: "und", status: "undetermined" });
    expect((await detectLanguage("日本語のテキストを分割します。今日は良い天気です。")).tag).toBe("ja");
    expect((await detectLanguage("Bonjour")).status).not.toBe("detected");
  });
});

describe("secrets", () => {
  const text = `config:\naws_access_key_id = ${AWS_KEY}\nAuthorization: Bearer ${JWT}\npassword=Sup3rS3cret!\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE KEY-----\n`;
  it("reports type and location, never the value", () => {
    const found = detectSecrets(text);
    expect(found.map((f) => f.type)).toEqual(["aws-access-key-id", "jwt", "credential-assignment", "private-key-block"]);
    const aws = found[0];
    expect(text.slice(aws.start, aws.end)).toBe(AWS_KEY);
    expect(aws).toMatchObject({ confidence: "high", length: 20, redacted: "[REDACTED:aws-access-key-id]" });
    expect(JSON.stringify(found)).not.toContain(AWS_KEY);
    expect(JSON.stringify(found)).not.toContain("Sup3rS3cret");
    const red = redactSecrets(text).text;
    for (const v of [AWS_KEY, JWT, "Sup3rS3cret!", "MIIEowIBAAKCAQEA"]) expect(red).not.toContain(v);
    expect(redactForIndex(`${"x".repeat(95)} ${AWS_KEY}`, 100)).not.toContain("AKIAIOSF"); // a secret cut by the cap is still removed
  });
  it("analysis output withholds secret characters", async () => {
    const a = await analyzeText(`id ${AWS_KEY} ok`);
    const json = JSON.stringify(a);
    expect(json).not.toContain(AWS_KEY);
    expect(json).not.toContain("IOSFODNN");
    expect(a.secrets.first[0]).toMatchObject({ type: "aws-access-key-id", utf16Offset: 3, utf8Offset: 3, line: 1, column: 4, length: 20 });
    expect(a.characters[3]).toEqual({ index: 3, utf16Offset: 3, utf8Offset: 3, graphemeIndex: 3, line: 1, column: 4, redacted: "aws-access-key-id" });
    expect(a.words.find((w) => w.text.includes("REDACTED"))).toBeTruthy();
  });
});

describe("performance", () => {
  it("summarises very long text within a bounded time (analysis capped at 200,000 UTF-16 units)", async () => {
    const chunk = "Rainfall records from 1901 to 2020 — café, naïve, 北京大学, สวัสดี, مرحبا, 👩‍💻. ";
    const long = chunk.repeat(Math.ceil(1_200_000 / chunk.length));
    const t0 = Date.now();
    const s = await summarizeText(long);
    const ms = Date.now() - t0;
    expect(s.truncated).toBe(true);
    expect(s.analysedUtf16).toBeLessThanOrEqual(200_000);
    expect(s.totalUtf16).toBe(long.length);
    expect(ms).toBeLessThan(8000);
    const t1 = Date.now();
    const occ = findOccurrences(long.slice(0, 100_000), "北京", { limit: 500 });
    expect(occ.occurrences).toHaveLength(500);
    expect(occ.truncated).toBe(true);
    expect(Date.now() - t1).toBeLessThan(3000);
    const idx = new TextIndex(long.slice(0, 100_000));
    expect(idx.position(0)).toMatchObject({ utf8Offset: 0, line: 1 });
  });
});

describe("pipeline integration (summaries stored, values redacted)", () => {
  it("records text-intelligence observations in the existing categories", async () => {
    const body = `Annual rainfall report\n\nThe district office published rainfall and river level records for the monsoon season. Please log in to your pаypal account.\nSay hel​lo to the team.\n\nDeploy key: ${AWS_KEY}\n`;
    const r = await analyzeResponse(F.response(body, { "content-type": "text/plain; charset=utf-8" }, "https://fixture.test/report.txt"), { sourceType: "url", enrich: false });
    expect(r.kind).toBe("text");
    expect(JSON.stringify(r)).not.toContain(AWS_KEY);
    expect(field(r, 41, "invisibleCharacters")?.value).toMatchObject({ count: 1, suspicious: 1 });
    expect((field(r, 41, "invisibleCharacters")?.value as { first: Array<{ line: number; codePoint: string }> }).first[0]).toMatchObject({ line: 4, codePoint: "U+200B" });
    expect(field(r, 41, "confusableWords")?.value).toMatchObject({ count: 1 });
    expect(field(r, 41, "bidiControls")?.value).toMatchObject({ count: 0 });
    expect(field(r, 41, "textSpoofingRisk")).toMatchObject({ value: true, status: "inferred" });
    const secrets = field(r, 39, "secretsDetected")!;
    expect(secrets).toMatchObject({ masked: true, value: { count: 1, byType: { "aws-access-key-id": 1 } } });
    expect(field(r, 39, "credentialExposureWarning")?.value).toBe(true);
    expect(field(r, 4, "unicodeNormalization")?.value).toMatchObject({ form: "NFC", isNFC: true });
    expect(field(r, 4, "textEncoding")?.value).toMatchObject({ byteOrderMark: null, replacementCharacters: 0 });
    expect(field(r, 2, "paragraphCount")?.value).toBe(3);
    expect(field(r, 2, "graphemeCount")?.value).toBeGreaterThan(100);
    expect(field(r, 1, "language")).toMatchObject({ value: "en", status: "inferred", evidenceType: "inferred" });
    expect(field(r, 1, "scripts")?.value).toEqual(expect.arrayContaining([expect.objectContaining({ script: "Latin" })]));
    expect(r.quality.extractorErrors).toEqual([]);
  });
  it("an inferred language never marks the declared one contradicted; a disagreement becomes a quality note", async () => {
    const html = `<!doctype html><html lang="de"><head><title>Report</title></head><body><main><p>The district office published rainfall and river level records for the monsoon season, together with notes on the measurement method.</p></main></body></html>`;
    const r = await analyzeResponse(F.response(html, { "content-type": "text/html" }), { sourceType: "url", enrich: false });
    const langs = r.fields.filter((f) => f.category === 1 && f.field === "language");
    expect(langs.some((f) => f.status === "inferred" && f.value === "en")).toBe(true);
    expect(langs.every((f) => f.status !== "contradicted")).toBe(true);
    expect(r.quality.contradictions.map((c) => c.field)).not.toContain("descriptive.language");
    expect(r.quality.notes.join(" ")).toMatch(/declared language de but the text reads as en/);
    expect(field(r, 2, "paragraphCount")?.value).toBe(1);
  });
  it("detects a byte order mark and characters for one grapheme", () => {
    expect(graphemeAnalysis("👩‍💻")?.codePoints.map((c) => c.codePoint)).toEqual(["U+1F469", "U+200D", "U+1F4BB"]);
    expect(graphemeAnalysis("ab")).toBeNull();
  });
});

// ------------------------------------------------------------------ HTTP API over a corpus populated in-test
for (const makeBackend of backends()) {
  const backend = makeBackend();
  describe(`text API [${backend.name}]`, () => {
    let store: Corpus;
    let app: Awaited<ReturnType<typeof buildApp>>;
    const ids: Record<string, number> = {};
    const DOC = `Line one says hello.\nThe café serves 日本語 tea 👩‍💻 daily.\nLogin at pаypal.com now.\nDeploy key ${AWS_KEY} end`;
    const DOC2 = "Second notice: say hel​lo to the archive team before the café closes.";

    async function seed(url: string, body: string) {
      await store.enqueue([{ url, priority: 1, depth: 0, via: "test", purpose: "discovery" }]);
      const row = (await store.byUrl(url))!;
      const record = await analyzeResponse(F.response(body, { "content-type": "text/plain; charset=utf-8" }, url), { sourceType: "url", enrich: false });
      await store.saveSnapshot(row.id, record, { text: body, index: true });
      await store.finish(row.id, "indexed", Date.now() + 86400_000, { indexed_at: new Date().toISOString(), title: record.title, content_hash: record.contentHash });
      return row.id;
    }

    beforeAll(async () => {
      store = await backend.open();
      ids.doc = await seed("https://texts.example.org/notice-1.txt", DOC);
      ids.doc2 = await seed("https://texts.example.org/notice-2.txt", DOC2);
      app = await buildApp(loadConfig(), { logger: false, legacy: false, corpus: store, crawler: false });
    }, 60_000);
    afterAll(async () => {
      await app?.close();
      await store?.close();
      await backend.dispose();
    });
    const get = async (url: string) => {
      const res = await app.inject(url);
      return { status: res.statusCode, body: res.json(), raw: res.body };
    };

    it("finds exact occurrences in one resource with line, column, byte, code-point and grapheme offsets", async () => {
      const { status, body } = await get(`/api/v2/text/occurrences?q=hello&resource=${ids.doc}`);
      expect(status).toBe(200);
      expect(body.scope).toMatchObject({ strategy: "resource", resource: ids.doc });
      expect(body.total).toBe(1);
      expect(body.occurrences[0]).toMatchObject({ resourceId: ids.doc, url: "https://texts.example.org/notice-1.txt", field: "body", line: 1, column: 15, utf8Offset: 14, codePointOffset: 14, utf16Offset: 14, graphemeOffset: 14, graphemeAligned: true, context: { before: "Line one says ", match: "hello", after: expect.stringMatching(/^\.\nThe café/) } });
      expect(body.offsetBasis.relativeTo).toBe("stored text excerpt");
      expect(body.offsetBasis.description).toMatch(/not offsets into the original file bytes/);
      expect(body.offsetBasis.excerpts[0]).toMatchObject({ resourceId: ids.doc, capped: false });
      expect(body.limits.identity).toMatch(/never collects/);
    });

    it("multibyte occurrences: 日本語 after é, and a ZWJ emoji as one grapheme with its character analysis", async () => {
      const ja = (await get(`/api/v2/text/occurrences?q=${encodeURIComponent("日本語")}&resource=${ids.doc}`)).body;
      // "Line one says hello.\n" (21) + "The café serves " (16 code points, 17 bytes)
      expect(ja.occurrences[0]).toMatchObject({ line: 2, column: 17, codePointOffset: 37, utf16Offset: 37, utf8Offset: 38, length: { utf16: 3, codePoints: 3, graphemes: 3, utf8Bytes: 9 } });
      const emoji = (await get(`/api/v2/text/occurrences?q=${encodeURIComponent("👩‍💻")}&resource=${ids.doc}`)).body;
      expect(emoji.total).toBe(1);
      expect(emoji.occurrences[0]).toMatchObject({ line: 2, column: 25, length: { utf16: 5, codePoints: 3, graphemes: 1, utf8Bytes: 11 }, graphemeAligned: true });
      expect(emoji.occurrences[0].graphemeColumn).toBe(25);
      expect(emoji.query.grapheme.codePoints.map((c: { codePoint: string }) => c.codePoint)).toEqual(["U+1F469", "U+200D", "U+1F4BB"]);
      const e = (await get(`/api/v2/text/occurrences?q=${encodeURIComponent("é")}&resource=${ids.doc}`)).body;
      expect(e.query.grapheme.codePoints[0]).toMatchObject({ codePoint: "U+00E9", utf8: "C3 A9", category: "Ll", script: "Latin" });
      expect(e.occurrences[0]).toMatchObject({ line: 2, column: 8, utf8Offset: 28 });
    });

    it("searches across the index via full-text candidates", async () => {
      const { body } = await get(`/api/v2/text/occurrences?q=${encodeURIComponent("café")}`);
      expect(body.scope.strategy).toBe("full-text-candidates");
      expect(new Set(body.occurrences.map((o: { resourceId: number }) => o.resourceId))).toEqual(new Set([ids.doc, ids.doc2]));
      expect(body.total).toBe(2);
    });

    it("an invisible-only query falls back to a bounded scan and finds the hidden ZWSP", async () => {
      const { body } = await get(`/api/v2/text/occurrences?q=${encodeURIComponent("​")}`);
      expect(body.scope.strategy).toBe("recent-scan");
      expect(body.scope.note).toMatch(/not the whole index/);
      expect(body.query.invisibleCharacters).toEqual(["U+200B"]);
      expect(body.occurrences).toHaveLength(1);
      expect(body.occurrences[0]).toMatchObject({ resourceId: ids.doc2, line: 1, column: 23, utf8Offset: 22, context: { before: "Second notice: say hel", after: expect.stringMatching(/^lo to the archive/) } });
    });

    it("secrets are redacted in stored text, in observations and in every response", async () => {
      const stored = (await store.documentTexts([ids.doc])).get(ids.doc)!;
      expect(stored.body).not.toContain(AWS_KEY);
      expect(stored.body).toContain("[REDACTED:aws-access-key-id]");
      expect((await get(`/api/v2/text/occurrences?q=${AWS_KEY}&resource=${ids.doc}`)).body.total).toBe(0);
      const ctx = await get(`/api/v2/text/occurrences?q=Deploy&resource=${ids.doc}`);
      expect(ctx.body.occurrences[0].context.after).toContain("[REDACTED:aws-access-key-id]");
      expect(ctx.raw).not.toContain(AWS_KEY);
      const detail = await get(`/api/v2/resources/${ids.doc}`);
      expect(detail.status).toBe(200);
      expect(detail.raw).not.toContain(AWS_KEY);
      expect(detail.raw).toContain("secretsDetected");
    });

    it("validates occurrence requests", async () => {
      expect((await get("/api/v2/text/occurrences")).status).toBe(400);
      expect((await get(`/api/v2/text/occurrences?q=${"x".repeat(201)}`)).status).toBe(400);
      expect((await get("/api/v2/text/occurrences?q=hello&resource=999999")).status).toBe(404);
    });

    it("analyzes arbitrary text and rejects text over 2,000 code points", async () => {
      const ok = await get(`/api/v2/text/analyze?text=${encodeURIComponent("hel​lo pаypal 👩‍💻")}`);
      expect(ok.status).toBe(200);
      expect(ok.body.characters[0]).toMatchObject({ codePoint: "U+0068", utf8: "68", utf8Offset: 0 });
      expect(ok.body.invisible.first[0]).toMatchObject({ codePoint: "U+200B", utf16Offset: 3 });
      expect(ok.body.confusables.count).toBe(1);
      expect(ok.body.words.filter((w: { isWordLike: boolean }) => w.isWordLike).length).toBeGreaterThanOrEqual(2);
      expect(ok.body.offsetBasis.relativeTo).toBe("submitted text");
      expect(ok.body.limits.units).toMatch(/not a keystroke|None of them is a keystroke/);
      const twoThousandEmoji = "😀".repeat(2000); // 2,000 code points = 4,000 UTF-16 units: allowed
      const post = await app.inject({ method: "POST", url: "/api/v2/text/analyze", payload: { text: twoThousandEmoji } });
      expect(post.statusCode).toBe(200);
      const tooLong = await get(`/api/v2/text/analyze?text=${"a".repeat(2001)}`);
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toBe("TEXT_TOO_LONG");
      expect((await app.inject({ method: "POST", url: "/api/v2/text/analyze", payload: { text: "😀".repeat(2001) } })).statusCode).toBe(400);
      expect((await get("/api/v2/text/analyze")).status).toBe(400);
      const spec = (await get("/api/v2/openapi.json")).body;
      expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/v2/text/occurrences", "/api/v2/text/analyze"]));
    });
  });
}
