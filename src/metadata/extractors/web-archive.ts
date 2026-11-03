import { gunzipSync } from "node:zlib";
import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { normalizeDate } from "../normalize.js";

const MAX_INFLATE = 64 * 1024 * 1024;
const MAX_RECORDS = 5000;
const OUT_RECORDS = 100;
const MAX_RELATIONS = 50;

export interface WarcRecord {
  type: string;
  uri: string | null;
  date: string | null;
  contentType: string | null;
  length: number;
  httpStatus: number | null;
  httpContentType: string | null;
  payloadDigest: string | null;
  headers: Record<string, string>;
  body: Buffer;
}

function httpHead(body: Buffer): { status: number | null; contentType: string | null } {
  const head = body.subarray(0, 8192).toString("latin1");
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
  const end = head.search(/\r?\n\r?\n/);
  const ct = /\ncontent-type:\s*([^\r\n;]+)/i.exec(end > 0 ? head.slice(0, end) : head);
  return { status: status ? Number(status[1]) : null, contentType: ct ? ct[1].trim().toLowerCase() : null };
}

/** Iterate WARC 1.0/1.1 records (warcio-style header block + Content-Length body). Throws on a malformed record header. */
export function warcRecords(buf: Buffer, max = MAX_RECORDS): { records: WarcRecord[]; truncated: boolean; error: string | null } {
  const records: WarcRecord[] = [];
  let p = 0;
  while (p < buf.length && records.length < max) {
    while (p < buf.length && (buf[p] === 0x0d || buf[p] === 0x0a)) p++;
    if (p >= buf.length) break;
    const sep = buf.indexOf("\r\n\r\n", p, "latin1");
    const sepLf = sep < 0 ? buf.indexOf("\n\n", p, "latin1") : -1;
    const hEnd = sep >= 0 ? sep : sepLf;
    if (hEnd < 0 || hEnd - p > 64 * 1024) return { records, truncated: true, error: hEnd < 0 ? "record header not terminated (truncated)" : "record header larger than 64 KiB" };
    const lines = buf.subarray(p, hEnd).toString("utf8").split(/\r?\n/);
    if (!/^WARC\/1\.\d/.test(lines[0])) return { records, truncated: false, error: `expected WARC/1.x at offset ${p}, found ${JSON.stringify(lines[0].slice(0, 20))}` };
    const headers: Record<string, string> = { version: lines[0].trim() };
    for (const l of lines.slice(1)) {
      const i = l.indexOf(":");
      if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    const len = Number(headers["content-length"]);
    if (!Number.isFinite(len) || len < 0) return { records, truncated: false, error: `record at offset ${p} lacks a valid Content-Length` };
    const start = hEnd + (sep >= 0 ? 4 : 2);
    const body = buf.subarray(start, Math.min(buf.length, start + len));
    const type = headers["warc-type"] ?? "unknown";
    const http = type === "response" || type === "revisit" ? httpHead(body) : { status: null, contentType: null };
    records.push({ type, uri: (headers["warc-target-uri"] ?? "").replace(/^<|>$/g, "") || null, date: headers["warc-date"] ?? null, contentType: headers["content-type"] ?? null, length: len, httpStatus: http.status, httpContentType: http.contentType, payloadDigest: headers["warc-payload-digest"] ?? null, headers, body });
    if (start + len > buf.length) return { records, truncated: true, error: null };
    p = start + len;
  }
  return { records, truncated: records.length >= max, error: null };
}

/** Legacy ARC v1: "URL IP-address Archive-date Content-type Archive-length" header lines. */
export function arcRecords(buf: Buffer, max = MAX_RECORDS): { records: WarcRecord[]; truncated: boolean; error: string | null } {
  const records: WarcRecord[] = [];
  let p = 0;
  while (p < buf.length && records.length < max) {
    while (p < buf.length && (buf[p] === 0x0a || buf[p] === 0x0d)) p++;
    if (p >= buf.length) break;
    const nl = buf.indexOf(0x0a, p);
    if (nl < 0) return { records, truncated: true, error: "record header not terminated" };
    const parts = buf.subarray(p, nl).toString("utf8").trim().split(/\s+/);
    if (parts.length < 5) return { records, truncated: false, error: `malformed ARC header at offset ${p}` };
    const len = Number(parts[parts.length - 1]);
    if (!Number.isFinite(len)) return { records, truncated: false, error: `ARC header at offset ${p} lacks a length` };
    const body = buf.subarray(nl + 1, Math.min(buf.length, nl + 1 + len));
    const isDesc = parts[0].startsWith("filedesc://");
    const http = isDesc ? { status: null, contentType: null } : httpHead(body);
    const date = /^\d{14}$/.test(parts[2]) ? parts[2] : null;
    records.push({ type: isDesc ? "filedesc" : "response", uri: parts[0], date, contentType: parts[3], length: len, httpStatus: http.status, httpContentType: http.contentType ?? parts[3], payloadDigest: null, headers: {}, body });
    if (nl + 1 + len > buf.length) return { records, truncated: true, error: null };
    p = nl + 1 + len;
  }
  return { records, truncated: records.length >= max, error: null };
}

/** WARC / ARC web archives: record inventory, captured responses (URI, date, status, type) as bounded child references. */
export const webArchiveExtractor: Extractor = {
  id: "web-archive",
  version: "1.0.0",
  description: "WARC 1.0/1.1 and ARC v1 (plain or gzip): record types, warcinfo software, captured responses (URI, date, HTTP status, content type), capture date range, digests.",
  kinds: ["archive", "text"],
  formats: ["warc", "arc"],
  categories: [C.structural, C.preservation, C.temporal, C.provenance, C.relational, C.technical, C.integrity],
  timeoutMs: 5000,
  async run(ctx) {
    let buf = ctx.response.body;
    let inflateTruncated = false;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        buf = gunzipSync(buf, { maxOutputLength: MAX_INFLATE });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") {
          ctx.add(C.structural, "records", `gzip stream corrupt: ${(err as Error).message.slice(0, 80)}`, { status: "extraction_failed", method: "gunzip" });
          return;
        }
        // Too big to inflate whole: inspect the bounded prefix only.
        const { gunzipPrefix } = await import("../formats.js");
        buf = gunzipPrefix(ctx.response.body, 8 * 1024 * 1024, MAX_INFLATE) ?? Buffer.alloc(0);
        inflateTruncated = true;
      }
    }
    const parsed = ctx.format === "arc" ? arcRecords(buf) : warcRecords(buf);
    const { records } = parsed;
    if (!records.length) {
      ctx.add(C.structural, "records", parsed.error ?? "no records", { status: "extraction_failed", method: `${ctx.format} record parser` });
      return;
    }
    const o = { status: "observed" as const, method: `${ctx.format.toUpperCase()} record headers` };
    ctx.add(C.preservation, "packaging", ctx.format === "arc" ? "ARC (Internet Archive v1)" : records[0].headers.version ?? "WARC", o);
    ctx.add(C.structural, "recordCount", records.length, { ...o, evidence: parsed.truncated || inflateTruncated ? "listing incomplete (record/byte limit or truncated body)" : undefined });
    const types: Record<string, number> = {};
    for (const r of records) types[r.type] = (types[r.type] ?? 0) + 1;
    ctx.add(C.structural, "recordTypes", types, o);
    if (parsed.error) ctx.add(C.quality, "recordParseError", parsed.error, { status: "extraction_failed", method: `${ctx.format} record parser`, evidence: `${records.length} records read before the error` });
    if (parsed.truncated || inflateTruncated || ctx.response.truncated) ctx.add(C.quality, "archiveTruncated", true, { status: "observed", method: "record/byte limits" });

    const info = records.find((r) => r.type === "warcinfo");
    if (info) {
      const fields: Record<string, string> = {};
      for (const line of info.body.subarray(0, 16 * 1024).toString("utf8").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) fields[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      if (fields.software) ctx.add(C.provenance, "crawlerSoftware", fields.software, { method: "warcinfo software", evidence: "declared by the archive's producer" });
      if (fields.operator) ctx.add(C.provenance, "operator", fields.operator, { method: "warcinfo operator" });
      if (fields.ispartof) ctx.add(C.relational, "isPartOf", fields.ispartof, { method: "warcinfo isPartOf" });
      if (fields.format) ctx.add(C.preservation, "formatDeclaration", fields.format, { method: "warcinfo format" });
      if (fields.robots) ctx.add(C.preservation, "robotsPolicy", fields.robots, { method: "warcinfo robots" });
    }
    const filedesc = records.find((r) => r.type === "filedesc");
    if (filedesc) ctx.add(C.provenance, "arcFiledesc", filedesc.uri, { method: "ARC filedesc record" });

    const responses = records.filter((r) => (r.type === "response" || r.type === "revisit") && r.uri);
    const captured = responses.slice(0, OUT_RECORDS).map((r) => {
      const d = normalizeDate(r.date);
      return { uri: r.uri, date: d?.iso ?? r.date, status: r.httpStatus, contentType: r.httpContentType, recordType: r.type, length: r.length };
    });
    ctx.add(C.structural, "capturedResponses", captured, { ...o, evidence: responses.length > OUT_RECORDS ? `first ${OUT_RECORDS} of ${responses.length}` : undefined });
    ctx.add(C.structural, "capturedResponseCount", responses.length, o);
    const ctypes: Record<string, number> = {};
    for (const r of responses) if (r.httpContentType) ctypes[r.httpContentType] = (ctypes[r.httpContentType] ?? 0) + 1;
    ctx.add(C.technical, "capturedContentTypes", ctypes, o);
    const dates = records.map((r) => normalizeDate(r.date)?.iso).filter((x): x is string => Boolean(x)).sort();
    if (dates.length) {
      ctx.add(C.temporal, "captureStart", dates[0], { ...o, evidence: "earliest record date (capture time, not publication time)" });
      ctx.add(C.temporal, "captureEnd", dates[dates.length - 1], { ...o, evidence: "latest record date" });
    }
    const digests = records.filter((r) => r.payloadDigest).length;
    if (digests) ctx.add(C.integrity, "payloadDigestsDeclared", digests, { method: "WARC-Payload-Digest headers", evidence: "declared digests, not re-verified" });
    for (const r of responses.slice(0, MAX_RELATIONS)) {
      if (r.uri && /^https?:\/\//.test(r.uri)) ctx.relate("references", r.uri, `captured ${r.date ?? "?"} HTTP ${r.httpStatus ?? "?"} ${r.httpContentType ?? ""}`.trim(), `${ctx.format} response record`, "observed");
    }
  },
};
