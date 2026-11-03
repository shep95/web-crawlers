import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { FORMAT_BY_ID } from "../formats.js";
import { clean, normalizeDate, splitKeywords } from "../normalize.js";

const toNum = (v: unknown): number | null => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : null);

function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return v.slice(0, 20).map(jsonSafe);
  return v;
}

// ---------------------------------------------------------------- NetCDF (classic / 64-bit offset)

async function netcdf(ctx: ExtractionContext) {
  const body = ctx.response.body;
  if (body[3] === 5) {
    ctx.add(C.technical, "parseStatus", { status: "unavailable", reason: "NetCDF CDF5 (64-bit data) is not supported by the bundled netcdfjs reader" }, { status: "unavailable", method: "netcdfjs capability" });
    return;
  }
  const { NetCDFReader } = await import("netcdfjs");
  let r: InstanceType<typeof NetCDFReader>;
  try {
    r = new NetCDFReader(new Uint8Array(body.buffer, body.byteOffset, body.length));
  } catch (err) {
    ctx.add(C.schema, "netcdfHeader", `header unreadable: ${String((err as Error).message ?? err).slice(0, 120)}`, { status: "extraction_failed", method: "netcdfjs header", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
    return;
  }
  const o = { status: "observed" as const, method: "netcdfjs header (variable data not read)" };
  const g = new Map(r.globalAttributes.map((a) => [a.name, a.value]));
  const ga = (k: string) => (g.has(k) ? String(g.get(k)) : null);
  const dims = r.dimensions.map((d, i) => ({ name: d.name, size: d.size, unlimited: r.recordDimension?.id === i }));
  ctx.add(C.technical, "netcdfVersion", r.version, o);
  ctx.add(C.schema, "dimensions", dims, o);
  ctx.add(C.structural, "dimensionCount", dims.length, o);
  const vars = r.variables.slice(0, 300).map((v) => {
    const at = new Map((v.attributes as Array<{ name: string; value: unknown }>).map((a) => [a.name, a.value]));
    const s = (k: string) => (at.has(k) ? String(at.get(k)) : null);
    return { name: v.name, type: v.type, dimensions: v.dimensions.map((i) => dims[i]?.name ?? String(i)), units: s("units"), longName: s("long_name"), standardName: s("standard_name"), fillValue: at.has("_FillValue") ? jsonSafe(at.get("_FillValue")) : null, record: v.record };
  });
  ctx.add(C.schema, "variables", vars, o);
  ctx.add(C.structural, "variableCount", r.variables.length, o);
  ctx.add(C.semantic, "units", vars.filter((v) => v.units).map((v) => ({ variable: v.name, units: v.units })), { method: "variable units attributes" });
  const std = vars.filter((v) => v.standardName).map((v) => v.standardName);
  const conventions = ga("Conventions");
  if (std.length) ctx.add(C.semantic, "controlledVocabularies", [{ vocabulary: /CF/.test(conventions ?? "") ? "CF Standard Names" : "standard_name", terms: std.slice(0, 50) }], { method: "standard_name attributes" });
  ctx.add(C.schema, "globalAttributes", r.globalAttributes.slice(0, 80).map((a) => ({ name: a.name, type: a.type, value: typeof a.value === "string" ? a.value.slice(0, 300) : jsonSafe(a.value) })), { method: "netcdf global attributes" });
  ctx.add(C.scientific, "conventions", conventions, { method: "global attribute Conventions" });
  ctx.add(C.descriptive, "title", clean(ga("title")), { method: "global attribute title" });
  ctx.add(C.descriptive, "description", clean(ga("summary") ?? ga("comment"), 1000), { method: "global attribute summary|comment" });
  ctx.add(C.descriptive, "keywords", splitKeywords(ga("keywords")), { method: "global attribute keywords" });
  ctx.add(C.provenance, "institution", clean(ga("institution")), { method: "global attribute institution" });
  ctx.add(C.provenance, "source", clean(ga("source")), { method: "global attribute source" });
  ctx.add(C.provenance, "publisher", clean(ga("publisher_name")), { method: "global attribute publisher_name" });
  ctx.add(C.lineage, "processingDescription", clean(ga("history"), 1000), { method: "global attribute history" });
  ctx.add(C.rights, "license", clean(ga("license")), { method: "global attribute license" });
  ctx.add(C.scientific, "references", clean(ga("references"), 500), { method: "global attribute references" });
  const doi = /10\.\d{4,9}\/\S+/.exec(ga("doi") ?? ga("id") ?? ga("references") ?? "")?.[0];
  if (doi) ctx.add(C.identifiers, "doi", [doi.toLowerCase().replace(/[.,;)]+$/, "")], { method: "global attribute doi|id|references" });
  const n = (k: string) => (g.has(k) && Number.isFinite(Number(g.get(k))) ? Number(g.get(k)) : null);
  const [s, nn, w, e] = [n("geospatial_lat_min"), n("geospatial_lat_max"), n("geospatial_lon_min"), n("geospatial_lon_max")];
  if (s !== null && nn !== null && w !== null && e !== null && Math.abs(s) <= 90 && Math.abs(nn) <= 90 && Math.abs(w) <= 360 && Math.abs(e) <= 360) {
    ctx.add(C.spatial, "boundingBox", { south: s, north: nn, west: w, east: e }, { method: "ACDD geospatial_lat/lon_min/max", evidence: "declared extent, not computed from coordinate variables" });
  }
  for (const [k, f] of [["time_coverage_start", "coverageStart"], ["time_coverage_end", "coverageEnd"], ["date_created", "created"], ["date_modified", "modified"]] as const) {
    const d = normalizeDate(ga(k));
    if (d) ctx.add(C.temporal, f, d.iso, { method: `global attribute ${k}`, original: d.original });
  }
}

// ---------------------------------------------------------------- FITS

export interface FitsHdu {
  index: number;
  cards: Map<string, string | number | boolean>;
  comments: string[];
  history: string[];
  headerBlocks: number;
  dataBytes: number;
}

function fitsValue(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(v);
    return (m ? m[1].replace(/''/g, "'") : v.slice(1)).trimEnd();
  }
  const noComment = v.split("/")[0].trim();
  if (noComment === "T") return true;
  if (noComment === "F") return false;
  const num = Number(noComment.replace(/D/i, "E"));
  return Number.isFinite(num) && noComment !== "" ? num : noComment;
}

