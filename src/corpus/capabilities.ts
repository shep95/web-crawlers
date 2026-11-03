import { CATEGORIES } from "../metadata/categories.js";
import { EXTRACTORS } from "../metadata/extractors/index.js";
import type { ResourceKind } from "../metadata/types.js";

/**
 * Capability matrix (GET /api/v2/capabilities): for each of the 41 categories, which formats can fill it and
 * how far that claim is established.
 *
 *   configured    the category registry says the category applies to the format (appliesTo)
 *   implemented   a registered extractor declares both the format and the category
 *   tested        an offline fixture of that format yields an observed (non-failure) field in the category —
 *                 OFFLINE_VERIFIED below, itself checked against the fixtures by tests/capabilities.test.ts
 *   liveVerified  number of corpus resources of that format with the category observed (0 = measured zero)
 *   blocked       reasons an implemented extractor cannot run in this deployment (network enrichment off …)
 *   unknown       nothing configured or implemented: the matrix makes no claim
 */

export const KINDS: ResourceKind[] = ["webpage", "pdf", "office", "image", "audio", "video", "json", "csv", "xml", "feed", "email", "text", "archive", "binary"];

/** Generated from tests/fixtures/corpus.ts (18 fixtures) — kind → categories observed with a real value. */
export const OFFLINE_VERIFIED: Partial<Record<ResourceKind, number[]>> = {
  webpage: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 34, 35, 36, 38, 39, 40, 41],
  json: [1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 16, 17, 18, 20, 22, 28, 34, 37, 39, 41],
  csv: [1, 2, 4, 5, 7, 8, 11, 12, 13, 14, 16, 17, 19, 20, 22, 28, 34, 39, 41],
  feed: [1, 2, 4, 5, 6, 7, 8, 10, 11, 12, 20, 22, 25, 28, 34, 39, 41],
  xml: [1, 2, 4, 5, 6, 7, 8, 11, 12, 13, 14, 16, 17, 20, 22, 25, 28, 34, 39, 41],
  text: [1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 14, 20, 22, 24, 28, 34, 36, 37, 39, 40, 41],
  email: [1, 2, 4, 5, 7, 8, 11, 12, 20, 22, 28, 33, 34, 39, 41],
  image: [4, 5, 6, 7, 8, 11, 12, 20, 22, 28, 29, 34, 35, 41],
  audio: [4, 5, 7, 8, 11, 12, 20, 22, 28, 30, 34, 41],
  video: [2, 4, 5, 7, 8, 11, 12, 20, 22, 28, 31, 34, 38, 41],
  pdf: [1, 2, 4, 5, 7, 8, 11, 12, 20, 22, 28, 32, 34, 38, 39, 41],
  office: [1, 2, 3, 4, 5, 7, 8, 11, 12, 20, 21, 22, 28, 32, 34, 41],
};

/** Shape the formats registry (src/metadata/formats.ts) exports, when present. */
export interface FormatEntry {
  id: string;
  mimes: string[];
  signatures?: unknown[];
  extensions?: string[];
  parser?: unknown;
  status: "implemented" | "partial" | "signature_only" | "unsupported";
  categories: number[];
  tested: boolean;
}

/**
 * Integration point: loads src/metadata/formats.ts when it exists (any export that is an array of
 * FormatEntry-like objects: FORMATS, formats, FORMAT_REGISTRY or default). Returns null otherwise.
 */
export async function loadFormatRegistry(): Promise<FormatEntry[] | null> {
  for (const spec of [new URL("../metadata/formats.js", import.meta.url).href, new URL("../metadata/formats.ts", import.meta.url).href]) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      for (const key of ["FORMATS", "formats", "FORMAT_REGISTRY", "default"]) {
        const v = mod[key];
        if (Array.isArray(v) && v.every((e) => e && typeof e === "object" && "id" in e && "categories" in e)) return v as FormatEntry[];
      }
    } catch {
      /* not present (yet) */
    }
  }
  return null;
}

export type CapabilityStatus = "live_verified" | "tested" | "implemented" | "configured" | "blocked" | "unknown";

export function buildCapabilities(opts: {
  live: Array<{ kind: string; category: number; resources: number }> | null;
  enrich: boolean;
  egress: "direct" | "proxy";
  formats: FormatEntry[] | null;
}) {
  const live = new Map((opts.live ?? []).map((l) => [`${l.kind}:${l.category}`, l.resources]));
  const blockedReason = (ex: (typeof EXTRACTORS)[number]): string | null => {
    if (ex.needsNetwork && !opts.enrich) return "network enrichment disabled (CRAWL_ENRICH=off)";
    if ((ex.id === "dns" || ex.id === "tls") && opts.egress === "proxy") return "behind an egress proxy: DNS/TLS of the origin are not observable";
    return null;
  };
  const categories = CATEGORIES.map((c) => {
    const formats = KINDS.map((kind) => {
      const configured = c.appliesTo === "all" || c.appliesTo.includes(kind);
      const exs = EXTRACTORS.filter((e) => e.categories.includes(c.id) && (e.kinds === "all" || e.kinds.includes(kind)));
      const runnable = exs.filter((e) => !blockedReason(e));
      const blocked = [...new Set(exs.map(blockedReason).filter((x): x is string => Boolean(x)))];
      const tested = OFFLINE_VERIFIED[kind]?.includes(c.id) ?? false;
      const liveN = opts.live === null ? ("unknown" as const) : live.get(`${kind}:${c.id}`) ?? 0;
      const status: CapabilityStatus =
        typeof liveN === "number" && liveN > 0 ? "live_verified" : tested ? "tested" : runnable.length ? "implemented" : exs.length ? "blocked" : configured ? "configured" : "unknown";
      return { kind, configured, implemented: exs.length > 0, extractors: exs.map((e) => `${e.id}@${e.version}`), tested, liveVerified: liveN, blocked, status };
    }).filter((f) => f.configured || f.implemented);
    return {
      id: c.id,
      key: c.key,
      name: c.name,
      methods: c.methods,
      limitations: c.limitations,
      formats,
      summary: Object.fromEntries((["live_verified", "tested", "implemented", "blocked", "configured"] as const).map((s) => [s, formats.filter((f) => f.status === s).map((f) => f.kind)])),
    };
  });
  const byFormat = opts.formats
    ? opts.formats.map((f) => ({ id: f.id, mimes: f.mimes, extensions: f.extensions ?? [], status: f.status, parser: f.parser ? "present" : null, tested: f.tested, categories: f.categories }))
    : null;
  return {
    legend: {
      configured: "category registry says the category applies to this format",
      implemented: "a registered extractor declares this format and category",
      tested: "an offline fixture of this format yields a real value in this category (checked in CI)",
      live_verified: "resources of this format in the corpus have this category observed (count)",
      blocked: "implemented, but every responsible extractor is disabled or impossible in this deployment",
      unknown: "no configuration and no implementation: no claim is made",
    },
    sources: {
      extractorRegistry: "src/metadata/extractors/index.ts",
      categoryRegistry: "src/metadata/categories.ts (appliesTo / methods)",
      formatRegistry: opts.formats ? "src/metadata/formats.ts" : "unavailable — falling back to the extractor registry (kinds)",
      live: opts.live === null ? "unknown (corpus not queried)" : "resource_coverage (latest processing round per resource)",
    },
    categories,
    formats: byFormat,
  };
}
