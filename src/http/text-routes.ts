import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { TEXT_EXCERPT, type Corpus, type StoredText } from "../corpus/types.js";
import { analyzeText, findOccurrences, graphemeAnalysis, TEXT_LIMITS } from "../text/analyze.js";
import { redactSecrets } from "../text/secrets.js";
import { countCodePoints, countGraphemes, segmenter, utf8Length } from "../text/segment.js";
import { hex, invisibleKind } from "../text/unicode.js";

/** Maximum text accepted by /api/v2/text/analyze, in code points. */
export const ANALYZE_MAX_CODE_POINTS = 2_000;

const OccurrencesQ = z.object({
  // Not trimmed: spaces and invisible characters are legitimate search targets.
  q: z.string().min(1).max(200),
  resource: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  candidates: z.coerce.number().int().min(1).max(200).optional(),
});

const AnalyzeQ = z.object({
  text: z.string().min(1).max(ANALYZE_MAX_CODE_POINTS * 2),
  lang: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/).optional(),
});

const FIELDS = ["title", "description", "body"] as const;

const OFFSET_BASIS = {
  relativeTo: "stored text excerpt",
  description:
    `Offsets are relative to the text this index stores for each resource — title, description and a body excerpt of at most ${TEXT_EXCERPT.toLocaleString("en")} UTF-16 code units (web pages: main content with markup removed and whitespace collapsed; PDFs: text layer, whitespace collapsed; text formats: decoded body) with secrets replaced by [REDACTED:<type>] markers. They are not offsets into the original file bytes: the original encoding offsets are not retained.`,
  utf8Offset: "byte offset of the stored excerpt re-encoded as UTF-8",
};