/** Read 2880-byte FITS header blocks of up to `maxHdus` HDUs; data units are skipped by size, never decoded. */
export function readFitsHeaders(buf: Buffer, maxHdus = 20): { hdus: FitsHdu[]; error: string | null } {
  const hdus: FitsHdu[] = [];
  let p = 0;
  while (p + 2880 <= buf.length && hdus.length < maxHdus) {
    const cards = new Map<string, string | number | boolean>();
    const comments: string[] = [];
    const history: string[] = [];
    let blocks = 0;
    let ended = false;
    while (!ended && p + 2880 <= buf.length && blocks < 200) {
      const block = buf.subarray(p, p + 2880).toString("latin1");
      blocks++;
      p += 2880;
      for (let i = 0; i < 36; i++) {
        const card = block.slice(i * 80, i * 80 + 80);
        const key = card.slice(0, 8).trim();
        if (key === "END") {
          ended = true;
          break;
        }
        if (key === "COMMENT") comments.push(card.slice(8).trim());
        else if (key === "HISTORY") history.push(card.slice(8).trim());
        else if (key && card.slice(8, 10) === "= ") cards.set(key, fitsValue(card.slice(10)));
      }
    }
    if (!ended) return { hdus, error: hdus.length ? `HDU ${hdus.length}: header END card not found (truncated)` : "primary header END card not found (truncated or not FITS)" };
    if (hdus.length === 0 && cards.get("SIMPLE") !== true) return { hdus, error: "SIMPLE = T missing: not a conforming FITS file" };
    const naxis = Number(cards.get("NAXIS") ?? 0);
    const bitpix = Math.abs(Number(cards.get("BITPIX") ?? 8));
    let elems = naxis > 0 ? 1 : 0;
    for (let i = 1; i <= naxis; i++) elems *= Number(cards.get(`NAXIS${i}`) ?? 0);
    const gcount = Number(cards.get("GCOUNT") ?? 1);
    const pcount = Number(cards.get("PCOUNT") ?? 0);
    const dataBytes = naxis > 0 ? (bitpix / 8) * gcount * (pcount + elems) : 0;
    hdus.push({ index: hdus.length, cards, comments, history, headerBlocks: blocks, dataBytes });
    p += Math.ceil(dataBytes / 2880) * 2880;
    if (p + 2880 > buf.length || buf.subarray(p, p + 8).toString("latin1") !== "XTENSION") break;
  }
  return { hdus, error: null };
}

