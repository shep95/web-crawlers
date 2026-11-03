import { gunzipSync } from "node:zlib";
import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { detectFormat, extensionOf, FORMAT_BY_ID, FORMATS } from "../formats.js";
import { listZipEntries, readZipEntry } from "../zip.js";

/** Hard limits for archive enumeration (all levels combined). Overridable by env for operators. */
export const ARCHIVE_LIMITS = {
  maxDepth: Number(process.env.ARCHIVE_MAX_DEPTH ?? 3),
  maxEntries: Number(process.env.ARCHIVE_MAX_ENTRIES ?? 5000),
  maxTotalBytes: Number(process.env.ARCHIVE_MAX_TOTAL_BYTES ?? 64 * 1024 * 1024),
  maxEntryBytes: 5 * 1024 * 1024,
  maxNestedArchiveBytes: 16 * 1024 * 1024,
  maxRatio: Number(process.env.ARCHIVE_MAX_RATIO ?? 200),
  maxChildren: 24,
  timeMs: 4000,
};

const MANIFEST = /(^|\/)(manifest-(sha256|sha512|md5)\.txt|bagit\.txt|bag-info\.txt|datapackage\.json|SHA256SUMS|CHECKSUMS?(\.txt)?|README(\.md|\.txt)?|CITATION\.cff|LICENSE(\.txt|\.md)?)$/i;
const CONTAINERS = new Set(["zip", "tar", "tar_gz", "gzip"]);
/** Extensions of formats that have a parser and are not themselves containers: these entries become child resources. */
const INSPECTABLE_EXT = new Set(
  FORMATS.filter((f) => (f.status === "implemented" || f.status === "partial") && !CONTAINERS.has(f.id) && f.family !== "binary").flatMap((f) => f.extensions),
);
const NESTED_EXT = /\.(zip|tar|tgz|tar\.gz|gz|kmz|epub|jar)$/i;

export interface NestedEntry {
  /** Original relative path; entries of nested archives use "outer.zip!/inner/path". */
  name: string;
  size: number;
  body: Buffer;
}

interface RawEntry {
  name: string;
  size: number;
  compressed: number | null;
  encrypted: boolean;
  type: "file" | "dir" | "symlink" | "hardlink" | "other";
  linkTarget?: string;
  read: (cap: number) => Buffer;
}

function cstr(b: Buffer): string {
  return b.toString("utf8").replace(/\0.*$/s, "");
}

