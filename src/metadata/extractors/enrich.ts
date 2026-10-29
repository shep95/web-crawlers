import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { clean, normalizeDate } from "../normalize.js";
import { getEgressMode, resolvePublic, safeFetch, safeFetchJson } from "../../net/safe-fetch.js";

type Json = Record<string, unknown>;
const hostOf = (ctx: ExtractionContext) => new URL(ctx.response.finalUrl).hostname;
const fieldValues = (ctx: ExtractionContext, category: number, field: string) =>
  ctx.fields().filter((f) => f.category === category && f.field === field).flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]));

/** DNS records are public; only available with direct egress (proxies resolve remotely). */
export const dnsExtractor: Extractor = {
  id: "dns",
  version: "1.0.0",
  description: "Public DNS records for the resource host: A/AAAA/NS/MX, SPF and DMARC presence.",
  kinds: "all",
  categories: [C.network],
  needsNetwork: true,
  timeoutMs: 3000,
  async run(ctx) {
    if (ctx.sourceType !== "url" || getEgressMode() !== "direct") {
      ctx.add(C.network, "dnsUnavailable", "DNS inspection requires direct egress", { status: "observed", method: "service config" });
      return;
    }
    const host = hostOf(ctx);
    const apex = host.split(".").slice(-2).join(".");
    const safe = <T>(p: Promise<T>) => p.catch(() => null);
    const [a, aaaa, ns, mx, txt, dmarc] = await Promise.all([
      safe(dns.resolve4(host)),
      safe(dns.resolve6(host)),
      safe(dns.resolveNs(apex)),
      safe(dns.resolveMx(apex)),
      safe(dns.resolveTxt(apex)),
      safe(dns.resolveTxt(`_dmarc.${apex}`)),
    ]);
    const spf = txt?.map((r) => r.join("")).find((r) => r.startsWith("v=spf1")) ?? null;
    ctx.add(C.network, "dns", {
      a: a?.slice(0, 10) ?? [],
      aaaa: aaaa?.slice(0, 10) ?? [],
      ns: ns?.slice(0, 10) ?? [],
      mx: mx?.slice(0, 10).map((m) => m.exchange) ?? [],
      spf: spf ? spf.slice(0, 200) : null,
      dmarc: dmarc?.map((r) => r.join("")).find((r) => r.startsWith("v=DMARC1"))?.slice(0, 200) ?? null,
    }, { status: "observed", method: "public DNS resolution" });
  },
};

export const tlsExtractor: Extractor = {
  id: "tls",
  version: "1.0.0",
  description: "TLS handshake evidence: protocol, cipher, certificate subject/issuer/validity/fingerprint.",
  kinds: "all",
  categories: [C.network, C.integrity, C.access_security],
  needsNetwork: true,
  timeoutMs: 5000,
  async run(ctx) {
    const url = new URL(ctx.response.finalUrl);
    if (ctx.sourceType !== "url" || url.protocol !== "https:") return;
    if (getEgressMode() !== "direct") {
      ctx.add(C.network, "tlsUnavailable", "TLS certificate inspection requires direct egress (proxy re-terminates TLS)", { status: "observed", method: "service config" });
      return;
    }
    const ip = await resolvePublic(url.hostname);
    const info = await new Promise<{ cert: PeerCertificate; protocol: string | null; cipher: string; authorized: boolean; authError: string | null; alpn: string | false | null }>((resolve, reject) => {
      const sock = tlsConnect({ host: ip, port: Number(url.port || 443), servername: url.hostname, ALPNProtocols: ["h2", "http/1.1"], timeout: 4000 }, () => {
        resolve({ cert: sock.getPeerCertificate(), protocol: sock.getProtocol(), cipher: sock.getCipher().name, authorized: sock.authorized, authError: sock.authorizationError ? String(sock.authorizationError) : null, alpn: sock.alpnProtocol });
        sock.end();
      });
      sock.on("error", reject);
      sock.on("timeout", () => {
        sock.destroy();
        reject(new Error("tls timeout"));
      });
    });
    const c = info.cert;
    const tls = {
      protocol: info.protocol,
      cipher: info.cipher,
      alpn: info.alpn || null,
      chainTrusted: info.authorized,
      trustError: info.authError,
      subject: c.subject?.CN ?? null,
      issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(" / ") || null,
      validFrom: normalizeDate(c.valid_from)?.iso ?? c.valid_from,
      validTo: normalizeDate(c.valid_to)?.iso ?? c.valid_to,
      subjectAltNames: (c.subjectaltname ?? "").split(", ").slice(0, 20),
      fingerprint256: c.fingerprint256,
    };
    ctx.add(C.network, "tls", tls, { status: "observed", method: "tls handshake" });
    ctx.add(C.integrity, "tlsCertificate", { chainTrusted: info.authorized, issuer: tls.issuer, validTo: tls.validTo, fingerprint256: tls.fingerprint256 }, {
      status: "observed",
      method: "tls handshake",
      evidence: "proves the connection endpoint holds a certificate for the host, not that content is trustworthy",
    });
    if (tls.validTo) {
      const days = Math.round((Date.parse(tls.validTo) - Date.now()) / 86400_000);
      ctx.add(C.access_security, "certificateDaysRemaining", days, { status: "observed", method: "tls validTo − now" });
    }
  },
};