function fits(ctx: ExtractionContext) {
  const { hdus, error } = readFitsHeaders(ctx.response.body);
  if (!hdus.length) {
    ctx.add(C.scientific, "fitsHeader", error ?? "no HDU", { status: "extraction_failed", method: "FITS header cards" });
    return;
  }
  const o = { method: "FITS header cards (2880-byte blocks)" };
  const p = hdus[0].cards;
  const s = (k: string) => (p.has(k) ? String(p.get(k)) : null);
  ctx.add(C.structural, "hduCount", hdus.length, { ...o, status: "observed", evidence: error ?? undefined });
  ctx.add(C.scientific, "hdus", hdus.map((h) => {
    const naxis = Number(h.cards.get("NAXIS") ?? 0);
    return { index: h.index, xtension: h.cards.get("XTENSION") ?? "PRIMARY", extname: h.cards.get("EXTNAME") ?? null, bitpix: h.cards.get("BITPIX") ?? null, naxis, dims: Array.from({ length: naxis }, (_, i) => h.cards.get(`NAXIS${i + 1}`) ?? null), bunit: h.cards.get("BUNIT") ?? null, dataBytes: h.dataBytes };
  }), { ...o, status: "observed" });
  ctx.add(C.technical, "bitDepth", toNum(p.get("BITPIX")), { ...o, status: "observed" });
  ctx.add(C.scientific, "observedObject", s("OBJECT"), o);
  ctx.add(C.descriptive, "title", clean(s("OBJECT") ?? s("TITLE")), { method: "FITS OBJECT|TITLE" });
  ctx.add(C.device_sensor, "telescope", s("TELESCOP"), o);
  ctx.add(C.device_sensor, "instrument", s("INSTRUME"), o);
  ctx.add(C.device_sensor, "filter", s("FILTER"), o);
  const settings = Object.fromEntries(["EXPTIME", "EXPOSURE", "GAIN", "AIRMASS", "CCD-TEMP", "XBINNING", "YBINNING"].filter((k) => p.has(k)).map((k) => [k, p.get(k)]));
  ctx.add(C.scientific, "instrumentSettings", settings, o);
  ctx.add(C.provenance, "origin", s("ORIGIN"), { method: "FITS ORIGIN" });
  ctx.add(C.semantic, "units", hdus.filter((h) => h.cards.has("BUNIT")).map((h) => ({ hdu: h.index, units: String(h.cards.get("BUNIT")) })), { method: "FITS BUNIT" });
  const ra = toNum(p.get("RA") ?? p.get("CRVAL1"));
  const dec = toNum(p.get("DEC") ?? p.get("CRVAL2"));
  if (ra !== null && dec !== null) ctx.add(C.scientific, "celestialCoordinates", { ra, dec, equinox: p.get("EQUINOX") ?? null, frame: p.get("RADESYS") ?? p.get("RADECSYS") ?? null, ctype: [p.get("CTYPE1") ?? null, p.get("CTYPE2") ?? null] }, { ...o, evidence: "celestial (sky) coordinates — not a geographic location" });
  for (const [k, f] of [["DATE-OBS", "observationDate"], ["DATE", "created"]] as const) {
    const d = normalizeDate(s(k));
    if (d) ctx.add(C.temporal, f, d.iso, { method: `FITS ${k}`, original: d.original });
  }
  const history = hdus.flatMap((h) => h.history);
  if (history.length) ctx.add(C.lineage, "processingDescription", clean(history.slice(0, 20).join(" | "), 1000), { method: "FITS HISTORY cards", evidence: `${history.length} HISTORY cards` });
  const comments = hdus.flatMap((h) => h.comments);
  if (comments.length) ctx.add(C.descriptive, "description", clean(comments.slice(0, 5).join(" "), 500), { method: "FITS COMMENT cards" });
}

