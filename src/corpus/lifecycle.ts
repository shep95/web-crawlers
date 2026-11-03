import type { ResourceState } from "./types.js";
import { FetchBlockedError } from "../net/safe-fetch.js";

/**
 * Durable per-resource lifecycle (item state machine).
 *
 * The legacy `state` column (queued / leased / indexed / unavailable / skipped / failed) remains the
 * *scheduling* state: what the frontier may lease next and what search may return. `lifecycle` is the
 * finer, observable *processing* state, written only through guarded transitions that are recorded
 * with timestamps in the `transitions` table. Source-level outcomes (an HTTP response arrived) and
 * content-level outcomes (fields were extracted and validated) are separate states: an HTTP 200 is
 * `fetched`, not `indexed`; a link seen on a page is `discovered`, not crawled.
 *
 * ```
 *  discovered ─┐                     ┌──────────────► restricted (robots / 401 / 403 / 451)
 *  scheduled ──┼─► leased ─► fetched ┼─► change_detected ─► unavailable (404 / 410 / other 4xx)
 *  (resting) ──┘     │         │     └─► inspected ─► [change_detected] ─► extracted ─► validated ─┬─► indexed
 *                    │         │                                                                └─► superseded (duplicate_of)
 *                    │         └─► indexed | superseded (304 not modified)
 *                    ├─► skipped (egress / SSRF / policy)
 *                    └─► failed_retryable ──(due)──► leased …   (retries exhausted → permanently_failed)
 *  any in-flight state ─(lease expired / worker died)─► scheduled
 * ```
 */
export const LIFECYCLE_STATES = [
  "discovered", // a reference was seen and admitted to the frontier — not yet retrieved
  "scheduled", // re-entered the frontier on purpose (abandoned lease recovered, re-crawl requested)
  "leased", // a worker holds the item
  "fetched", // a transport response arrived (any HTTP status) — says nothing about content
  "inspected", // bytes were sniffed and the format extractors ran over real content
  "extracted", // field observations (incl. crawler's own) were assembled
  "validated", // the record was checked (types, declared vs sniffed format, truncation, failures)
  "indexed", // the validated record is searchable
  "restricted", // the source restricts access (robots.txt, 401/403/407/451)
  "skipped", // this system's own policy declined it (egress/SSRF guard, excluded host, trap)
  "unavailable", // the source answered that it is not there (404/410/other 4xx)
  "failed_retryable", // transient failure (network, timeout, 408/425/429/5xx); will be retried
  "permanently_failed", // retries exhausted, or a deterministic failure (redirect loop, invalid URL)
  "change_detected", // a revisit observed a different status or content than the last snapshot
  "superseded", // another resource represents these bytes (duplicate_of); not indexed separately
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** States an item rests in between processing rounds (everything else is in-flight). */
export const RESTING_STATES: ReadonlySet<LifecycleState> = new Set(["discovered", "scheduled", "indexed", "restricted", "skipped", "unavailable", "failed_retryable", "permanently_failed", "superseded"]);
export const IN_FLIGHT_STATES: readonly LifecycleState[] = ["leased", "fetched", "inspected", "extracted", "validated", "change_detected"];

const FAIL: LifecycleState[] = ["failed_retryable", "permanently_failed", "skipped", "scheduled"];

/** Allowed transitions. Anything not listed is rejected by {@link assertTransition}. */
export const TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  discovered: ["leased", "skipped", "restricted", "scheduled"],
  scheduled: ["leased", "skipped", "restricted"],
  leased: ["fetched", "restricted", ...FAIL],
  fetched: ["inspected", "change_detected", "indexed", "superseded", "unavailable", "restricted", ...FAIL],
  inspected: ["extracted", "change_detected", ...FAIL],
  change_detected: ["extracted", "unavailable", "restricted", "permanently_failed", ...FAIL],
  extracted: ["validated", ...FAIL],
  validated: ["indexed", "superseded", ...FAIL],
  indexed: ["leased", "scheduled", "superseded"],
  superseded: ["leased", "scheduled", "indexed"],
  restricted: ["leased", "scheduled"],
  skipped: ["leased", "scheduled"],
  unavailable: ["leased", "scheduled"],
  failed_retryable: ["leased", "scheduled", "permanently_failed"],
  permanently_failed: ["leased", "scheduled"],
};