export const archiveExtractor: Extractor = {
  id: "wayback",
  version: "1.0.0",
  description: "Internet Archive CDX lookup: first/last capture and capture sample size.",
  kinds: "all",
  categories: [C.preservation, C.version, C.temporal],
  needsNetwork: true,
  timeoutMs: 6000,
  async run(ctx) {
    if (ctx.sourceType !== "url") return;
    const target = ctx.response.finalUrl;
    const q = (extra: string) => `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&fl=timestamp,statuscode,digest${extra}`;
    const [firstRows, lastRows] = await Promise.all([
      safeFetchJson<string[][]>(q("&limit=1"), { timeoutMs: 5500 }).catch(() => null),
      safeFetchJson<string[][]>(q("&limit=-1"), { timeoutMs: 5500 }).catch(() => null),
    ]);
    if (!firstRows || !lastRows) {
      ctx.add(C.preservation, "archiveLookup", "unavailable", { status: "extraction_failed", method: "wayback cdx", evidence: "archive.org did not answer within budget" });
      return;
    }
    const first = firstRows[1]?.[0];
    const last = lastRows[1]?.[0];
    if (!first) {
      ctx.add(C.preservation, "archived", false, { status: "observed", method: "wayback cdx", evidence: "no captures for this exact URL" });
      return;
    }
    const f = normalizeDate(first)!;
    const l = normalizeDate(last ?? first)!;
    ctx.add(C.preservation, "archived", true, { status: "observed", method: "wayback cdx" });
    ctx.add(C.preservation, "archiveFirstCapture", f.iso, { status: "observed", method: "wayback cdx limit=1", original: first });
    ctx.add(C.preservation, "archiveLastCapture", l.iso, { status: "observed", method: "wayback cdx limit=-1", original: last });
    ctx.add(C.temporal, "firstArchived", f.iso, { status: "observed", method: "wayback cdx", original: first });
    ctx.relate("archived_as", `https://web.archive.org/web/${first}/${target}`, "earliest Wayback capture", "wayback cdx");
    if (last && last !== first) ctx.relate("archived_as", `https://web.archive.org/web/${last}/${target}`, "latest Wayback capture", "wayback cdx");
    const lastDigest = lastRows[1]?.[2];
    if (lastDigest) ctx.add(C.version, "archiveLastDigestSha1", lastDigest, { status: "observed", method: "wayback cdx digest (base32 SHA-1 of capture)" });
  },
};