// ---------------------------------------------------------------- Parquet

async function parquet(ctx: ExtractionContext) {
  const b = ctx.response.body;
  if (b.length < 12 || b.subarray(b.length - 4).toString("latin1") !== "PAR1") {
    ctx.add(C.schema, "parquetFooter", ctx.response.truncated ? "file truncated at byte cap: footer (schema/row groups) is at the end and was not fetched" : "trailing PAR1 magic missing (corrupt or truncated)", { status: "extraction_failed", method: "parquet footer" });
    return;
  }
  const { parquetMetadata } = await import("hyparquet");
  let md: ReturnType<typeof parquetMetadata>;
  try {
    md = parquetMetadata(b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer);
  } catch (err) {
    ctx.add(C.schema, "parquetFooter", `footer unreadable: ${String((err as Error).message ?? err).slice(0, 120)}`, { status: "extraction_failed", method: "hyparquet parquetMetadata" });
    return;
  }
  const o = { status: "observed" as const, method: "parquet footer (hyparquet)" };
  // Flatten the schema tree into leaf column paths.
  const cols: Array<{ name: string; type: string | null; logicalType: string | null; repetition: string | null }> = [];
  const walk = (i: number, prefix: string[]): number => {
    const el = md.schema[i];
    const path = i === 0 ? [] : [...prefix, el.name];
    let next = i + 1;
    for (let c = 0; c < (el.num_children ?? 0); c++) next = walk(next, path);
    if (!el.num_children && i !== 0 && cols.length < 500) cols.push({ name: path.join("."), type: el.type ?? null, logicalType: el.logical_type?.type ?? el.converted_type ?? null, repetition: el.repetition_type ?? null });
    return next;
  };
  walk(0, []);
  ctx.add(C.schema, "columns", cols, o);
  ctx.add(C.structural, "rowCount", toNum(md.num_rows), o);
  ctx.add(C.structural, "rowGroupCount", md.row_groups.length, o);
  ctx.add(C.structural, "rowGroups", md.row_groups.slice(0, 50).map((g) => ({ numRows: toNum(g.num_rows), totalByteSize: toNum(g.total_byte_size), compressedSize: toNum(g.total_compressed_size ?? null) })), o);
  const codecs = new Set<string>();
  const encodings = new Set<string>();
  for (const g of md.row_groups.slice(0, 50)) for (const c of g.columns) {
    if (c.meta_data) {
      codecs.add(c.meta_data.codec);
      for (const e of c.meta_data.encodings) encodings.add(e);
    }
  }
  ctx.add(C.technical, "compression", [...codecs].join(", "), o);
  ctx.add(C.technical, "encodings", [...encodings], o);
  ctx.add(C.technical, "parquetFormatVersion", md.version, o);
  ctx.add(C.provenance, "createdBy", md.created_by, { method: "parquet created_by" });
  const kv = md.key_value_metadata ?? [];
  ctx.add(C.schema, "keyValueMetadataKeys", kv.map((k) => k.key).slice(0, 50), o);
  const stats = (md.row_groups[0]?.columns ?? []).slice(0, 60).map((c) => {
    const st = c.meta_data?.statistics as Record<string, unknown> | undefined;
    if (!st) return null;
    return { column: c.meta_data!.path_in_schema.join("."), min: jsonSafe(st.min_value ?? st.min), max: jsonSafe(st.max_value ?? st.max), nullCount: jsonSafe(st.null_count) };
  }).filter(Boolean);
  ctx.add(C.statistical, "columnStatistics", stats, { ...o, evidence: "row group 0 statistics as written by the producer" });
  const geo = kv.find((k) => k.key === "geo")?.value;
  if (geo) {
    try {
      const g = JSON.parse(geo) as { primary_column?: string; columns?: Record<string, { bbox?: number[]; crs?: unknown; geometry_types?: string[] }> };
      const pc = g.columns?.[g.primary_column ?? ""] ?? Object.values(g.columns ?? {})[0];
      ctx.add(C.spatial, "geoParquet", { primaryColumn: g.primary_column ?? null, geometryTypes: pc?.geometry_types ?? [], crs: pc?.crs ? (typeof pc.crs === "string" ? pc.crs : "PROJJSON") : "OGC:CRS84 (default)" }, { method: "GeoParquet 'geo' metadata" });
      if (pc?.bbox?.length === 4) ctx.add(C.spatial, "boundingBox", { west: pc.bbox[0], south: pc.bbox[1], east: pc.bbox[2], north: pc.bbox[3] }, { method: "GeoParquet bbox" });
    } catch {
      ctx.add(C.spatial, "geoParquet", "invalid 'geo' metadata JSON", { status: "extraction_failed", method: "GeoParquet" });
    }
  }
}

