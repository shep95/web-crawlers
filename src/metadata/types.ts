/** Resource kinds the pipeline can recognise (by Content-Type and magic bytes). */
export type ResourceKind =
  | "webpage"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "office"
  | "json"
  | "csv"
  | "xml"
  | "feed"
  | "email"
  | "text"
  | "archive"
  | "binary";

/**
 * Evidence status of a value (Phase 5.2). "observed" = measured by this
 * service (hash, status code, timing); "source_declared" = stated by the
 * resource itself and not independently verified.
 */
export type FieldStatus =
  | "observed"
  | "source_declared"
  | "corroborated"
  | "inferred"
  | "contradicted"
  | "extraction_failed";

export type Sensitivity = "public" | "personal" | "restricted";

export interface MetadataField {
  category: number;
  field: string;
  value: unknown;
  status: FieldStatus;
  /** How it was obtained, e.g. "html.meta[name=description]" or "http.header:last-modified". */
  method: string;
  /** Extractor id@version that produced it. */
  extractor: string;
  /** Short supporting excerpt or locator (never the full document). */
  evidence?: string;
  /** Raw value before normalisation (dates, units). */
  original?: string;
  sensitivity?: Sensitivity;
  /** Set when the value was redacted for privacy. */
  masked?: boolean;
  /**
   * What kind of evidence this is: a value read directly from the resource's
   * bytes/embedded properties, a claim the source makes, a measurement this
   * system computed, or an inference that needs qualification.
   */
  evidenceType: EvidenceType;
  /** What the value describes: this resource, its collection, the publishing organisation, or the whole site. */
  scope: Scope;
  observedAt: string;
}

export type EvidenceType = "direct_extraction" | "source_claim" | "system_measurement" | "inferred";
export type Scope = "resource" | "collection" | "organization" | "site";

export type CategoryState =
  | "observed"
  | "not_found_after_inspection"
  | "not_applicable"
  | "unavailable"
  | "extraction_failed";

export interface CategoryCoverage {
  id: number;
  key: string;
  name: string;
  state: CategoryState;
  fieldCount: number;
  note?: string;
}

export type RelationshipType =
  | "canonical"
  | "same_as"
  | "alternate_language"
  | "alternate_format"
  | "published_by"
  | "authored_by"
  | "licensed_under"
  | "cites"
  | "references"
  | "part_of"
  | "has_part"
  | "derived_from"
  | "supersedes"
  | "previous"
  | "next"
  | "feed"
  | "sitemap"
  | "shares_identifier"
  | "archived_as";

export interface Relationship {
  type: RelationshipType;
  target: string;
  evidence: string;
  method: string;
  status: FieldStatus;
}

export interface QualityReport {
  /** 0–1, fraction of core descriptive fields present — formula in `quality.ts`. */
  completeness: number;
  coreFieldsPresent: string[];
  coreFieldsMissing: string[];
  contradictions: Array<{ field: string; values: Array<{ value: unknown; method: string }> }>;
  extractorErrors: Array<{ extractor: string; error: string }>;
  duplicatesCollapsed: number;
  bodyTruncated: boolean;
  declaredVsSniffedType?: { declared: string | null; sniffed: string };
  notes: string[];
}

export interface ResourceRecord {
  resourceId: string;
  requestedUrl: string;
  canonicalUrl: string;
  finalUrl: string;
  sourceType: "url" | "upload";
  kind: ResourceKind;
  mimeType: string | null;
  title: string | null;
  description: string | null;
  fetchedAt: string;
  httpStatus: number | null;
  contentHash: string | null;
  bytes: number;
  fields: MetadataField[];
  categories: CategoryCoverage[];
  relationships: Relationship[];
  quality: QualityReport;
  processing: {
    extractors: Array<{ id: string; ms: number; fields: number; error?: string }>;
    totalMs: number;
    fetchMs: number | null;
    egress: "direct" | "proxy" | "none";
    cache: "miss" | "hit";
    cachedAgeSeconds?: number;
  };
  robots?: { allowed: boolean | null; crawlDelay?: number | null; sitemaps: string[] };
}
