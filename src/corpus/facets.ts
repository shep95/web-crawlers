import { C } from "../metadata/categories.js";
import type { CategoryCoverage, CategoryState, FieldStatus, MetadataField, ResourceRecord } from "../metadata/types.js";
import type { SafeResponse } from "../net/safe-fetch.js";

/** Field statuses counted per category in `resource_coverage`. */
export const FIELD_STATUSES: readonly FieldStatus[] = ["observed", "source_declared", "corroborated", "inferred", "contradicted", "extraction_failed"];
export const CATEGORY_STATES: readonly CategoryState[] = ["observed", "not_found_after_inspection", "not_applicable", "unavailable", "extraction_failed"];

export interface CoverageRow {
  category: number;
  state: CategoryState;
  fields: number;
  byStatus: Record<FieldStatus, number>;
}

/** Per-resource derived columns used by the coverage API (computed once per processing round). */
export interface ResourceFacets {
  language: string | null;
  published_at: string | null;
  categories_observed: number;
  mime: string | null;
  coverage: CoverageRow[];
}

/**
 * A category whose only fields are failure markers was inspected and failed — it is not "observed".
 * (The pipeline marks a category observed when it has any field; a lone `parseError` is not evidence.)
 * For error responses (HTTP ≥ 400) the content was never available, so applicable categories are
 * `unavailable` rather than `extraction_failed`.
 */
export function honestCategories(categories: CategoryCoverage[], fields: MetadataField[], httpStatus: number | null): CategoryCoverage[] {
  return categories.map((c) => {
    const fs = fields.filter((f) => f.category === c.id);
    if (c.state === "observed" && fs.length && fs.every((f) => f.status === "extraction_failed")) return { ...c, state: "extraction_failed", note: c.note ?? "only parse-failure markers; no value extracted" };
    if (c.state === "extraction_failed" && httpStatus !== null && httpStatus >= 400 && /^HTTP/.test(c.note ?? "")) return { ...c, state: "unavailable" };
    return c;
  });
}

const languageOf = (fields: MetadataField[]): string | null => {
  for (const f of fields) {
    if (f.category !== C.descriptive || f.field !== "language" || f.status === "extraction_failed") continue;
    const v = Array.isArray(f.value) ? f.value[0] : f.value;
    if (typeof v !== "string") continue;
    const primary = v.trim().toLowerCase().split(/[-_,;\s]/)[0];
    if (/^[a-z]{2,3}$/.test(primary) && primary !== "und" && primary !== "mul" && primary !== "zxx") return primary;
  }
  return null;
};

/** Newest declared publication date, ignoring values more than a day after retrieval (clock / typo). */
const publishedOf = (fields: MetadataField[], fetchedAt: string): string | null => {
  const limit = Date.parse(fetchedAt) + 86400_000;
  let best: number | null = null;
  for (const f of fields) {
    if (f.category !== C.temporal || f.field !== "published" || typeof f.value !== "string") continue;
    const t = Date.parse(f.value);
    if (Number.isNaN(t) || (Number.isFinite(limit) && t > limit)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
};

export function facetsOf(record: ResourceRecord): ResourceFacets {
  const coverage: CoverageRow[] = record.categories.map((c) => {
    const byStatus = Object.fromEntries(FIELD_STATUSES.map((s) => [s, 0])) as Record<FieldStatus, number>;
    let n = 0;
    for (const f of record.fields) {
      if (f.category !== c.id) continue;
      n++;
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }
    return { category: c.id, state: c.state, fields: n, byStatus };
  });
  return {
    language: languageOf(record.fields),
    published_at: publishedOf(record.fields, record.fetchedAt),
    categories_observed: record.categories.filter((c) => c.state === "observed").length,
    mime: record.mimeType ?? null,
    coverage,
  };
}

/**
 * Validation step (lifecycle `extracted → validated`). It does not reject records — a truthful partial
 * record is still worth indexing — but every problem is recorded as an issue code on the resource
 * (`validation_issues`), in a Data-quality observation, and in the transition detail.
 */
export function validateRecord(record: ResourceRecord, res: Pick<SafeResponse, "truncated" | "status">): string[] {
  const issues: string[] = [];
  if (record.quality.declaredVsSniffedType) issues.push("declared_type_mismatch");
  if (res.truncated || record.quality.bodyTruncated) issues.push("truncated");
  if (record.quality.extractorErrors.length) issues.push("extractor_errors");
  if (record.fields.some((f) => f.status === "extraction_failed")) issues.push("extraction_failed_fields");
  if (record.quality.notes.some((n) => n.startsWith("schema:"))) issues.push("schema_type_errors");
  if (record.quality.contradictions.length) issues.push("contradictions");
  if (record.bytes === 0) issues.push("empty_body");
  const contentFields = record.fields.filter((f) => !/^(http|pipeline|crawler|privacy)@/.test(f.extractor) && f.status !== "extraction_failed");
  if (!contentFields.length) issues.push("no_content_metadata");
  return issues;
}

/** Rebuild facets for rows processed before lifecycle-v1 from their latest stored snapshot. */
export async function facetsFromSnapshots(
  store: { observationsForSnapshots(ids: number[]): Promise<Map<number, MetadataField[]>>; snapshotRecords(ids: number[]): Promise<Map<number, { categories: CategoryCoverage[] }>> },
  rows: Array<{ id: number; sid: number; fetched_at: string; mime: string | null; http_status: number | null }>,
): Promise<Array<{ id: number; facets: ResourceFacets }>> {
  if (!rows.length) return [];
  const sids = rows.map((r) => r.sid);
  const [obs, recs] = await Promise.all([store.observationsForSnapshots(sids), store.snapshotRecords(sids)]);
  return rows.map((r) => {
    const fields = obs.get(r.sid) ?? [];
    const categories = honestCategories(recs.get(r.sid)?.categories ?? [], fields, r.http_status);
    return { id: r.id, facets: facetsOf({ fields, categories, fetchedAt: r.fetched_at, mimeType: r.mime } as unknown as ResourceRecord) };
  });
}
