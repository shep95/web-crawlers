import { gunzipSync } from "node:zlib";
import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { listZipEntries, readZipEntry, type ZipEntryInfo } from "../zip.js";

const MAX_ENTRY = 5 * 1024 * 1024;
const MAX_GUNZIP = 64 * 1024 * 1024;
const MAX_NESTED = 8;
const INSPECTABLE = /\.(csv|tsv|json|xml|txt|md|pdf|jpe?g|png|tiff?|docx|xlsx|pptx|odt|eml|cff|ya?ml)$/i;
const MANIFEST = /(^|\/)(manifest-(sha256|sha512|md5)\.txt|bagit\.txt|bag-info\.txt|datapackage\.json|SHA256SUMS|CHECKSUMS?(\.txt)?|README(\.md|\.txt)?|CITATION\.cff|LICENSE(\.txt|\.md)?)$/i;

export interface NestedEntry {
  name: string;
  size: number;
  body: Buffer;
}

interface Entry {
  name: string;
  size: number;
  compressed: number | null;
  read: () => Buffer;
}

function tarEntries(buf: Buffer): Entry[] {
  const out: Entry[] = [];
  let p = 0;
  while (p + 512 <= buf.length && out.length < 5000) {
    const name = buf.subarray(p, p + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(buf.subarray(p + 124, p + 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(buf[p + 156] || 48);
    const prefix = buf.subarray(p + 345, p + 500).toString("utf8").replace(/\0.*$/s, "");
    const start = p + 512;
    if (type === "0" || type === "\0") out.push({ name: prefix ? `${prefix}/${name}` : name, size, compressed: null, read: () => buf.subarray(start, start + Math.min(size, MAX_ENTRY)) });
    p = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * Archives: list contents, detect preservation manifests (BagIt, checksum lists,
 * datapackage), and hand small supported entries to the crawler for full
 * inspection as contained resources. Nothing is executed; inflation is capped.
 */
export const archiveExtractor: Extractor = {
  id: "archive",
  version: "1.0.0",
  description: "ZIP / TAR / TAR.GZ: entry listing, compression ratios, BagIt & checksum manifests, nested inspectable entries (capped, depth 1).",
  kinds: ["archive"],
  categories: [C.structural, C.file_system, C.preservation, C.integrity, C.technical],
  timeoutMs: 6000,
  async run(ctx) {
    let body = ctx.response.body;
    let format = "zip";
    if (body[0] === 0x1f && body[1] === 0x8b) {
      try {
        body = gunzipSync(body, { maxOutputLength: MAX_GUNZIP });
      } catch (err) {
        ctx.add(C.technical, "decompression", `gzip stream exceeds ${MAX_GUNZIP} bytes or is corrupt: ${(err as Error).message.slice(0, 80)}`, { status: "extraction_failed", method: "gunzip (capped)" });
        return;
      }
      format = body.subarray(257, 262).toString("latin1") === "ustar" ? "tar.gz" : "gzip";
    } else if (body.subarray(257, 262).toString("latin1") === "ustar") format = "tar";
    ctx.add(C.technical, "archiveFormat", format, { status: "observed", method: "magic bytes" });
    let entries: Entry[];
    if (format === "zip") {
      const zipEntries = listZipEntries(body);
      entries = zipEntries.filter((e) => !e.name.endsWith("/")).map((e: ZipEntryInfo) => ({ name: e.name, size: e.uncompressedSize, compressed: e.compressedSize, read: () => readZipEntry(body, e, MAX_ENTRY) }));
    } else if (format === "gzip") {
      ctx.add(C.file_system, "decompressedBytes", body.length, { status: "observed", method: "gunzip (capped)" });
      return;
    } else entries = tarEntries(body);

    const total = entries.reduce((a, e) => a + e.size, 0);
    ctx.add(C.structural, "entryCount", entries.length, { status: "observed", method: `${format} directory` });
    ctx.add(C.structural, "entries", entries.slice(0, 100).map((e) => ({ name: e.name, size: e.size })), { method: `${format} directory`, evidence: entries.length > 100 ? `first 100 of ${entries.length}` : undefined });
    ctx.add(C.file_system, "declaredUncompressedBytes", total, { method: `${format} directory sizes` });
    const ratio = entries.filter((e) => e.compressed).map((e) => e.size / Math.max(1, e.compressed!));
    if (ratio.length) ctx.add(C.technical, "maxCompressionRatio", Number(Math.max(...ratio).toFixed(1)), { status: "observed", method: "uncompressed ÷ compressed per entry" });
    const dirs = new Set(entries.map((e) => e.name.split("/").slice(0, -1).join("/")).filter(Boolean));
    ctx.add(C.structural, "directoryCount", dirs.size, { status: "observed", method: "entry paths" });
    const exts = new Map<string, number>();
    for (const e of entries) {
      const x = e.name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "(none)";
      exts.set(x, (exts.get(x) ?? 0) + 1);
    }
    ctx.add(C.file_system, "extensions", Object.fromEntries([...exts].sort((a, b) => b[1] - a[1]).slice(0, 20)), { status: "observed", method: "entry names" });

    const manifests = entries.filter((e) => MANIFEST.test(e.name));
    ctx.add(C.preservation, "manifests", manifests.map((m) => m.name), { method: "manifest file names" });
    if (manifests.some((m) => /bagit\.txt$/i.test(m.name))) ctx.add(C.preservation, "packaging", "BagIt", { method: "bagit.txt present" });
    const nested: NestedEntry[] = [];
    for (const m of manifests.filter((x) => /manifest-sha256|SHA256SUMS|CHECKSUM/i.test(x.name)).slice(0, 2)) {
      try {
        const text = m.read().toString("utf8");
        const declared = [...text.matchAll(/^([a-f0-9]{64})\s+\*?(.+)$/gim)].map((x) => ({ sha256: x[1].toLowerCase(), file: x[2].trim() }));
        ctx.add(C.integrity, "publishedChecksums", declared.slice(0, 100), { method: `${m.name}`, evidence: `${declared.length} declared digests` });
      } catch {
        /* unreadable manifest */
      }
    }
    for (const e of entries.filter((x) => INSPECTABLE.test(x.name) || MANIFEST.test(x.name)).slice(0, MAX_NESTED)) {
      if (e.size > MAX_ENTRY) continue;
      try {
        nested.push({ name: e.name, size: e.size, body: e.read() });
      } catch {
        ctx.add(C.structural, "unreadableEntry", e.name, { status: "extraction_failed", method: "capped inflate" });
      }
    }
    ctx.shared.set("archiveEntries", nested);
  },
};
