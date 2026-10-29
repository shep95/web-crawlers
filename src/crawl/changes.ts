import { AnalysisError, analyzeResponse, robotsAllows } from "../metadata/pipeline.js";
import { C } from "../metadata/categories.js";
import type { ResourceRecord } from "../metadata/types.js";
import { safeFetch, safeFetchJson } from "../net/safe-fetch.js";

/** Fields whose change is meaningful (markup-only churn is ignored). */
const TRACKED: Array<[number, string]> = [
  [C.descriptive, "title"],
  [C.descriptive, "description"],
  [C.descriptive, "author"],
  [C.descriptive, "language"],
  [C.web_seo, "canonical"],
  [C.temporal, "published"],
  [C.temporal, "modified"],
  [C.rights, "license"],
  [C.semantic, "types"],
  [C.version, "version"],
  [C.identifiers, "doi"],
  [C.discovery, "robotsDirectives"],
  [C.structural, "headingOutline"],
  [C.document, "pageCount"],
];

export interface ChangeReport {
  url: string;
  current: { fetchedAt: string; contentHash: string | null; title: string | null };
  previous: { capturedAt: string; archiveUrl: string; contentHash: string | null; title: string | null } | null;
  contentChanged: boolean | null;
  textChanged: boolean | null;
  changes: Array<{ category: number; field: string; before: unknown; after: unknown }>;
  linksAdded: number;
  linksRemoved: number;
  note: string;
}

function valuesOf(r: ResourceRecord, cat: number, field: string): unknown {
  const vs = r.fields.filter((f) => f.category === cat && f.field === field).map((f) => f.value);
  return vs.length ? vs[0] : null;
}

function normText(r: ResourceRecord, shared: Map<string, unknown> | null): string {
  return String(shared?.get("plainText") ?? r.title ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Compare the live resource with its most recent Internet Archive capture.
 * Uses the raw `id_` capture mode so archive banners don't register as changes.
 */
export async function detectChanges(url: string): Promise<ChangeReport> {
  const rb = await robotsAllows(url);
  if (rb.allowed === false) throw new AnalysisError("ROBOTS_DISALLOWED", "robots.txt disallows fetching this URL", 451);
  const liveRes = await safeFetch(url, { timeoutMs: 20_000, maxBytes: 15 * 1024 * 1024 });
  let liveShared: Map<string, unknown> | null = null;
  const live = await analyzeResponse(liveRes, { sourceType: "url", enrich: false, onShared: (s) => (liveShared = s) });
  const cdx = await safeFetchJson<string[][]>(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(live.finalUrl)}&output=json&fl=timestamp,statuscode&filter=statuscode:200&limit=-1`,
    { timeoutMs: 8000 },
  ).catch(() => null);
  const ts = cdx?.[1]?.[0];
  const base: ChangeReport = {
    url: live.finalUrl,
    current: { fetchedAt: live.fetchedAt, contentHash: live.contentHash, title: live.title },
    previous: null,
    contentChanged: null,
    textChanged: null,
    changes: [],
    linksAdded: 0,
    linksRemoved: 0,
    note: "",
  };
  if (!ts) return { ...base, note: cdx ? "No prior Internet Archive capture exists for this URL." : "Internet Archive unavailable; cannot compare." };
  const archiveUrl = `https://web.archive.org/web/${ts}id_/${live.finalUrl}`;
  const res = await safeFetch(archiveUrl, { timeoutMs: 15_000, maxBytes: 15 * 1024 * 1024 });
  if (res.status !== 200) return { ...base, note: `Archive capture fetch returned HTTP ${res.status}.` };
  let prevShared: Map<string, unknown> | null = null;
  const prev = await analyzeResponse({ ...res, finalUrl: live.finalUrl }, { sourceType: "url", enrich: false, onShared: (s) => (prevShared = s) });

  const changes: ChangeReport["changes"] = [];
  for (const [cat, field] of TRACKED) {
    const before = valuesOf(prev, cat, field);
    const after = valuesOf(live, cat, field);
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ category: cat, field, before, after });
  }
  const linksBefore = new Set((prevShared as Map<string, unknown> | null)?.get("internalLinks") as string[] | undefined ?? []);
  const linksAfter = new Set((liveShared as Map<string, unknown> | null)?.get("internalLinks") as string[] | undefined ?? []);
  const capturedAt = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10) || "00"}:${ts.slice(10, 12) || "00"}:${ts.slice(12, 14) || "00"}Z`;
  return {
    ...base,
    previous: { capturedAt, archiveUrl, contentHash: prev.contentHash, title: prev.title },
    contentChanged: prev.contentHash !== live.contentHash,
    textChanged: normText(prev, prevShared) !== normText(live, liveShared),
    changes,
    linksAdded: [...linksAfter].filter((l) => !linksBefore.has(l)).length,
    linksRemoved: [...linksBefore].filter((l) => !linksAfter.has(l)).length,
    note: "Byte-level hash changes are common (dynamic markup); `changes` lists only meaningful metadata fields.",
  };
}
