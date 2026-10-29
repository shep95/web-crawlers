import { createHash } from "node:crypto";
import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { normalizeDate } from "../normalize.js";

const SECURITY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
];

export const httpExtractor: Extractor = {
  id: "http",
  version: "1.0.0",
  description: "Transport-level metadata from the fetch trace and response headers.",
  kinds: "all",
  categories: [C.technical, C.provenance, C.temporal, C.operational, C.access_security, C.integrity, C.file_system, C.version, C.discovery, C.network, C.preservation, C.privacy],
  timeoutMs: 1000,
  async run(ctx) {
    const r = ctx.response;
    const h = r.headers;
    const hdr = (name: string) => ({ method: `http.header:${name}`, evidence: `${name}: ${h[name]}` });
    const observed = { status: "observed" as const };

    // ---- technical
    const mime = h["content-type"]?.split(";")[0].trim().toLowerCase() ?? null;
    if (ctx.sourceType === "url") {
      ctx.add(C.technical, "httpStatus", r.status, { ...observed, method: "http.status" });
      ctx.add(C.technical, "mimeType", mime, { ...hdr("content-type") });
      const charset = /charset=["']?([\w-]+)/i.exec(h["content-type"] ?? "")?.[1];
      ctx.add(C.technical, "charset", charset?.toLowerCase(), hdr("content-type"));
      ctx.add(C.technical, "contentEncoding", h["content-encoding"], hdr("content-encoding"));
      ctx.add(C.technical, "server", h.server, hdr("server"));
      ctx.add(C.technical, "poweredBy", h["x-powered-by"], hdr("x-powered-by"));
      if (h["content-length"]) ctx.add(C.technical, h["content-encoding"] ? "encodedContentLength" : "contentLength", Number(h["content-length"]), hdr("content-length"));
      if (h["content-encoding"] && r.encodedBytes > 0 && r.body.length > 0 && !r.truncated) {
        ctx.add(C.technical, "compressionRatio", Number((r.body.length / r.encodedBytes).toFixed(2)), {
          ...observed,
          method: "decoded/encoded bytes",
          evidence: `${r.encodedBytes} wire bytes → ${r.body.length} decoded`,
        });
      }
    }
    ctx.add(C.technical, "sniffedType", ctx.sniffedType, { ...observed, method: "magic-bytes" });
    ctx.add(C.technical, "bodyBytes", r.body.length, { ...observed, method: "byte count", evidence: r.truncated ? "body truncated at cap" : undefined });

    // ---- provenance
    if (ctx.sourceType === "url") {
      ctx.add(C.provenance, "requestedUrl", r.requestedUrl, { ...observed, method: "fetch trace" });
      ctx.add(C.provenance, "finalUrl", r.finalUrl, { ...observed, method: "fetch trace" });
      if (r.redirects.length) {
        ctx.add(C.provenance, "redirectChain", r.redirects.map((x) => ({ from: x.url, status: x.status, to: x.location })), { ...observed, method: "fetch trace" });
      }
    } else {
      ctx.add(C.provenance, "uploadedFilename", ctx.filename ?? null, { ...observed, method: "user upload" });
    }
    ctx.add(C.provenance, "retrievedAt", r.timings.startedAt, { ...observed, method: "service clock" });

    // ---- temporal
    for (const [name, field] of [["last-modified", "lastModifiedHeader"], ["date", "serverDate"], ["expires", "expires"]] as const) {
      const d = normalizeDate(h[name]);
      if (d) ctx.add(C.temporal, field, d.iso, { ...hdr(name), original: d.original });
    }
    ctx.add(C.temporal, "retrievedAt", r.timings.startedAt, { ...observed, method: "service clock" });

    // ---- operational
    if (ctx.sourceType === "url") {
      ctx.add(C.operational, "available", r.status >= 200 && r.status < 400, { ...observed, method: "http.status" });
      ctx.add(C.operational, "ttfbMs", r.timings.ttfbMs, { ...observed, method: "fetch timing" });
      ctx.add(C.operational, "totalMs", r.timings.totalMs, { ...observed, method: "fetch timing" });
      if (h.age) ctx.add(C.operational, "age", Number(h.age), hdr("age"));
      const cacheStatus = h["cf-cache-status"] ?? h["x-cache"] ?? h["x-cache-status"] ?? h["cache-status"];
      if (cacheStatus) ctx.add(C.operational, "cacheStatus", cacheStatus, { method: "http.header:cache-status", evidence: cacheStatus });
    }

    // ---- access & security
    if (ctx.sourceType === "url") {
      const authRequired = r.status === 401 || r.status === 407 || Boolean(h["www-authenticate"]);
      ctx.add(C.access_security, "accessRequiresAuth", authRequired, { ...observed, method: "http.status/www-authenticate", evidence: `status ${r.status}` });
      if (r.status === 403 || r.status === 451) {
        ctx.add(C.access_security, "accessDenied", { status: r.status }, { ...observed, method: "http.status" });
      }
      const present: Record<string, string> = {};
      for (const name of SECURITY_HEADERS) if (h[name]) present[name] = h[name].slice(0, 200);
      ctx.add(C.access_security, "securityHeaders", present, { ...observed, method: "http.headers" });
      const missing = SECURITY_HEADERS.filter((n) => !h[n]);
      ctx.add(C.access_security, "missingSecurityHeaders", missing, { ...observed, method: "http.headers" });
      ctx.add(C.access_security, "cacheControl", h["cache-control"], hdr("cache-control"));
      ctx.add(C.access_security, "transportEncrypted", r.finalUrl.startsWith("https:"), { ...observed, method: "final url scheme" });
    }

    // ---- version
    ctx.add(C.version, "etag", h.etag, hdr("etag"));

    // ---- discovery
    ctx.add(C.discovery, "xRobotsTag", h["x-robots-tag"], hdr("x-robots-tag"));
    if (h.link) {
      for (const part of h.link.split(/,(?=\s*<)/)) {
        const m = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/i);
        if (!m) continue;
        const target = new URL(m[1], r.finalUrl).toString();
        const rel = m[2].toLowerCase();
        if (rel === "canonical") ctx.relate("canonical", target, part.trim(), "http.header:link");
        else if (rel === "alternate") ctx.relate("alternate_format", target, part.trim(), "http.header:link");
        else if (rel === "license") ctx.relate("licensed_under", target, part.trim(), "http.header:link");
      }
    }

    // ---- network
    if (ctx.sourceType === "url") {
      ctx.add(C.network, "remoteAddress", r.remoteAddress, { ...observed, method: "guarded dns lookup" });
      ctx.add(C.network, "egress", r.egress, { ...observed, method: "service config" });
      ctx.add(C.network, "redirectCount", r.redirects.length, { ...observed, method: "fetch trace" });
      ctx.add(C.network, "altSvc", h["alt-svc"]?.slice(0, 200), hdr("alt-svc"));
      if (h["alt-svc"]) ctx.add(C.network, "http3Advertised", /h3/.test(h["alt-svc"]), hdr("alt-svc"));
    }

    // ---- preservation (Memento)
    const memento = normalizeDate(h["memento-datetime"]);
    if (memento) ctx.add(C.preservation, "mementoDatetime", memento.iso, { ...hdr("memento-datetime"), original: memento.original });

    // ---- privacy
    if (h["set-cookie"]) {
      ctx.add(C.privacy, "setsCookies", true, { ...observed, method: "http.header:set-cookie", evidence: `${h["set-cookie"].split(/,(?=[^;]+=)/).length} cookie(s); values not recorded` });
    }

    // ---- integrity
    const sha256 = createHash("sha256").update(r.body).digest("hex");
    const integrityNote = r.truncated ? "hash of truncated body prefix" : undefined;
    ctx.add(C.integrity, "sha256", sha256, { ...observed, method: "sha256(body)", evidence: integrityNote });
    ctx.add(C.preservation, "sha256", sha256, { ...observed, method: "sha256(body)", evidence: integrityNote });
    if (h["content-md5"] && !r.truncated) {
      const md5 = createHash("md5").update(r.body).digest("base64");
      ctx.add(C.integrity, "headerDigestMatch", md5 === h["content-md5"], { ...observed, method: "content-md5 verification", evidence: `declared ${h["content-md5"]} computed ${md5}` });
    }
    const digest = h["repr-digest"] ?? h.digest;
    const sha256Decl = digest?.match(/sha-256=:?([A-Za-z0-9+/=]+):?/i)?.[1];
    if (sha256Decl && !r.truncated && !h["content-encoding"]) {
      const b64 = createHash("sha256").update(r.body).digest("base64");
      ctx.add(C.integrity, "headerDigestMatch", b64 === sha256Decl, { ...observed, method: "repr-digest verification", evidence: `declared ${sha256Decl}` });
    }

    // ---- file system
    const disposition = h["content-disposition"];
    const dispName = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    const pathName = ctx.filename ?? decodeURIComponent(new URL(r.finalUrl).pathname.split("/").pop() ?? "");
    const filename = dispName ? decodeURIComponent(dispName) : pathName || null;
    ctx.add(C.file_system, "filename", filename, { method: dispName ? "http.header:content-disposition" : ctx.sourceType === "upload" ? "upload filename" : "url path" });
    const ext = filename?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
    ctx.add(C.file_system, "extension", ext, { method: "filename" });
    // Content-Length describes the *encoded* entity when Content-Encoding is set.
    const declaredLen = h["content-length"] && !h["content-encoding"] ? Number(h["content-length"]) : null;
    ctx.add(C.file_system, "sizeBytes", declaredLen ?? (r.truncated ? null : r.body.length), {
      status: declaredLen !== null ? "source_declared" : "observed",
      method: declaredLen !== null ? "http.header:content-length" : "decoded byte count",
    });
    const lm = normalizeDate(h["last-modified"]);
    if (lm) ctx.add(C.file_system, "serverModified", lm.iso, { ...hdr("last-modified"), original: lm.original });
  },
};