// ---------------------------------------------------------------- SQLite (byte-level, read-only)

function varint(b: Buffer, p: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 9; i++) {
    const byte = b[p + i];
    if (byte === undefined) throw new Error("sqlite: varint past end");
    if (i === 8) return [v * 256 + byte, p + 9];
    v = v * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [v, p + i + 1];
  }
  return [v, p + 9];
}

/**
 * Read sqlite_schema rows by walking table b-tree pages from page 1. This is a pure
 * byte parser: no SQLite engine, no SQL execution, no triggers. Bounded pages/rows.
 */
export function sqliteSchema(buf: Buffer, pageSize: number, reserved: number, encoding: number): Array<{ type: string; name: string; tblName: string; rootPage: number; sql: string | null }> {
  const usable = pageSize - reserved;
  const rows: Array<{ type: string; name: string; tblName: string; rootPage: number; sql: string | null }> = [];
  const decode = (b: Buffer) => (encoding === 2 ? b.toString("utf16le") : encoding === 3 ? Buffer.from(b).swap16().toString("utf16le") : b.toString("utf8"));
  let pagesVisited = 0;
  const visit = (page: number, depth: number) => {
    if (depth > 6 || pagesVisited++ > 64 || rows.length > 500) return;
    const base = (page - 1) * pageSize;
    const off = page === 1 ? 100 : 0;
    if (base + off + 8 > buf.length) throw new Error(`sqlite: page ${page} beyond end of file`);
    const type = buf[base + off];
    const cells = buf.readUInt16BE(base + off + 3);
    const ptrStart = base + off + (type === 0x05 ? 12 : 8);
    if (type === 0x05) {
      for (let i = 0; i < cells; i++) visit(buf.readUInt32BE(base + buf.readUInt16BE(ptrStart + i * 2)), depth + 1);
      visit(buf.readUInt32BE(base + off + 8), depth + 1);
      return;
    }
    if (type !== 0x0d) throw new Error(`sqlite: unexpected page type 0x${type.toString(16)} in schema tree`);
    for (let i = 0; i < cells && rows.length <= 500; i++) {
      let p = base + buf.readUInt16BE(ptrStart + i * 2);
      let payload: number;
      [payload, p] = varint(buf, p);
      [, p] = varint(buf, p); // rowid
      const maxLocal = usable - 35;
      let data: Buffer;
      if (payload <= maxLocal) data = buf.subarray(p, p + payload);
      else {
        const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
        let local = minLocal + ((payload - minLocal) % (usable - 4));
        if (local > maxLocal) local = minLocal;
        const parts = [buf.subarray(p, p + local)];
        let next = buf.readUInt32BE(p + local);
        let got = local;
        for (let hops = 0; next && got < payload && hops < 32; hops++) {
          const ob = (next - 1) * pageSize;
          if (ob + 4 > buf.length) break;
          const chunk = buf.subarray(ob + 4, ob + Math.min(usable, 4 + payload - got));
          parts.push(chunk);
          got += chunk.length;
          next = buf.readUInt32BE(ob);
        }
        data = Buffer.concat(parts);
      }
      let [hlen, q] = varint(data, 0);
      const serials: number[] = [];
      while (q < hlen) {
        let st: number;
        [st, q] = varint(data, q);
        serials.push(st);
      }
      let v = hlen;
      const vals: Array<string | number | null> = [];
      for (const st of serials) {
        if (st === 0) vals.push(null);
        else if (st >= 1 && st <= 6) {
          const n = [0, 1, 2, 3, 4, 6, 8][st];
          let x = 0;
          for (let k = 0; k < n; k++) x = x * 256 + data[v + k];
          vals.push(x);
          v += n;
        } else if (st === 7) {
          vals.push(data.readDoubleBE(v));
          v += 8;
        } else if (st === 8 || st === 9) vals.push(st - 8);
        else if (st >= 12) {
          const n = st % 2 ? (st - 13) / 2 : (st - 12) / 2;
          vals.push(st % 2 ? decode(data.subarray(v, v + n)) : `<blob ${n}>`);
          v += n;
        }
      }
      rows.push({ type: String(vals[0]), name: String(vals[1]), tblName: String(vals[2]), rootPage: Number(vals[3] ?? 0), sql: typeof vals[4] === "string" ? vals[4].slice(0, 2000) : null });
    }
  };
  visit(1, 0);
  return rows;
}

