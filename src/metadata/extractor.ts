import type { CheerioAPI } from "cheerio";
import type { SafeResponse } from "../net/safe-fetch.js";
import type { EvidenceType, FieldStatus, MetadataField, Relationship, RelationshipType, ResourceKind, Scope, Sensitivity } from "./types.js";
import { CATEGORY_BY_ID } from "./categories.js";

/** Everything an extractor may read. Extractors never fetch except via `ctx.fetchAux`. */
export interface ExtractionInput {
  url: string;
  response: Pick<SafeResponse, "status" | "headers" | "body" | "truncated" | "finalUrl" | "requestedUrl" | "redirects" | "remoteAddress" | "timings" | "encodedBytes" | "egress">;
  kind: ResourceKind;
  sniffedType: string;
  sourceType: "url" | "upload";
  filename?: string | null;
  /** Network-enabled helpers (disabled for uploads / when options.network is false). */
  network: boolean;
}

export interface ExtractionContext extends ExtractionInput {
  observedAt: string;
  text(): Promise<string>;
  /** Parsed DOM for HTML/XML kinds (lazy, cached). */
  dom(): Promise<CheerioAPI>;
  jsonLd(): Promise<Record<string, unknown>[]>;
  add(category: number, field: string, value: unknown, opts: AddOptions): void;
  relate(type: RelationshipType, target: string, evidence: string, method: string, status?: FieldStatus): void;
  /** Cross-extractor scratch space (e.g. HTML exposes plain text to the privacy extractor). */
  shared: Map<string, unknown>;
  /** Fields collected so far (enrichment extractors run after local ones). */
  fields(): readonly MetadataField[];
}

export interface AddOptions {
  status?: FieldStatus;
  method: string;
  evidence?: string;
  original?: string;
  sensitivity?: Sensitivity;
  masked?: boolean;
  evidenceType?: EvidenceType;
  scope?: Scope;
}

/** Extractors that read embedded properties straight out of file structures. */
const EMBEDDED = new Set(["image", "media-container", "pdf", "office", "email", "archive"]);

function defaultEvidence(extractor: string, status: FieldStatus): EvidenceType {
  if (status === "inferred") return "inferred";
  if (status === "observed") return "system_measurement";
  return EMBEDDED.has(extractor.split("@")[0]) ? "direct_extraction" : "source_claim";
}

/** Stable plugin contract (Phase 7.5). */
export interface Extractor {
  id: string;
  version: string;
  description: string;
  /** Resource kinds this extractor runs on ("all" = every resource). */
  kinds: ResourceKind[] | "all";
  categories: number[];
  /** Requires outbound network access (DNS, TLS, archive, APIs). */
  needsNetwork?: boolean;
  /** "local" extractors run first in parallel; "enrich" ones run after and may read their fields. */
  phase?: "local" | "enrich";
  /** Soft time budget; the pipeline aborts the extractor result after this. */
  timeoutMs: number;
  run(ctx: ExtractionContext, extractorTag: string): Promise<void>;
}

export class FieldCollector {
  readonly fields: MetadataField[] = [];
  readonly relationships: Relationship[] = [];
  duplicates = 0;
  private seen = new Set<string>();
  private relSeen = new Set<string>();

  constructor(private observedAt: string) {}

  add(extractor: string, category: number, field: string, value: unknown, opts: AddOptions): void {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return;
    if (!CATEGORY_BY_ID.has(category)) throw new Error(`unknown category ${category}`);
    const key = `${category}|${field}|${JSON.stringify(value)}`;
    if (this.seen.has(key)) {
      this.duplicates++;
      return;
    }
    this.seen.add(key);
    this.fields.push({
      category,
      field,
      value,
      status: opts.status ?? "source_declared",
      method: opts.method,
      extractor,
      evidence: opts.evidence ? opts.evidence.slice(0, 240) : undefined,
      original: opts.original,
      sensitivity: opts.sensitivity ?? CATEGORY_BY_ID.get(category)!.sensitivity,
      masked: opts.masked,
      evidenceType: opts.evidenceType ?? defaultEvidence(extractor, opts.status ?? "source_declared"),
      scope: opts.scope ?? "resource",
      observedAt: this.observedAt,
    });
  }

  relate(type: RelationshipType, target: string, evidence: string, method: string, status: FieldStatus = "source_declared"): void {
    const key = `${type}|${target}`;
    if (this.relSeen.has(key) || this.relationships.length > 400) return;
    this.relSeen.add(key);
    this.relationships.push({ type, target, evidence: evidence.slice(0, 200), method, status });
  }
}
