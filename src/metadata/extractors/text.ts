import yaml from "js-yaml";
import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { clean, findIdentifiers, maskEmail, normalizeDate, personalDataIndicators } from "../normalize.js";

type Json = Record<string, unknown>;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))) : v ? [String(v)] : []);

export const textExtractor: Extractor = {
  id: "text",
  version: "1.0.0",
  description: "Plain text/Markdown: model & dataset cards (YAML front matter), CITATION.cff, security.txt, checksum manifests, identifiers.",
  kinds: ["text"],
  categories: [C.ai_ml, C.lineage, C.rights, C.descriptive, C.scientific, C.identifiers, C.integrity, C.retention, C.structural, C.access_security],
  timeoutMs: 3000,
  async run(ctx) {
    const text = await ctx.text();
    const lines = text.split(/\r?\n/);
    ctx.add(C.structural, "lineCount", lines.length, { status: "observed", method: "line count" });
    ctx.add(C.structural, "wordCount", text.split(/\s+/).filter(Boolean).length, { status: "observed", method: "word count" });
    const mdHeadings = lines.filter((l) => /^#{1,6}\s/.test(l)).slice(0, 40).map((l) => ({ level: l.match(/^#+/)![0].length, text: clean(l.replace(/^#+\s*/, ""), 160) }));
    ctx.add(C.structural, "headingOutline", mdHeadings, { status: "observed", method: "markdown headings" });
    const h1 = mdHeadings.find((h) => h.level === 1)?.text;
    if (h1) ctx.add(C.descriptive, "title", h1, { method: "first markdown H1" });

    // YAML front matter (Hugging Face model/dataset cards, static-site posts)
    const fm = text.match(/^---\r?\n([\s\S]{1,20000}?)\r?\n---/);
    if (fm) {
      let meta: Json | null = null;
      try {
        meta = yaml.load(fm[1], { schema: yaml.CORE_SCHEMA }) as Json;
      } catch {
        ctx.add(C.quality, "frontMatterError", "invalid YAML front matter", { status: "extraction_failed", method: "js-yaml" });
      }
      if (meta && typeof meta === "object") {
        const m = (k: string) => ({ method: `front-matter ${k}` });
        ctx.add(C.rights, "license", clean(meta.license ?? meta.license_name), m("license"));
        ctx.add(C.descriptive, "title", clean(meta.title ?? meta.pretty_name ?? meta.model_name), m("title|pretty_name"));
        ctx.add(C.descriptive, "language", arr(meta.language).join(", ") || null, m("language"));
        ctx.add(C.descriptive, "keywords", arr(meta.tags).slice(0, 40), m("tags"));
        ctx.add(C.social_annotation, "tags", arr(meta.tags).slice(0, 40), m("tags"));
        const isCard = ["pipeline_tag", "library_name", "base_model", "datasets", "model-index", "task_categories", "metrics"].some((k) => k in meta!);
        if (isCard) {
          ctx.add(C.ai_ml, "pipelineTag", clean(meta.pipeline_tag), m("pipeline_tag"));
          ctx.add(C.ai_ml, "libraryName", clean(meta.library_name), m("library_name"));
          ctx.add(C.ai_ml, "baseModel", arr(meta.base_model), m("base_model"));
          ctx.add(C.ai_ml, "datasets", arr(meta.datasets).slice(0, 30), m("datasets"));
          ctx.add(C.ai_ml, "metrics", arr(meta.metrics).slice(0, 30), m("metrics"));
          ctx.add(C.ai_ml, "taskCategories", arr(meta.task_categories), m("task_categories"));
          ctx.add(C.lineage, "baseModel", arr(meta.base_model), m("base_model"));
          ctx.add(C.lineage, "derivedFrom", arr(meta.datasets).slice(0, 30), m("datasets"));
          for (const b of arr(meta.base_model)) ctx.relate("derived_from", `https://huggingface.co/${b}`, "model card base_model", "front-matter base_model");
          const mi = Array.isArray(meta["model-index"]) ? (meta["model-index"] as Json[]) : [];
          const results: unknown[] = [];
          for (const entry of mi.slice(0, 3)) {
            for (const r of (Array.isArray(entry.results) ? entry.results : []) as Json[]) {
              const ds = (r.dataset ?? {}) as Json;
              for (const met of (Array.isArray(r.metrics) ? r.metrics : []) as Json[]) {
                results.push({ dataset: ds.name ?? ds.type, metric: met.type ?? met.name, value: met.value });
                if (results.length > 40) break;
              }
            }
          }
          ctx.add(C.ai_ml, "evaluationResults", results, m("model-index"));
          const lim = text.match(/#+\s*(?:Limitations|Bias,? Risks,? and Limitations|Out-of-Scope Use)[^\n]*\n+([\s\S]{20,800}?)(?:\n#|$)/i);
          if (lim) ctx.add(C.ai_ml, "limitations", clean(lim[1], 700), { method: "model card limitations section" });
        }
      }
    }

    // CITATION.cff
    if (/^cff-version:/m.test(text)) {
      try {
        const cff = yaml.load(text, { schema: yaml.CORE_SCHEMA }) as Json;
        ctx.add(C.scientific, "citationFile", "CITATION.cff", { method: "cff-version" });
        ctx.add(C.descriptive, "title", clean(cff.title), { method: "CITATION.cff title" });
        const authors = (Array.isArray(cff.authors) ? cff.authors : []) as Json[];
        ctx.add(C.scientific, "authors", authors.map((a) => clean(`${a["given-names"] ?? ""} ${a["family-names"] ?? a.name ?? ""}`)).filter(Boolean), { method: "CITATION.cff authors" });
        const orcids = authors.map((a) => String(a.orcid ?? "").replace(/^https?:\/\/orcid\.org\//, "")).filter(Boolean);
        ctx.add(C.identifiers, "orcid", orcids, { method: "CITATION.cff authors.orcid" });
        if (cff.doi) ctx.add(C.identifiers, "doi", [String(cff.doi).toLowerCase()], { method: "CITATION.cff doi" });
        ctx.add(C.version, "version", cff.version ? String(cff.version) : null, { method: "CITATION.cff version" });
        ctx.add(C.rights, "license", clean(cff.license), { method: "CITATION.cff license" });
        const rel = normalizeDate(cff["date-released"]);
        if (rel) ctx.add(C.temporal, "published", rel.iso, { method: "CITATION.cff date-released", original: rel.original });
      } catch {
        ctx.add(C.quality, "citationParseError", "invalid CITATION.cff", { status: "extraction_failed", method: "js-yaml" });
      }
    }

    // security.txt (RFC 9116)
    if (/^(Contact|Expires|Policy|Encryption):/im.test(text) && /^Contact:/im.test(text)) {
      const get = (k: string) => [...text.matchAll(new RegExp(`^${k}:\\s*(.+)$`, "gim"))].map((x) => x[1].trim());
      ctx.add(C.access_security, "securityContact", get("Contact").map((c) => (c.startsWith("mailto:") ? `mailto:${maskEmail(c.slice(7))}` : c)), { method: "security.txt Contact", masked: true });
      ctx.add(C.access_security, "securityPolicy", get("Policy"), { method: "security.txt Policy" });
      const exp = normalizeDate(get("Expires")[0]);
      if (exp) ctx.add(C.retention, "expires", exp.iso, { method: "security.txt Expires", original: exp.original });
      ctx.add(C.integrity, "signed", /-----BEGIN PGP SIGNED MESSAGE-----/.test(text), { status: "observed", method: "PGP cleartext signature marker", evidence: "signature NOT verified" });
    }

    // Checksum manifests (SHA256SUMS, *.sha256)
    const sums = [...text.matchAll(/^([a-f0-9]{64})\s+\*?(\S+)$/gim)].slice(0, 200);
    if (sums.length && sums.length >= lines.filter((l) => l.trim()).length * 0.8) {
      ctx.add(C.integrity, "publishedChecksums", sums.slice(0, 50).map((s) => ({ sha256: s[1].toLowerCase(), file: s[2] })), { method: "sha256sum manifest" });
    }

    const ids = findIdentifiers(text);
    ctx.add(C.identifiers, "doi", ids.doi, { method: "doi pattern" });
    ctx.add(C.identifiers, "isbn", ids.isbn, { method: "isbn pattern + checksum" });
    ctx.add(C.identifiers, "orcid", ids.orcid, { method: "orcid pattern + checksum" });
    ctx.add(C.identifiers, "arxiv", ids.arxiv, { method: "arXiv pattern" });
  },
};

// ---------------------------------------------------------------- email

function maskAddressList(v: string): string[] {
  return (v.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map(maskEmail).slice(0, 50);
}

export const emailExtractor: Extractor = {
  id: "email",
  version: "1.0.0",
  description: "RFC 5322 header parsing for user-provided .eml messages; addresses masked, bodies not returned.",
  kinds: ["email"],
  categories: [C.email, C.temporal, C.relational, C.integrity, C.network, C.descriptive, C.structural, C.privacy],
  timeoutMs: 2000,
  async run(ctx) {
    const raw = await ctx.text();
    const headerBlock = raw.split(/\r?\n\r?\n/)[0].slice(0, 200_000);
    const headers: Array<[string, string]> = [];
    for (const line of headerBlock.split(/\r?\n/)) {
      if (/^\s/.test(line) && headers.length) headers[headers.length - 1][1] += ` ${line.trim()}`;
      else {
        const i = line.indexOf(":");
        if (i > 0) headers.push([line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]);
      }
    }
    const get = (k: string) => headers.find(([n]) => n === k)?.[1] ?? null;
    const all = (k: string) => headers.filter(([n]) => n === k).map(([, v]) => v);
    const m = (k: string) => ({ method: `rfc5322 header ${k}` });
    ctx.add(C.email, "messageId", get("message-id"), m("Message-ID"));
    ctx.add(C.email, "from", get("from") ? maskAddressList(get("from")!)[0] ?? "(unparseable)" : null, { ...m("From"), masked: true });
    ctx.add(C.email, "to", maskAddressList(get("to") ?? ""), { ...m("To"), masked: true });
    ctx.add(C.email, "cc", maskAddressList(get("cc") ?? ""), { ...m("Cc"), masked: true });
    ctx.add(C.email, "subject", clean(get("subject"), 300), m("Subject"));
    ctx.add(C.descriptive, "title", clean(get("subject"), 300), m("Subject"));
    const date = normalizeDate(get("date"));
    if (date) {
      ctx.add(C.email, "date", date.iso, { ...m("Date"), original: date.original });
      ctx.add(C.temporal, "created", date.iso, { ...m("Date"), original: date.original });
    }
    ctx.add(C.email, "inReplyTo", get("in-reply-to"), m("In-Reply-To"));
    const refs = (get("references") ?? "").match(/<[^>]+>/g) ?? [];
    ctx.add(C.email, "references", refs.slice(0, 30), m("References"));
    for (const r of refs.slice(0, 30)) ctx.relate("references", `mid:${r.replace(/[<>]/g, "")}`, "References header", "rfc5322 References");
    const received = all("received");
    ctx.add(C.email, "receivedHops", received.length, { status: "observed", method: "count(Received)" });
    ctx.add(C.network, "relayHosts", received.map((r) => r.match(/\bby\s+([A-Za-z0-9.-]+)/)?.[1]).filter(Boolean).slice(0, 20), { method: "Received: by <host>" });
    ctx.add(C.email, "dkim", all("dkim-signature").length > 0, { status: "observed", method: "DKIM-Signature presence", evidence: "signature NOT cryptographically verified" });
    ctx.add(C.integrity, "signed", all("dkim-signature").length > 0, { status: "observed", method: "DKIM-Signature presence", evidence: "signature NOT cryptographically verified" });
    ctx.add(C.email, "authResults", clean(get("authentication-results"), 400), m("Authentication-Results"));
    const ct = get("content-type") ?? "text/plain";
    const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((x) => x[1]);
    const parts = [...raw.matchAll(/^Content-Type:\s*([^;\r\n]+)/gim)].map((x) => x[1].trim().toLowerCase());
    ctx.add(C.email, "mimeParts", parts.slice(0, 40), { status: "observed", method: "Content-Type headers", evidence: `top-level ${ct}; ${boundaries.length} multipart boundary(ies)` });
    ctx.add(C.structural, "mimePartCount", parts.length, { status: "observed", method: "Content-Type headers" });
    const attachments = [...raw.matchAll(/filename\*?="?([^";\r\n]+)"?/gi)].map((x) => x[1]).slice(0, 20);
    ctx.add(C.email, "attachmentNames", attachments, m("Content-Disposition filename"));
  },
};

// ---------------------------------------------------------------- privacy (all text kinds)

export const privacyExtractor: Extractor = {
  id: "privacy",
  version: "1.0.0",
  description: "Counts personal-data indicators (emails, phones, SSN-like, Luhn-valid card numbers) without returning values.",
  kinds: ["webpage", "text", "json", "csv", "xml", "feed", "email", "pdf"],
  categories: [C.privacy],
  // Runs after local extractors so document text (PDF text layer, HTML body) is available.
  phase: "enrich",
  timeoutMs: 2000,
  async run(ctx) {
    const text = (ctx.shared.get("plainText") as string | undefined) ?? (ctx.kind === "pdf" ? "" : await ctx.text());
    const ind = personalDataIndicators(text.slice(0, 2_000_000));
    const total = ind.emails + ind.phones + ind.ssnLike + ind.paymentCardLike;
    ctx.add(C.privacy, "personalDataIndicators", { ...ind, total }, { status: "observed", method: "pattern counts (values withheld)", evidence: "counts only; raw personal data is never returned", masked: true });
    if (ind.ssnLike || ind.paymentCardLike) {
      ctx.add(C.privacy, "sensitiveDataWarning", true, { status: "inferred", method: "SSN/card patterns", evidence: "possible highly sensitive identifiers present" });
    }
  },
};
