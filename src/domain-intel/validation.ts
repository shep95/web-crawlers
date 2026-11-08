import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import type { HttpResult, IntelNet } from "./net.js";

export const redirectParam = /^(next|url|redirect|redirect_uri|return|returnTo|return_to|continue|dest|destination|goto|target)$/i;

export function isReadOnlyCandidate(url: URL) {
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { return false; }
  const unsafe = /(?:^|[/_-])(?:log[-_]?out|sign[-_]?out|unsubscribe|delete|remove|revoke|reset|confirm|activate|approve|purchase|checkout|destroy|callback|verify|webhook|redeem|invite)(?:[/_.-]|$)/i;
  return !unsafe.test(path) && ![...url.searchParams].some(([key, value]) =>
    /^(?:token|access_token|id_token|code|password|secret|signature|sig|session|api[_-]?key)$/i.test(key) ||
    (/^(?:action|op|method|do|task)$/i.test(key) && unsafe.test(value)));
}

type Trial = { status: number; outcome: string; input?: string };
export type Validation = {
  check: "open-redirect" | "cors" | "public-private-key";
  state: "confirmed" | "observed" | "not-reproduced" | "inconclusive";
  at: string; severity: "info" | "high"; control: Trial; trials: Trial[];
  parameter?: string; fingerprint?: string;
};

const ok = (r: HttpResult) => !r.error && r.status >= 200 && r.status < 300;
const isRedirect = (r: HttpResult) => [301, 302, 303, 307, 308].includes(r.status);
const targetOf = (r: HttpResult, url: string) => {
  if (!isRedirect(r) || !r.headers.location) return null;
  try { return new URL(r.headers.location, url).href; } catch { return null; }
};

function privateKeyFingerprint(body: string): string | null {
  const re = /-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----[ \t\r\n]+[A-Za-z0-9+/=\s]{16,16384}-----END \1-----/g;
  for (const [pem] of body.matchAll(re)) {
    try {
      const key = createPrivateKey({ key: pem, format: "pem", passphrase: "" });
      return createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
    } catch { /* Invalid or unsupported key material is an observation only. */ }
  }
  return null;
}

/** Uses an anonymous baseline and fresh read-only requests. Probe URLs never redirect the runner. */
export async function validatePage(net: IntelNet, url: URL, baseline: HttpResult, timeoutMs: number, enabled: boolean, now: () => number): Promise<Validation[]> {
  if (!enabled || !isReadOnlyCandidate(url) || !baseline.status || baseline.error) return [];
  const checks: Validation[] = [];
  const at = new Date(now()).toISOString();
  const options = { method: "GET" as const, follow: false, timeoutMs: Math.min(2500, timeoutMs), maxBytes: 4096 };
  const queryKeys = [...url.searchParams.keys()];
  const parameter = queryKeys.find(key => redirectParam.test(key));
  if (parameter && queryKeys.length === 1) {
    const canaries = [1, 2].map(i => "https://void-" + i + "-" + randomBytes(8).toString("hex") + ".invalid/");
    const trials: Trial[] = [];
    for (const input of canaries) {
      const variant = new URL(url.href);
      variant.searchParams.set(parameter, input);
      const r = await net.http(variant.href, options);
      trials.push({ status: r.status, input, outcome: targetOf(r, variant.href) === input ? "Location matched supplied URL" : "No matching redirect" });
    }
    const confirmed = trials.every(t => t.outcome === "Location matched supplied URL") && !canaries.includes(targetOf(baseline, url.href) || "");
    checks.push({ check: "open-redirect", state: confirmed ? "confirmed" : trials.some(t => !t.status) ? "inconclusive" : "not-reproduced",
      severity: "info", at, parameter, control: { status: baseline.status, outcome: "Original URL without test markers" }, trials });
  }
  if (ok(baseline) && (baseline.headers["access-control-allow-origin"] || /\/(?:api|graphql)(?:\/|$)/i.test(url.pathname))) {
    const origins = [1, 2].map(i => "https://void-" + i + "-" + randomBytes(8).toString("hex") + ".invalid");
    const trials: Trial[] = [];
    for (const input of origins) {
      const r = await net.http(url.href, { ...options, headers: { origin: input } });
      const reflected = ok(r) && r.headers["access-control-allow-origin"] === input;
      const credentials = r.headers["access-control-allow-credentials"]?.trim() === "true";
      trials.push({ status: r.status, input, outcome: reflected ? credentials ? "Reflected origin with credential permission" : "Reflected origin" : "Origin was not reflected" });
    }
    checks.push({ check: "cors", state: trials.every(t => t.outcome.startsWith("Reflected")) ? "observed" : trials.some(t => !t.status) ? "inconclusive" : "not-reproduced",
      severity: "info", at, control: { status: baseline.status, outcome: "Anonymous request without an Origin header" }, trials });
  }
  const fingerprint = ok(baseline) ? privateKeyFingerprint(baseline.body) : null;
  if (fingerprint) {
    const retest = await net.http(url.href, { ...options, maxBytes: 8 * 1024 * 1024, headers: { "cache-control": "no-cache" } });
    const matched = ok(retest) && privateKeyFingerprint(retest.body) === fingerprint;
    checks.push({ check: "public-private-key", state: matched ? "confirmed" : !retest.status || retest.truncated ? "inconclusive" : "not-reproduced",
      at, severity: "high", fingerprint, control: { status: baseline.status, outcome: "Anonymous response contained a parseable private key" },
      trials: [{ status: retest.status, outcome: matched ? "Anonymous repeat returned a key with the same public fingerprint" : "Same key could not be reproduced" }] });
  }
  return checks;
}
