/**
 * Credential / secret detection. Findings carry the type and location only:
 * secret values are never returned, logged or indexed — callers receive a
 * redaction marker instead (`[REDACTED:<type>]`).
 */

export type SecretType =
  | "private-key-block"
  | "aws-access-key-id"
  | "aws-secret-access-key"
  | "jwt"
  | "bearer-token"
  | "github-token"
  | "slack-token"
  | "google-api-key"
  | "stripe-key"
  | "api-key-sk"
  | "url-credentials"
  | "credential-assignment";

export interface SecretFinding {
  type: SecretType;
  confidence: "high" | "medium" | "low";
  /** UTF-16 range of the redacted value (end exclusive). */
  start: number;
  end: number;
  /** Length of the secret in UTF-16 units; the value itself is withheld. */
  length: number;
  /** What a reader sees instead of the value. */
  redacted: string;
  /** Likely a documentation placeholder (e.g. YOUR_API_KEY) — still redacted. */
  likelyPlaceholder?: true;
}

interface Rule {
  type: SecretType;
  confidence: SecretFinding["confidence"];
  re: RegExp;
  /** Capture group holding the value to redact (0 = whole match). */
  group: number;
}

const RULES: Rule[] = [
  { type: "private-key-block", confidence: "high", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----|[\s\S]{0,6000})/dg, group: 0 },
  { type: "aws-access-key-id", confidence: "high", re: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/dg, group: 1 },
  { type: "aws-secret-access-key", confidence: "high", re: /\baws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi, group: 1 },
  { type: "jwt", confidence: "high", re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/dg, group: 1 },
  { type: "github-token", confidence: "high", re: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/dg, group: 1 },
  { type: "slack-token", confidence: "high", re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/dg, group: 1 },
  { type: "google-api-key", confidence: "high", re: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/dg, group: 1 },
  { type: "stripe-key", confidence: "high", re: /\b((?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,})\b/dg, group: 1 },
  { type: "api-key-sk", confidence: "medium", re: /\b(sk-(?:[a-z]{2,8}-)?[A-Za-z0-9_-]{20,})/dg, group: 1 },
  { type: "bearer-token", confidence: "medium", re: /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}=*)/dgi, group: 1 },
  { type: "url-credentials", confidence: "medium", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@"'<>]{1,64}:([^\s/@"'<>]{3,128})@[\w.-]+/dgi, group: 1 },
  {
    type: "credential-assignment",
    confidence: "low",
    re: /\b(?:password|passwd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key)["']?\s*[:=]\s*(["']?)([^\s"'&,;<>]{4,200})\1/dgi,
    group: 2,
  },
];

const PLACEHOLDER = /^(?:<[^>]*>|\$\{?[\w.]+\}?|\{\{.*\}\}|x{4,}|\*{3,}|\.{3,}|your[-_]?|my[-_]?|example|placeholder|changeme|redacted|dummy|sample|test|token|secret|password|null|none|undefined|true|false|required|optional|string)/i;

/** Detect secrets; overlapping matches keep the earliest/longest (higher-confidence rules run first). */
export function detectSecrets(text: string, opts: { maxFindings?: number } = {}): SecretFinding[] {
  const found: SecretFinding[] = [];
  const max = opts.maxFindings ?? 500;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = m[rule.group];
      if (!value) continue;
      const [start, end] = m.indices?.[rule.group] ?? [m.index, m.index + m[0].length];
      if (found.some((f) => start < f.end && end > f.start)) continue;
      // Already-redacted text must not be redacted again.
      if (/^\[REDACTED:/.test(value)) continue;
      const placeholder = PLACEHOLDER.test(value) || /^(.)\1+$/.test(value);
      if (rule.type === "credential-assignment" && /^[a-z]+$/i.test(value) && value.length < 6) continue; // prose like "password: none"
      found.push({ type: rule.type, confidence: placeholder ? "low" : rule.confidence, start, end, length: value.length, redacted: `[REDACTED:${rule.type}]`, ...(placeholder ? { likelyPlaceholder: true as const } : {}) });
      if (found.length >= max) break;
    }
    if (found.length >= max) break;
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Replace every detected secret value with `[REDACTED:<type>]`. Offsets after a redaction shift; findings refer to the input. */
export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  const findings = detectSecrets(text, { maxFindings: 10_000 });
  if (!findings.length) return { text, findings };
  let out = "";
  let last = 0;
  for (const f of findings) {
    out += text.slice(last, f.start) + f.redacted;
    last = f.end;
  }
  return { text: out + text.slice(last), findings };
}

/** Redact secrets in a text excerpt before it is stored or indexed (scans a little past the cap so a secret cut by it is still caught). */
export function redactForIndex(text: string, cap: number): string {
  return redactSecrets(text.slice(0, cap + 2_000)).text.slice(0, cap);
}
