/**
 * Credential redaction for everything the corpus stores or indexes (search text, titles, field values,
 * evidence excerpts). Pages sometimes publish live secrets by accident; the crawler records *that* a
 * credential-like string was present (category 39, counts only) but never stores or indexes the value.
 */
const RULES: Array<{ type: string; re: RegExp; keep?: number }> = [
  { type: "private_key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g },
  { type: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { type: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, keep: 1 },
  { type: "bearer_token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, keep: 1 },
  // key = value / key: "value" assignments for secret-looking keys
  { type: "secret_assignment", re: /\b((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key)\s*["']?\s*[:=]\s*["']?)([^\s"'<>,;&]{6,})/gi, keep: 1 },
];

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
  total: number;
}

export function redactSecrets(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  let total = 0;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...m: unknown[]) => {
      counts[rule.type] = (counts[rule.type] ?? 0) + 1;
      total++;
      const kept = rule.keep ? String(m[rule.keep] ?? "") : "";
      return `${kept}[REDACTED:${rule.type}]`;
    });
  }
  return { text, counts, total };
}

/** Redacts strings inside any JSON-like value; returns the same reference when nothing matched. */
export function redactValue<T>(value: T, acc: RedactionResult = { text: "", counts: {}, total: 0 }): { value: T; total: number; counts: Record<string, number> } {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      if (!r.total) return v;
      acc.total += r.total;
      for (const [k, n] of Object.entries(r.counts)) acc.counts[k] = (acc.counts[k] ?? 0) + n;
      return r.text;
    }
    if (depth > 6 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = walk(x, depth + 1);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  };
  return { value: walk(value, 0) as T, total: acc.total, counts: acc.counts };
}