/** For downloadable files: look for a published sidecar checksum and verify against the body. */
export const checksumVerifier: Extractor = {
  id: "checksum-verify",
  version: "1.0.0",
  description: "Fetches <url>.sha256 / .sha256sum / SHA256SUMS next to a file and verifies the SHA-256 digest.",
  kinds: ["pdf", "office", "image", "audio", "video", "archive", "binary", "csv", "json"],
  categories: [C.integrity],
  needsNetwork: true,
  timeoutMs: 6000,
  async run(ctx) {
    if (ctx.sourceType !== "url" || ctx.response.truncated) return;
    const url = new URL(ctx.response.finalUrl);
    url.search = "";
    const file = url.pathname.split("/").pop();
    if (!file) return;
    const computed = createHash("sha256").update(ctx.response.body).digest("hex");
    const dir = url.toString().slice(0, url.toString().lastIndexOf("/") + 1);
    const candidates = [`${url}.sha256`, `${url}.sha256sum`, `${dir}SHA256SUMS`];
    for (const cand of candidates) {
      const res = await safeFetch(cand, { maxBytes: 256 * 1024, timeoutMs: 3000 }).catch(() => null);
      if (!res || res.status !== 200) continue;
      const text = res.body.toString("utf8");
      const line = text.split(/\r?\n/).find((l) => l.includes(file)) ?? (text.trim().split(/\s+/).length <= 2 ? text.trim() : null);
      const declared = line?.match(/\b([a-f0-9]{64})\b/i)?.[1]?.toLowerCase();
      if (!declared) continue;
      ctx.add(C.integrity, "checksumVerification", { algorithm: "SHA-256", source: cand, declared, computed, match: declared === computed }, {
        status: "observed",
        method: "published checksum comparison",
        evidence: "match proves consistency with the published digest only; it does not authenticate the publisher",
      });
      return;
    }
    ctx.add(C.integrity, "checksumVerification", { algorithm: "SHA-256", computed, match: null, note: "no published checksum found at conventional locations" }, { status: "observed", method: "published checksum lookup" });
  },
};

/** Cross-source corroboration of DOI metadata against Crossref (an independent registry). */
export const crossrefCorroboration: Extractor = {
  id: "crossref",
  version: "1.0.0",
  phase: "enrich",
  description: "Compares page-declared DOI/title/date with the Crossref registry record.",
  kinds: ["webpage", "pdf", "text", "xml"],
  categories: [C.scientific, C.identifiers, C.descriptive],
  needsNetwork: true,
  timeoutMs: 6000,
  async run(ctx) {
    const doi = fieldValues(ctx, C.identifiers, "doi")[0] as string | undefined;
    if (!doi) return;
    const data = await safeFetchJson<{ message: Json }>(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { timeoutMs: 5500, headers: { "user-agent": "OmnispiderMetadataBot/2.0 (mailto:metadata-bot@users.noreply.github.com)" } }).catch(() => null);
    if (!data?.message) {
      ctx.add(C.identifiers, "doiRegistered", null, { status: "extraction_failed", method: "crossref works lookup", evidence: `no Crossref record or registry unavailable for ${doi}` });
      return;
    }
    const msg = data.message;
    const regTitle = clean(Array.isArray(msg.title) ? msg.title[0] : msg.title, 500);
    const pageTitles = fieldValues(ctx, C.descriptive, "title").map(String).concat(fieldValues(ctx, C.scientific, "citationTitle").map(String));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const agrees = regTitle ? pageTitles.some((t) => norm(t).includes(norm(regTitle)) || norm(regTitle).includes(norm(t))) : false;
    ctx.add(C.identifiers, "doiRegistered", true, { status: "corroborated", method: "crossref works lookup", evidence: `https://doi.org/${doi}` });
    ctx.add(C.scientific, "registryTitle", regTitle, {
      status: agrees ? "corroborated" : "contradicted",
      method: "crossref works lookup",
      evidence: agrees ? "page title agrees with Crossref record" : `page titles ${JSON.stringify(pageTitles.slice(0, 2))} differ from registry`,
    });
    ctx.add(C.scientific, "journal", clean(Array.isArray(msg["container-title"]) ? msg["container-title"][0] : null), { status: "corroborated", method: "crossref container-title" });
    ctx.add(C.scientific, "citations", typeof msg["is-referenced-by-count"] === "number" ? msg["is-referenced-by-count"] : null, { status: "source_declared", method: "crossref is-referenced-by-count" });
    ctx.add(C.provenance, "registryPublisher", clean(msg.publisher), { status: "source_declared", method: "crossref publisher" });
    const issued = (msg.issued as Json | undefined)?.["date-parts"] as number[][] | undefined;
    if (issued?.[0]?.[0]) ctx.add(C.scientific, "publicationDate", new Date(Date.UTC(issued[0][0], (issued[0][1] ?? 1) - 1, issued[0][2] ?? 1)).toISOString(), { status: "source_declared", method: "crossref issued", original: issued[0].join("-") });
    const refs = Array.isArray(msg.reference) ? (msg.reference as Json[]) : [];
    for (const r of refs.slice(0, 30)) if (typeof r.DOI === "string") ctx.relate("cites", `https://doi.org/${r.DOI.toLowerCase()}`, "Crossref reference list", "crossref reference", "source_declared");
    const lic = Array.isArray(msg.license) ? (msg.license as Json[])[0] : null;
    if (lic?.URL) ctx.add(C.rights, "licenseUrl", String(lic.URL), { status: "source_declared", method: "crossref license" });
  },
};