function sqliteColumns(sql: string | null): string[] {
  if (!sql) return [];
  const body = /\(([\s\S]*)\)/.exec(sql)?.[1];
  if (!body) return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p && !/^(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(p)).map((p) => p.replace(/\s+/g, " ").slice(0, 120)).slice(0, 100);
}

function sqlite(ctx: ExtractionContext) {
  const b = ctx.response.body;
  if (b.length < 100) {
    ctx.add(C.technical, "sqliteHeader", "file shorter than the 100-byte header", { status: "extraction_failed", method: "sqlite header" });
    return;
  }
  const o = { status: "observed" as const, method: "sqlite 100-byte file header (no engine)" };
  const raw = b.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  const encoding = b.readUInt32BE(56);
  const appId = b.readUInt32BE(68);
  const ver = b.readUInt32BE(96);
  ctx.add(C.technical, "sqliteHeader", {
    pageSize,
    writeVersion: b[18] === 2 ? "WAL" : "legacy",
    readVersion: b[19] === 2 ? "WAL" : "legacy",
    reservedBytes: b[20],
    pageCount: b.readUInt32BE(28),
    freelistPages: b.readUInt32BE(36),
    schemaFormat: b.readUInt32BE(44),
    textEncoding: ({ 1: "UTF-8", 2: "UTF-16le", 3: "UTF-16be" } as Record<number, string>)[encoding] ?? `unknown (${encoding})`,
    autoVacuum: b.readUInt32BE(52) !== 0,
    applicationId: appId ? `0x${appId.toString(16)}` : null,
  }, o);
  if (appId === 0x47504b47 || appId === 0x47503130) ctx.add(C.technical, "sqliteApplication", "GeoPackage", { ...o, method: "application_id" });
  else if (appId === 0x4d504258) ctx.add(C.technical, "sqliteApplication", "MBTiles", { ...o, method: "application_id" });
  ctx.add(C.version, "userVersion", b.readUInt32BE(60), o);
  ctx.add(C.version, "fileChangeCounter", b.readUInt32BE(24), o);
  if (ver) ctx.add(C.version, "writtenBySqlite", `${Math.floor(ver / 1_000_000)}.${Math.floor(ver / 1000) % 1000}.${ver % 1000}`, { ...o, method: "SQLITE_VERSION_NUMBER at offset 96" });
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    ctx.add(C.schema, "tables", `invalid page size ${pageSize}`, { status: "extraction_failed", method: "sqlite header" });
    return;
  }
  try {
    const rows = sqliteSchema(b, pageSize, b[20], encoding);
    const by = (t: string) => rows.filter((r) => r.type === t);
    const so = { status: "observed" as const, method: "sqlite_schema b-tree rows (byte parser; SQL never executed)" };
    ctx.add(C.schema, "tables", by("table").map((t) => ({ name: t.name, columns: sqliteColumns(t.sql) })), so);
    ctx.add(C.schema, "views", by("view").map((t) => t.name), so);
    ctx.add(C.schema, "indexes", by("index").map((t) => ({ name: t.name, table: t.tblName })), so);
    ctx.add(C.structural, "tableCount", by("table").length, so);
    ctx.add(C.structural, "schemaObjectCount", rows.length, so);
    const triggers = by("trigger");
    if (triggers.length) ctx.add(C.schema, "triggers", triggers.map((t) => ({ name: t.name, table: t.tblName })), { ...so, evidence: "trigger definitions listed only — never executed" });
  } catch (err) {
    ctx.add(C.schema, "tables", `schema pages unreadable: ${(err as Error).message.slice(0, 120)}`, { status: "extraction_failed", method: "sqlite_schema b-tree", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
  }
}

/** NetCDF classic header (netcdfjs), FITS header cards, Parquet footer (hyparquet), SQLite header + schema rows (byte parser). */
export const scientificExtractor: Extractor = {
  id: "scientific",
  version: "1.0.0",
  description: "Scientific & columnar data headers: NetCDF classic/64-bit (dimensions, variables, units, ACDD/CF attributes), FITS HDU header cards, Parquet schema + row groups, SQLite header + sqlite_schema (read-only byte parser).",
  kinds: ["binary"],
  formats: ["netcdf", "fits", "parquet", "sqlite"],
  categories: [C.schema, C.semantic, C.scientific, C.structural, C.technical, C.descriptive, C.provenance, C.lineage, C.spatial, C.temporal, C.device_sensor, C.statistical, C.version, C.rights, C.identifiers],
  timeoutMs: 4000,
  async run(ctx) {
    if (ctx.format === "netcdf") await netcdf(ctx);
    else if (ctx.format === "fits") fits(ctx);
    else if (ctx.format === "parquet") await parquet(ctx);
    else sqlite(ctx);
  },
};

/** Recognised-but-unparsed binaries (HDF5, executables) and unidentified binaries: honest status, never a guess. */
export const opaqueBinaryExtractor: Extractor = {
  id: "binary",
  version: "1.0.0",
  description: "HDF5 / executables / unidentified binaries: leading signature bytes, size and an explicit unavailable/unsupported status (hash comes from the http extractor).",
  kinds: ["binary"],
  formats: ["hdf5", "executable", "unknown_binary"],
  categories: [C.technical, C.file_system],
  timeoutMs: 1000,
  async run(ctx) {
    const b = ctx.response.body;
    const spec = FORMAT_BY_ID.get(ctx.format)!;
    ctx.add(C.technical, "leadingBytes", [...b.subarray(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join(" "), { status: "observed", method: "first 16 bytes (hex)" });
    ctx.add(C.file_system, "byteSize", b.length, { status: "observed", method: "body length", evidence: ctx.response.truncated ? "truncated at byte cap" : undefined });
    const reason =
      ctx.format === "unknown_binary"
        ? "unsupported_binary: no known signature matched; only hash, size and leading bytes are recorded"
        : ctx.format === "executable"
          ? "executable/native code: recognised by signature and deliberately never parsed or run"
          : `${spec.label}: recognised by signature; no safe pure-JS parser is bundled${ctx.detection.detail?.note ? ` (${String(ctx.detection.detail.note)})` : ""}`;
    ctx.add(C.technical, "parseStatus", { status: ctx.format === "unknown_binary" ? "unsupported_binary" : "unavailable", reason }, { status: "unavailable", method: "format capability registry" });
  },
};