export class IllegalTransitionError extends Error {
  constructor(
    public from: string | null,
    public to: string,
    public resourceId?: number,
    why = "not an allowed transition",
  ) {
    super(`illegal lifecycle transition ${from ?? "∅"} → ${to}${resourceId !== undefined ? ` (resource #${resourceId})` : ""}: ${why}`);
  }
}

export function isLifecycleState(s: unknown): s is LifecycleState {
  return typeof s === "string" && (LIFECYCLE_STATES as readonly string[]).includes(s);
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws unless every step of `from → path[0] → path[1] …` is allowed. */
export function assertTransition(from: string | null, path: LifecycleState | readonly LifecycleState[], resourceId?: number): LifecycleState {
  const steps = typeof path === "string" ? [path] : path;
  if (!steps.length) throw new IllegalTransitionError(from, "(empty)", resourceId, "empty path");
  let cur = from;
  for (const to of steps) {
    if (!isLifecycleState(to)) throw new IllegalTransitionError(cur, String(to), resourceId, "unknown state");
    if (!isLifecycleState(cur) || !canTransition(cur, to)) throw new IllegalTransitionError(cur, to, resourceId);
    cur = to;
  }
  return cur as LifecycleState;
}

/**
 * Lifecycle for rows written before lifecycle tracking existed (data migration "lifecycle-v1").
 * Portable SQL CASE over the legacy columns; also used as COALESCE fallback while a backfill runs.
 */
export const LEGACY_LIFECYCLE_SQL = `CASE
  WHEN state = 'queued' AND attempts > 0 AND last_error IS NOT NULL THEN 'failed_retryable'
  WHEN state = 'queued' THEN 'discovered'
  WHEN state = 'leased' THEN 'leased'
  WHEN state = 'indexed' AND duplicate_of IS NOT NULL THEN 'superseded'
  WHEN state = 'indexed' THEN 'indexed'
  WHEN state = 'unavailable' AND http_status IN (401, 403, 407, 451) THEN 'restricted'
  WHEN state = 'unavailable' AND http_status >= 500 THEN 'permanently_failed'
  WHEN state = 'unavailable' THEN 'unavailable'
  WHEN state = 'skipped' AND last_error LIKE 'robots%' THEN 'restricted'
  WHEN state = 'skipped' THEN 'skipped'
  ELSE 'permanently_failed' END`;

/** Short reason codes for legacy rows (derived from last_error / http_status). */
export const LEGACY_REASON_SQL = `CASE
  WHEN last_error LIKE 'robots%' THEN 'robots_disallow'
  WHEN last_error LIKE 'EGRESS_BLOCKED%' THEN 'egress_policy'
  WHEN state IN ('unavailable', 'indexed') AND http_status IS NOT NULL AND http_status >= 400 THEN 'http_' || CAST(http_status AS TEXT)
  WHEN state = 'indexed' AND duplicate_of IS NOT NULL THEN 'duplicate_content'
  WHEN last_error IS NOT NULL THEN 'legacy_error'
  ELSE NULL END`;

/** Expression usable in queries before/while the backfill runs. */
export const LIFECYCLE_EXPR = `COALESCE(lifecycle, ${LEGACY_LIFECYCLE_SQL})`;

/** JS mirror of {@link LEGACY_LIFECYCLE_SQL} (rows read before the backfill reached them). */
export function lifecycleFromLegacy(r: { state: string; attempts?: number; last_error?: string | null; duplicate_of?: number | null; http_status?: number | null }): LifecycleState {
  const s = r.http_status ?? 0;
  switch (r.state as ResourceState) {
    case "queued":
      return (r.attempts ?? 0) > 0 && r.last_error ? "failed_retryable" : "discovered";
    case "leased":
      return "leased";
    case "indexed":
      return r.duplicate_of ? "superseded" : "indexed";
    case "unavailable":
      return [401, 403, 407, 451].includes(s) ? "restricted" : s >= 500 ? "permanently_failed" : "unavailable";
    case "skipped":
      return /^robots/.test(r.last_error ?? "") ? "restricted" : "skipped";
    default:
      return "permanently_failed";
  }
}

// ---------------------------------------------------------------- retry policy

/**
 * Retry policy.
 * - retryable: network errors (reset, refused, DNS temporary failure, timeouts), HTTP 408, 425, 429, 5xx.
 *   Backoff 15 min × 2^(n−1) (15 m, 30 m, 60 m …, ≤ 6 h), or the server's Retry-After when longer (≤ 24 h).
 *   After `maxAttempts` consecutive failures → permanently_failed.
 * - permanent (no retry): redirect loops, invalid URLs, deterministic processing errors after retries.
 * - unavailable: 404, 410, other 4xx — the source answered; revisited on the normal schedule (7 d).
 * - restricted: robots.txt disallow, 401, 403, 407, 451 — never bypassed; revisited after 30 d.
 * - skipped: this system's egress / SSRF policy (private IP, credentials in URL, blocked port).
 */
export const RETRY_POLICY = {
  maxAttempts: Number(process.env.CRAWL_MAX_ATTEMPTS ?? 3),
  baseBackoffMs: 15 * 60_000,
  maxBackoffMs: 6 * 3600_000,
  maxRetryAfterMs: 24 * 3600_000,
  backoffMs(failures: number, retryAfterMs: number | null = null): number {
    const computed = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, failures - 1));
    return retryAfterMs ? Math.max(computed, Math.min(retryAfterMs, this.maxRetryAfterMs)) : computed;
  },
};

export type HttpOutcome = "ok" | "not_modified" | "retryable" | "unavailable" | "restricted";

export function classifyHttp(status: number): HttpOutcome {
  if (status === 304) return "not_modified";
  if (status < 400) return "ok";
  if ([401, 403, 407, 451].includes(status)) return "restricted";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retryable";
  return "unavailable";
}

/** Parse Retry-After (seconds or HTTP date) relative to `now`. */
export function retryAfterMs(header: string | undefined, now: number): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export type ErrorClass = { kind: "policy" | "retryable" | "permanent"; reason: string };

export function classifyError(err: unknown): ErrorClass {
  const e = err as Error & { code?: string; reason?: string; cause?: { code?: string } };
  const msg = String(e?.message ?? err);
  const code = e?.cause?.code ?? e?.code ?? "";
  if (err instanceof FetchBlockedError || /EGRESS_BLOCKED/.test(msg) || code === "EGRESS_BLOCKED") {
    const reason = e?.reason ?? (/non-public address/.test(msg) ? "non_public_address" : "egress_policy");
    if (reason === "too_many_redirects") return { kind: "permanent", reason: "too_many_redirects" };
    return { kind: "policy", reason: `egress_policy:${reason}` };
  }
  if (/Invalid URL|ERR_INVALID_URL/.test(msg)) return { kind: "permanent", reason: "invalid_url" };
  if (/timed? ?out|TimeoutError|AbortError|UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/i.test(msg) || /TIMEOUT/.test(code)) return { kind: "retryable", reason: "timeout" };
  if (/ENOTFOUND|EAI_AGAIN/.test(msg + code)) return { kind: "retryable", reason: "dns" };
  if (/ECONNRESET|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|other side closed|socket hang up/i.test(msg + code)) return { kind: "retryable", reason: "network" };
  return { kind: "retryable", reason: "processing_error" };
}