function octal(b: Buffer): number {
  // GNU base-256 for large sizes (high bit set).
  if (b[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
    return n;
  }
  const v = parseInt(b.toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
  return Number.isFinite(v) ? v : NaN;
}

/** TAR reader (ustar, pax `path`, GNU long names); validates each header checksum. */
export function tarEntries(buf: Buffer, maxEntries = ARCHIVE_LIMITS.maxEntries): RawEntry[] {
  const out: RawEntry[] = [];
  let p = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (p + 512 <= buf.length && out.length < maxEntries) {
    const h = buf.subarray(p, p + 512);
    if (h.every((x) => x === 0)) break; // end-of-archive marker
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h.subarray(148, 156))) throw new Error(`tar: header checksum mismatch at offset ${p} (corrupt or not a tar)`);
    const size = octal(h.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: bad size field at offset ${p}`);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = h.subarray(257, 262).toString("latin1") === "ustar" ? cstr(h.subarray(345, 500)) : "";
    let name = prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100));
    const start = p + 512;
    const next = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(buf.subarray(start, start + Math.min(size, 4096)));
      p = next;
      continue;
    }
    if (type === "x") {
      const pax = buf.subarray(start, start + Math.min(size, 64 * 1024)).toString("utf8");
      paxPath = /\d+ path=([^\n]+)\n/.exec(pax)?.[1] ?? null;
      p = next;
      continue;
    }
    if (type === "g") {
      p = next;
      continue;
    }
    if (longName) name = longName;
    if (paxPath) name = paxPath;
    longName = paxPath = null;
    const kind: RawEntry["type"] = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "other";
    const avail = Math.max(0, Math.min(size, buf.length - start));
    out.push({ name, size, compressed: null, encrypted: false, type: kind, linkTarget: kind === "symlink" || kind === "hardlink" ? cstr(h.subarray(157, 257)) : undefined, read: (cap) => buf.subarray(start, start + Math.min(avail, cap)) });
    p = next;
  }
  return out;
}

function zipRaw(buf: Buffer, maxEntries: number): RawEntry[] {
  return listZipEntries(buf, maxEntries).map((e) => ({
    name: e.name,
    size: e.uncompressedSize,
    compressed: e.compressedSize,
    encrypted: e.encrypted,
    type: e.name.endsWith("/") ? "dir" : "file",
    read: (cap: number) => readZipEntry(buf, e, cap),
  }));
}

/** Reject absolute paths, drive letters, `..` segments and NULs — the classic zip-slip vectors. */
export function unsafeEntryPath(name: string): string | null {
  if (name.includes("\0")) return "nul_byte";
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/")) return "absolute_path";
  if (/^[a-zA-Z]:/.test(n)) return "drive_letter";
  if (n.split("/").some((s) => s === "..")) return "parent_traversal";
  return null;
}

interface Listed {
  path: string;
  size: number;
  compressed?: number;
  type?: string;
  encrypted?: boolean;
  depth: number;
}

interface WalkState {
  listed: Listed[];
  children: NestedEntry[];
  manifestTexts: Array<{ path: string; text: string }>;
  nested: Array<{ path: string; format: string; entries: number; depth: number }>;
  rejected: Array<{ path: string; reason: string }>;
  links: Array<{ path: string; target: string | undefined; type: string }>;
  encrypted: string[];
  bombs: Array<{ path: string; ratio: number | null; declaredBytes: number; reason: string }>;
  limitsHit: Set<string>;
  inflated: number;
  maxRatio: number;
  deadline: number;
  errors: Array<{ path: string; error: string }>;
}

function readCapped(e: RawEntry, cap: number, st: WalkState, path: string): Buffer | null {
  const room = ARCHIVE_LIMITS.maxTotalBytes - st.inflated;
  if (room <= 0) {
    st.limitsHit.add("max_total_bytes");
    return null;
  }
  try {
    const out = e.read(Math.min(cap, room));
    st.inflated += out.length;
    return out;
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || /larger than|buffer/i.test(msg)) {
      st.bombs.push({ path, ratio: e.compressed ? Math.round(e.size / Math.max(1, e.compressed)) : null, declaredBytes: e.size, reason: `inflates beyond ${Math.min(cap, room)} bytes (declared ${e.size})` });
    } else st.errors.push({ path, error: msg.slice(0, 120) });
    return null;
  }
}

function walk(buf: Buffer, format: string, prefix: string, depth: number, st: WalkState): number {
  let raw: RawEntry[];
  // +1 so that exceeding the budget is observable (and reported) rather than silent.
  const room = ARCHIVE_LIMITS.maxEntries - st.listed.length + 1;
  if (format === "zip" || format === "epub" || format === "kmz") raw = zipRaw(buf, room);
  else if (format === "tar") raw = tarEntries(buf, room);
  else return 0;
  let count = 0;
  for (const e of raw) {
    if (st.listed.length >= ARCHIVE_LIMITS.maxEntries) {
      st.limitsHit.add("max_entries");
      break;
    }
    if (Date.now() > st.deadline) {
      st.limitsHit.add("time_budget");
      break;
    }
    count++;
    const path = `${prefix}${e.name}`;
    const unsafe = unsafeEntryPath(e.name);
    if (unsafe) {
      st.rejected.push({ path, reason: unsafe });
      continue;
    }
    st.listed.push({ path, size: e.size, ...(e.compressed !== null ? { compressed: e.compressed } : {}), ...(e.type !== "file" ? { type: e.type } : {}), ...(e.encrypted ? { encrypted: true } : {}), depth });
    if (e.type === "symlink" || e.type === "hardlink") {
      st.links.push({ path, target: e.linkTarget, type: e.type });
      continue;
    }
    if (e.type !== "file") continue;
    if (e.encrypted) {
      st.encrypted.push(path);
      continue;
    }
    const ratio = e.compressed ? e.size / Math.max(1, e.compressed) : null;
    if (ratio !== null) st.maxRatio = Math.max(st.maxRatio, ratio);
    if (ratio !== null && ratio > ARCHIVE_LIMITS.maxRatio && e.size > 1024 * 1024) {
      st.bombs.push({ path, ratio: Math.round(ratio), declaredBytes: e.size, reason: `compression ratio ${Math.round(ratio)}:1 exceeds ${ARCHIVE_LIMITS.maxRatio}:1 — not inflated` });
      continue;
    }
    const { ext } = extensionOf(e.name);
    const isManifest = MANIFEST.test(e.name);
    if (NESTED_EXT.test(e.name) && !/\.(epub|kmz|jar)$/i.test(e.name)) {
      if (depth + 1 > ARCHIVE_LIMITS.maxDepth) {
        st.limitsHit.add("max_depth");
        continue;
      }
      const inner = readCapped(e, ARCHIVE_LIMITS.maxNestedArchiveBytes, st, path);
      if (!inner) continue;
      const handled = descend(inner, e.name, `${path}!/`, depth + 1, st, path);
      if (handled) continue;
    }
    const inspectable = isManifest || (ext !== null && INSPECTABLE_EXT.has(ext));
    if (!inspectable) continue;
    if (e.size > ARCHIVE_LIMITS.maxEntryBytes) continue;
    if (st.children.length >= ARCHIVE_LIMITS.maxChildren && !isManifest) {
      st.limitsHit.add("max_children");
      continue;
    }
    const body = readCapped(e, ARCHIVE_LIMITS.maxEntryBytes, st, path);
    if (!body) continue;
    if (isManifest) st.manifestTexts.push({ path, text: body.subarray(0, 512 * 1024).toString("utf8") });
    if (st.children.length < ARCHIVE_LIMITS.maxChildren) st.children.push({ name: path, size: e.size, body });
  }
  return count;
}

/** Enumerate a nested container; returns false when the bytes are not a supported container. */
function descend(bytes: Buffer, name: string, prefix: string, depth: number, st: WalkState, path: string): boolean {
  const det = detectFormat(bytes, null, name);
  try {
    if (det.format === "zip" || det.format === "tar") {
      const rec = { path, format: det.format, entries: 0, depth };
      st.nested.push(rec);
      rec.entries = walk(bytes, det.format, prefix, depth, st);
      return true;
    }
    if (det.format === "tar_gz" || det.format === "gzip") {
      const room = Math.min(ARCHIVE_LIMITS.maxNestedArchiveBytes, ARCHIVE_LIMITS.maxTotalBytes - st.inflated);
      let out: Buffer;
      try {
        out = gunzipSync(bytes, { maxOutputLength: Math.max(1, room) });
      } catch (err) {
        st.bombs.push({ path, ratio: null, declaredBytes: bytes.length, reason: `gzip member inflates beyond ${room} bytes: ${(err as Error).message.slice(0, 60)}` });
        return true;
      }
      st.inflated += out.length;
      st.maxRatio = Math.max(st.maxRatio, out.length / Math.max(1, bytes.length));
      if (det.format === "tar_gz") {
        const rec = { path, format: "tar_gz", entries: 0, depth };
        st.nested.push(rec);
        rec.entries = walk(out, "tar", prefix, depth, st);
        return true;
      }
      const innerName = name.replace(/\.gz$/i, "");
      st.nested.push({ path, format: "gzip", entries: 1, depth });
      if (NESTED_EXT.test(innerName) && depth + 1 <= ARCHIVE_LIMITS.maxDepth && descend(out, innerName, `${prefix}`, depth + 1, st, `${prefix}${innerName}`)) return true;
      const { ext } = extensionOf(innerName);
      if (ext && INSPECTABLE_EXT.has(ext) && st.children.length < ARCHIVE_LIMITS.maxChildren) st.children.push({ name: `${prefix}${innerName}`, size: out.length, body: out.subarray(0, ARCHIVE_LIMITS.maxEntryBytes) });
      return true;
    }
  } catch (err) {
    st.errors.push({ path, error: (err as Error).message.slice(0, 120) });
    return true;
  }
  return false;
}

function opaque(ctx: ExtractionContext) {
  const spec = FORMAT_BY_ID.get(ctx.format)!;
  ctx.add(C.technical, "archiveFormat", ctx.format, { status: "observed", method: "magic bytes", evidence: ctx.detection.signature ?? undefined });
  ctx.add(C.technical, "parseStatus", { status: "unavailable", reason: `${spec.label}: recognised by signature; no parser is bundled, so the entry list and contents are unavailable` }, { status: "unavailable", method: "format capability registry", evidenceType: "system_measurement" });
  if (ctx.format === "rar" && ctx.response.body.length > 7) {
    ctx.add(C.technical, "rarVersion", ctx.response.body[6] === 0x01 ? "RAR 5" : "RAR 1.5–4", { status: "observed", method: "signature byte 6" });
  }
  if (ctx.format === "7z" && ctx.response.body.length > 8) {
    ctx.add(C.technical, "sevenZipVersion", `${ctx.response.body[6]}.${ctx.response.body[7]}`, { status: "observed", method: "signature header version bytes" });
  }
}

/**
 * Archives: list contents (bounded nested enumeration), detect preservation manifests
 * (BagIt, checksum lists, datapackage), and hand supported entries to the crawler as
 * contained child resources keyed by their original relative path. Nothing is executed;
 * every inflation is capped; traversal paths are rejected; encrypted entries are reported
 * as unavailable; 7z/RAR/bzip2/xz/zstd are recognised by signature only.
 */
export const archiveExtractor: Extractor = {
  id: "archive",
  version: "2.0.0",
  description: "ZIP / TAR / TAR.GZ / gzip: bounded nested entry listing (depth/entries/bytes/time), zip-slip rejection, ratio guard, encryption detection, BagIt & checksum manifests; 7z/RAR signature-only.",
  kinds: ["archive"],
  formats: ["zip", "tar", "tar_gz", "gzip", "epub", "kmz", "7z", "rar", "bzip2", "xz", "zstd"],
  categories: [C.structural, C.file_system, C.preservation, C.integrity, C.technical, C.access_security],
  timeoutMs: 6000,
  async run(ctx) {
    const spec = FORMAT_BY_ID.get(ctx.format)!;
    if (spec.status === "signature_only") return opaque(ctx);
    const st: WalkState = { listed: [], children: [], manifestTexts: [], nested: [], rejected: [], links: [], encrypted: [], bombs: [], limitsHit: new Set(), inflated: 0, maxRatio: 0, deadline: Date.now() + ARCHIVE_LIMITS.timeMs, errors: [] };
    const original = ctx.response.body;
    ctx.add(C.technical, "archiveFormat", ctx.format === "tar_gz" ? "tar.gz" : ctx.format, { status: "observed", method: "magic bytes", evidence: ctx.detection.signature ?? undefined });
    let topCount = 0;
    if (ctx.format === "gzip" || ctx.format === "tar_gz") {
      let out: Buffer;
      try {
        out = gunzipSync(original, { maxOutputLength: ARCHIVE_LIMITS.maxTotalBytes });
      } catch (err) {
        const tooBig = (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
        ctx.add(C.technical, "decompression", tooBig ? `gzip stream exceeds ${ARCHIVE_LIMITS.maxTotalBytes} bytes — not inflated further` : `gzip stream is corrupt: ${(err as Error).message.slice(0, 80)}`, { status: "extraction_failed", method: "gunzip (capped)" });
        if (tooBig) ctx.add(C.access_security, "zipBombSuspected", [{ path: "(gzip stream)", ratio: null, declaredBytes: null, reason: "decompressed size exceeds the archive byte budget" }], { status: "observed", method: "capped gunzip" });
        return;
      }
      st.inflated = out.length;
      ctx.add(C.file_system, "decompressedBytes", out.length, { status: "observed", method: "gunzip (capped)" });
      ctx.add(C.technical, "maxCompressionRatio", Number((out.length / Math.max(1, original.length)).toFixed(1)), { status: "observed", method: "decompressed ÷ compressed" });
      if (ctx.format === "tar_gz") {
        try {
          topCount = walk(out, "tar", "", 0, st);
        } catch (err) {
          ctx.add(C.structural, "entries", `tar stream unreadable: ${(err as Error).message.slice(0, 120)}`, { status: "extraction_failed", method: "tar header walk" });
          return;
        }
      } else {
        const orig = (ctx.detection.detail?.originalName as string | undefined) ?? (ctx.filename ?? extensionOf(ctx.url).base).replace(/\.gz$/i, "");
        const inner = orig || "decompressed";
        ctx.add(C.file_system, "originalFilename", inner, { method: ctx.detection.detail?.originalName ? "gzip FNAME header" : "file name without .gz", status: ctx.detection.detail?.originalName ? "source_declared" : "inferred" });
        topCount = 1;
        st.listed.push({ path: inner, size: out.length, depth: 0 });
        if (!descend(out, inner, `${inner}!/`, 1, st, inner)) st.children.push({ name: inner, size: out.length, body: out.subarray(0, ARCHIVE_LIMITS.maxEntryBytes) });
      }
    } else {
      try {
        topCount = walk(original, ctx.format === "tar" ? "tar" : "zip", "", 0, st);
      } catch (err) {
        ctx.add(C.structural, "entries", `directory unreadable: ${(err as Error).message.slice(0, 120)}`, { status: "extraction_failed", method: `${ctx.format} directory` });
        return;
      }
    }

    const fileEntries = st.listed.filter((e) => !e.type || e.type === "file");
    ctx.add(C.structural, "entryCount", topCount, { status: "observed", method: `${ctx.format} directory (top level)` });
    ctx.add(C.structural, "totalEntryCount", st.listed.length + st.rejected.length, { status: "observed", method: "all enumerated levels", evidence: st.nested.length ? `${st.nested.length} nested archive(s)` : undefined });
    ctx.add(C.structural, "entries", st.listed.slice(0, 100).map(({ depth: _d, ...e }) => e), { status: "observed", method: `${ctx.format} directory`, evidence: st.listed.length > 100 ? `first 100 of ${st.listed.length}` : undefined });
    if (st.nested.length) ctx.add(C.structural, "nestedArchives", st.nested.slice(0, 50), { status: "observed", method: "recursive enumeration", evidence: `depth ≤ ${ARCHIVE_LIMITS.maxDepth}` });
    if (ctx.format !== "epub" && ctx.format !== "kmz") ctx.add(C.structural, "childResources", st.children.map((c) => ({ path: c.name, size: c.size })), { status: "observed", method: "inspectable entries handed on as contained resources" });
    ctx.add(C.file_system, "declaredUncompressedBytes", fileEntries.reduce((a, e) => a + e.size, 0), { method: `${ctx.format} directory sizes` });
    if (st.maxRatio && ctx.format !== "gzip" && ctx.format !== "tar_gz") ctx.add(C.technical, "maxCompressionRatio", Number(st.maxRatio.toFixed(1)), { status: "observed", method: "uncompressed ÷ compressed per entry" });
    const dirs = new Set(st.listed.map((e) => e.path.split("/").slice(0, -1).join("/")).filter(Boolean));
    ctx.add(C.structural, "directoryCount", dirs.size, { status: "observed", method: "entry paths" });
    const exts = new Map<string, number>();
    for (const e of fileEntries) {
      const x = e.path.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "(none)";
      exts.set(x, (exts.get(x) ?? 0) + 1);
    }
    ctx.add(C.file_system, "extensions", Object.fromEntries([...exts].sort((a, b) => b[1] - a[1]).slice(0, 20)), { status: "observed", method: "entry names" });
    ctx.add(C.technical, "archiveLimits", { maxDepth: ARCHIVE_LIMITS.maxDepth, maxEntries: ARCHIVE_LIMITS.maxEntries, maxTotalBytes: ARCHIVE_LIMITS.maxTotalBytes, maxRatio: ARCHIVE_LIMITS.maxRatio, inflatedBytes: st.inflated, limitsHit: [...st.limitsHit] }, { status: "observed", method: "archive enumeration budget", evidence: st.limitsHit.size ? `stopped early: ${[...st.limitsHit].join(", ")}` : "enumerated within budget" });
    if (st.limitsHit.size) ctx.add(C.quality, "archiveTruncated", [...st.limitsHit], { status: "observed", method: "archive enumeration budget", evidence: "listing is incomplete — limits reached" });
    if (st.rejected.length) ctx.add(C.access_security, "pathTraversalRejected", st.rejected.slice(0, 50), { status: "observed", method: "entry path validation", evidence: "absolute, drive-letter or '..' paths are never extracted or followed" });
    if (st.links.length) ctx.add(C.access_security, "linkEntries", st.links.slice(0, 50), { status: "observed", method: "tar link entries", evidence: "symlinks/hardlinks are listed, never followed" });
    if (st.bombs.length) ctx.add(C.access_security, "zipBombSuspected", st.bombs.slice(0, 20), { status: "observed", method: "compression ratio / capped inflation guard" });
    if (st.errors.length) ctx.add(C.structural, "unreadableEntries", st.errors.slice(0, 20), { status: "extraction_failed", method: "capped inflate" });
    if (st.encrypted.length) {
      ctx.add(C.access_security, "encryptedEntries", { count: st.encrypted.length, examples: st.encrypted.slice(0, 10) }, { status: "observed", method: "zip general-purpose flag bit 0/6" });
      ctx.add(C.technical, "parseStatus", { status: "unavailable", reason: `${st.encrypted.length} encrypted entr${st.encrypted.length === 1 ? "y" : "ies"}: contents unavailable without credentials (none are ever guessed)` }, { status: "unavailable", method: "zip encryption flag" });
    }

    const manifests = st.listed.filter((e) => MANIFEST.test(e.path));
    ctx.add(C.preservation, "manifests", manifests.map((m) => m.path), { method: "manifest file names" });
    if (manifests.some((m) => /bagit\.txt$/i.test(m.path))) ctx.add(C.preservation, "packaging", "BagIt", { method: "bagit.txt present" });
    for (const m of st.manifestTexts.filter((x) => /manifest-sha256|SHA256SUMS|CHECKSUM/i.test(x.path)).slice(0, 2)) {
      const declared = [...m.text.matchAll(/^([a-f0-9]{64})\s+\*?(.+)$/gim)].map((x) => ({ sha256: x[1].toLowerCase(), file: x[2].trim() }));
      ctx.add(C.integrity, "publishedChecksums", declared.slice(0, 100), { method: `${m.path}`, evidence: `${declared.length} declared digests` });
    }
    // EPUB/KMZ are single documents packaged as zip: their parts are described by the epub/geo extractors, not crawled.
    if (ctx.format !== "epub" && ctx.format !== "kmz") ctx.shared.set("archiveEntries", st.children);
  },
};