function issues(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({ error: "INVALID_REQUEST", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}

/** Words of the query usable as full-text terms (Intl.Segmenter, so unspaced scripts still yield terms). */
function ftsTerms(q: string): string[] {
  const out: string[] = [];
  for (const w of segmenter("word").segment(q)) if (w.isWordLike && w.segment.length >= 1) out.push(w.segment.toLowerCase());
  return [...new Set(out)].slice(0, 8);
}

function queryInfo(q: string) {
  const invisible = [...q].map((c) => c.codePointAt(0)!).filter((cp) => invisibleKind(cp) !== null).map(hex);
  return {
    q,
    length: { utf16: q.length, codePoints: countCodePoints(q), graphemes: countGraphemes(q), utf8Bytes: utf8Length(q) },
    codePoints: [...q].slice(0, 64).map((c) => hex(c.codePointAt(0)!)),
    normalization: { isNFC: q === q.normalize("NFC"), isNFD: q === q.normalize("NFD") },
    ...(invisible.length ? { invisibleCharacters: invisible } : {}),
    /** Character analysis when q is exactly one grapheme cluster. */
    grapheme: graphemeAnalysis(q),
    matching: "exact: identical UTF-16 code units, case-sensitive, non-overlapping; canonically equivalent forms (e.g. U+00E9 vs U+0065 U+0301) do not match each other",
  };
}

export function registerTextRoutes(app: FastifyInstance, deps: { store: Corpus }) {
  const { store } = deps;

  /**
   * Exact occurrences of a string in one resource's stored text, or across the
   * index (full-text search picks candidate resources whose stored text is then scanned).
   */
  app.get("/api/v2/text/occurrences", async (req, reply) => {
    const r = OccurrencesQ.safeParse(req.query);
    if (!r.success) return issues(reply, r.error);
    const { q, resource } = r.data;
    const limit = r.data.limit ?? 50;
    const t0 = Date.now();
    let ids: number[];
    let strategy: "resource" | "full-text-candidates" | "recent-scan";
    if (resource) {
      ids = [resource];
      strategy = "resource";
    } else {
      const want = r.data.candidates ?? 50;
      const terms = ftsTerms(q);
      const hits = terms.length ? await store.searchResources({ terms, limit: want, offset: 0 }).catch(() => ({ rows: [] })) : { rows: [] };
      ids = hits.rows.map((x) => x.id);
      strategy = "full-text-candidates";
      if (!ids.length) {
        // No usable terms (a lone symbol, mark or invisible character) or no FTS hit: scan the most recently indexed resources.
        ids = await store.recentIndexedIds(want);
        strategy = "recent-scan";
      }
    }
    const texts = await store.documentTexts(ids);
    if (resource && !texts.has(resource)) {
      const row = await store.get(resource);
      return reply.code(404).send({ error: "NOT_FOUND", message: row ? `Resource ${resource} has no stored text (state ${row.state}${row.duplicate_of ? `, duplicate of ${row.duplicate_of}` : ""}).` : "Not in the collected corpus." });
    }
    const occurrences: Array<Record<string, unknown>> = [];
    const excerpts: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const id of ids) {
      const doc = texts.get(id);
      if (!doc) continue;
      let any = false;
      let body = "";
      for (const field of FIELDS) {
        // Defence in depth: excerpts stored before redaction existed are redacted on read.
        const text = redactSecrets((doc as StoredText)[field]).text;
        if (field === "body") body = text;
        if (!text) continue;
        const found = findOccurrences(text, q, { limit: Math.max(0, limit - occurrences.length), context: 60 });
        total += found.total;
        if (found.total) any = true;
        for (const o of found.occurrences) occurrences.push({ resourceId: id, url: doc.url, title: doc.title || null, field, ...o });
      }
      if (any || resource) excerpts.push({ resourceId: id, field: "body", utf16Length: body.length, codePoints: countCodePoints(body), utf8Bytes: utf8Length(body), capped: body.length >= TEXT_EXCERPT });
    }
    reply.header("cache-control", "public, max-age=30");
    return {
      query: queryInfo(q),
      scope: {
        strategy,
        resource: resource ?? null,
        candidatesScanned: texts.size,
        note:
          strategy === "resource"
            ? "one resource's stored text"
            : strategy === "full-text-candidates"
              ? "resources chosen by full-text search on the query's words, then scanned for the exact string; resources the full-text index does not rank are not scanned (Postgres ranks only the first 20,000 characters of each body)"
              : "the query has no searchable words (or full-text search found none): only the most recently indexed resources were scanned — not the whole index",
      },
      total,
      returned: occurrences.length,
      truncated: total > occurrences.length,
      occurrences,
      offsetBasis: { ...OFFSET_BASIS, excerpts },
      limits: TEXT_LIMITS,
      tookMs: Date.now() - t0,
    };
  });

  const analyze = async (input: unknown, reply: FastifyReply) => {
    const r = AnalyzeQ.safeParse(input);
    if (!r.success) {
      const tooLong = r.error.issues.some((i) => i.code === "too_big");
      if (tooLong) return reply.code(400).send({ error: "TEXT_TOO_LONG", message: `text must be at most ${ANALYZE_MAX_CODE_POINTS} code points`, limit: ANALYZE_MAX_CODE_POINTS });
      return issues(reply, r.error);
    }
    const n = countCodePoints(r.data.text);
    if (n > ANALYZE_MAX_CODE_POINTS) return reply.code(400).send({ error: "TEXT_TOO_LONG", message: `text must be at most ${ANALYZE_MAX_CODE_POINTS} code points (got ${n})`, limit: ANALYZE_MAX_CODE_POINTS, codePoints: n });
    const t0 = Date.now();
    const result = await analyzeText(r.data.text, { lang: r.data.lang, maxCharacters: ANALYZE_MAX_CODE_POINTS });
    // Submitted text may be private: never cache it in shared caches.
    reply.header("cache-control", "private, no-store");
    return {
      ...result,
      offsetBasis: { relativeTo: "submitted text", description: "Offsets are relative to the text as received (after URL/JSON decoding); byte offsets are of that text encoded as UTF-8. Characters inside detected secrets are reported as redacted, without their values." },
      tookMs: Date.now() - t0,
    };
  };
  app.get("/api/v2/text/analyze", async (req, reply) => analyze(req.query, reply));
  app.post("/api/v2/text/analyze", { bodyLimit: 64 * 1024 }, async (req, reply) => analyze(req.body, reply));
}