/** Public repository metadata & audit trail from GitHub's unauthenticated REST API. */
export const githubExtractor: Extractor = {
  id: "github",
  version: "1.0.0",
  description: "github.com/<owner>/<repo>: public repository stats, licence, topics, releases and recent commits.",
  kinds: ["webpage"],
  categories: [C.audit, C.usage, C.rights, C.version, C.social_annotation, C.temporal, C.descriptive],
  needsNetwork: true,
  timeoutMs: 6000,
  async run(ctx) {
    const u = new URL(ctx.response.finalUrl);
    const m = u.hostname === "github.com" && u.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
    if (!m) return;
    const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN_PUBLIC) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN_PUBLIC}`;
    const [info, commits, release] = await Promise.all([
      safeFetchJson<Json>(`https://api.github.com/repos/${repo}`, { timeoutMs: 5000, headers }).catch(() => null),
      safeFetchJson<Json[]>(`https://api.github.com/repos/${repo}/commits?per_page=5`, { timeoutMs: 5000, headers }).catch(() => null),
      safeFetchJson<Json>(`https://api.github.com/repos/${repo}/releases/latest`, { timeoutMs: 5000, headers }).catch(() => null),
    ]);
    if (!info) return;
    const api = { method: "api.github.com/repos" };
    ctx.add(C.usage, "stars", info.stargazers_count, api);
    ctx.add(C.usage, "forks", info.forks_count, api);
    ctx.add(C.usage, "watchers", info.subscribers_count, api);
    ctx.add(C.usage, "openIssues", info.open_issues_count, api);
    ctx.add(C.social_annotation, "tags", Array.isArray(info.topics) ? info.topics : [], { method: "github topics" });
    const lic = info.license as Json | null;
    if (lic?.spdx_id && lic.spdx_id !== "NOASSERTION") ctx.add(C.rights, "license", String(lic.spdx_id), { method: "github license (SPDX)" });
    ctx.add(C.descriptive, "description", clean(info.description), api);
    ctx.add(C.technical, "primaryLanguage", info.language, api);
    for (const [k, f] of [["created_at", "created"], ["pushed_at", "modified"]] as const) {
      const d = normalizeDate(info[k]);
      if (d) ctx.add(C.temporal, f, d.iso, { method: `github ${k}`, original: d.original });
    }
    ctx.add(C.administrative, "status", info.archived ? "archived" : "active", api);
    if (release?.tag_name) {
      ctx.add(C.version, "latestRelease", String(release.tag_name), { method: "github releases/latest" });
      const d = normalizeDate(release.published_at);
      if (d) ctx.add(C.version, "latestReleaseDate", d.iso, { method: "github releases/latest" });
    }
    if (Array.isArray(commits)) {
      const list = commits.map((c) => {
        const commit = c.commit as Json;
        return { sha: String(c.sha).slice(0, 12), date: normalizeDate((commit.committer as Json)?.date)?.iso ?? null, message: clean(String(commit.message).split("\n")[0], 140) };
      });
      ctx.add(C.audit, "recentCommits", list, { status: "observed", method: "github commits API (public history)" });
      if (list[0]?.date) ctx.add(C.audit, "lastCommitAt", list[0].date, { status: "observed", method: "github commits API" });
    }
    if (info.parent && typeof info.parent === "object") ctx.relate("derived_from", String((info.parent as Json).html_url), "GitHub fork parent", "github api parent");
  },
};

export const huggingFaceExtractor: Extractor = {
  id: "huggingface",
  version: "1.0.0",
  description: "huggingface.co/<org>/<model>: model card data, downloads, likes, pipeline, library, base model and datasets.",
  kinds: ["webpage"],
  categories: [C.ai_ml, C.usage, C.lineage, C.rights, C.version],
  needsNetwork: true,
  timeoutMs: 6000,
  async run(ctx) {
    const u = new URL(ctx.response.finalUrl);
    if (u.hostname !== "huggingface.co") return;
    const m = u.pathname.match(/^\/(datasets\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/);
    if (!m) return;
    const kind = m[1] ? "datasets" : "models";
    const info = await safeFetchJson<Json>(`https://huggingface.co/api/${kind}/${m[2]}`, { timeoutMs: 5000 }).catch(() => null);
    if (!info) return;
    const api = { method: `huggingface.co/api/${kind}` };
    const card = (info.cardData ?? {}) as Json;
    ctx.add(C.ai_ml, "pipelineTag", info.pipeline_tag, api);
    ctx.add(C.ai_ml, "libraryName", info.library_name, api);
    ctx.add(C.ai_ml, "modelId", info.id ?? info.modelId, api);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
    ctx.add(C.ai_ml, "datasets", arr(card.datasets), api);
    ctx.add(C.ai_ml, "baseModel", arr(card.base_model), api);
    ctx.add(C.ai_ml, "metrics", arr(card.metrics), api);
    ctx.add(C.lineage, "baseModel", arr(card.base_model), api);
    ctx.add(C.usage, "downloads", info.downloads, { ...api, evidence: "public counter (last 30 days per HF)" });
    ctx.add(C.usage, "likes", info.likes, api);
    if (card.license) ctx.add(C.rights, "license", String(card.license), api);
    ctx.add(C.version, "revision", info.sha, api);
    const d = normalizeDate(info.lastModified);
    if (d) ctx.add(C.temporal, "modified", d.iso, { ...api, original: d.original });
    const cfg = info.config as Json | undefined;
    if (cfg) {
      ctx.add(C.ai_ml, "architectures", arr(cfg.architectures), api);
      ctx.add(C.ai_ml, "modelType", cfg.model_type, api);
    }
    ctx.add(C.ai_ml, "gated", info.gated ?? false, { ...api, evidence: "gated repositories require approved access; not bypassed" });
    ctx.add(C.access_security, "gated", info.gated ? true : false, api);
  },
};

/** PyPI / npm package pages → registry JSON (versions, licence, dependencies, maintainers' orgs). */
export const packageRegistryExtractor: Extractor = {
  id: "package-registry",
  version: "1.0.0",
  description: "pypi.org/project/<p> and npmjs.com/package/<p>: registry JSON for versions, release history, licence and declared dependencies.",
  kinds: ["webpage"],
  categories: [C.version, C.rights, C.lineage, C.audit, C.integrity, C.temporal, C.descriptive],
  needsNetwork: true,
  timeoutMs: 6000,
  async run(ctx) {
    const u = new URL(ctx.response.finalUrl);
    const py = u.hostname === "pypi.org" && u.pathname.match(/^\/project\/([A-Za-z0-9_.-]+)\/?(?:([^/]+)\/?)?$/);
    const npm = /(^|\.)npmjs\.com$/.test(u.hostname) && u.pathname.match(/^\/package\/((?:@[^/]+\/)?[^/]+)\/?$/);
    if (py) {
      const data = await safeFetchJson<{ info: Json; releases: Record<string, Json[]>; urls: Json[] }>(`https://pypi.org/pypi/${py[1]}/json`, { timeoutMs: 5000 }).catch(() => null);
      if (!data) return;
      const i = data.info;
      const m = { method: "pypi json api" };
      ctx.add(C.version, "latestRelease", i.version, m);
      ctx.add(C.rights, "license", clean(i.license_expression ?? i.license, 120), m);
      ctx.add(C.descriptive, "description", clean(i.summary), m);
      ctx.add(C.descriptive, "keywords", typeof i.keywords === "string" ? i.keywords.split(/[,\s]+/).filter(Boolean).slice(0, 30) : [], m);
      ctx.add(C.lineage, "dependencies", Array.isArray(i.requires_dist) ? i.requires_dist.slice(0, 60) : [], { method: "pypi requires_dist" });
      ctx.add(C.technical, "requiresPython", i.requires_python, m);
      const history = Object.entries(data.releases)
        .map(([v, files]) => ({ version: v, date: normalizeDate(files[0]?.upload_time_iso_8601)?.iso ?? null, files: files.length }))
        .filter((r) => r.date)
        .sort((a, b) => (a.date! < b.date! ? 1 : -1));
      ctx.add(C.audit, "releaseHistory", history.slice(0, 15), { status: "observed", method: "pypi releases" });
      ctx.add(C.version, "releaseCount", history.length, { status: "observed", method: "pypi releases" });
      if (history[0]?.date) ctx.add(C.temporal, "modified", history[0].date, { method: "latest pypi release upload" });
      const digests = (data.urls ?? []).map((f) => ({ file: f.filename, sha256: (f.digests as Json)?.sha256 })).slice(0, 10);
      ctx.add(C.integrity, "publishedChecksums", digests, { method: "pypi file digests", evidence: "registry-published SHA-256 per distribution file" });
      const urls = (i.project_urls ?? {}) as Record<string, string>;
      for (const [label, link] of Object.entries(urls).slice(0, 10)) ctx.relate("references", link, `project_urls.${label}`, "pypi project_urls");
      return;
    }
    if (npm) {
      const data = await safeFetchJson<Json>(`https://registry.npmjs.org/${npm[1].replace("/", "%2F")}`, { timeoutMs: 5000 }).catch(() => null);
      if (!data) return;
      const tags = (data["dist-tags"] ?? {}) as Record<string, string>;
      const latest = ((data.versions ?? {}) as Record<string, Json>)[tags.latest] ?? {};
      const m = { method: "npm registry" };
      ctx.add(C.version, "latestRelease", tags.latest, m);
      ctx.add(C.rights, "license", typeof latest.license === "string" ? latest.license : clean(data.license), m);
      ctx.add(C.descriptive, "description", clean(data.description), m);
      ctx.add(C.lineage, "dependencies", Object.entries((latest.dependencies ?? {}) as Record<string, string>).slice(0, 80).map(([k, v]) => `${k}@${v}`), { method: "npm dependencies (latest)" });
      const time = (data.time ?? {}) as Record<string, string>;
      const history = Object.entries(time).filter(([k]) => k !== "created" && k !== "modified").sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 15).map(([version, date]) => ({ version, date }));
      ctx.add(C.audit, "releaseHistory", history, { status: "observed", method: "npm time" });
      const dist = (latest.dist ?? {}) as Json;
      if (dist.integrity) ctx.add(C.integrity, "publishedChecksums", [{ file: `${npm[1]}-${tags.latest}.tgz`, integrity: dist.integrity }], { method: "npm dist.integrity (SRI)" });
      const d = normalizeDate(time.modified);
      if (d) ctx.add(C.temporal, "modified", d.iso, { ...m, original: d.original });
    }
  },
};
