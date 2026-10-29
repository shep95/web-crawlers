import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { clean, normalizeDate, splitKeywords } from "../normalize.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Walk a JSON Schema collecting properties, required, enums, ranges, patterns. */
function walkSchema(ctx: ExtractionContext, schema: Json, method: string) {
  const props: Array<{ path: string; type: unknown; description?: string | null }> = [];
  const required: string[] = [];
  const enums: Array<{ path: string; values: unknown[] }> = [];
  const ranges: Array<Record<string, unknown>> = [];
  const patterns: Array<{ path: string; pattern: string }> = [];
  const visit = (node: unknown, path: string, depth: number) => {
    if (!isObj(node) || depth > 6 || props.length > 300) return;
    if (Array.isArray(node.required)) required.push(...node.required.map((r) => (path ? `${path}.${r}` : String(r))));
    if (Array.isArray(node.enum)) enums.push({ path: path || "$", values: node.enum.slice(0, 30) });
    const r: Record<string, unknown> = {};
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]) if (node[k] !== undefined) r[k] = node[k];
    if (Object.keys(r).length) ranges.push({ path: path || "$", ...r });
    if (typeof node.pattern === "string") patterns.push({ path: path || "$", pattern: node.pattern.slice(0, 200) });
    if (isObj(node.properties)) {
      for (const [k, v] of Object.entries(node.properties)) {
        const p = path ? `${path}.${k}` : k;
        props.push({ path: p, type: isObj(v) ? v.type ?? v.$ref ?? null : null, description: isObj(v) ? clean(v.description, 200) : null });
        visit(v, p, depth + 1);
      }
    }
    if (isObj(node.items)) visit(node.items, `${path}[]`, depth + 1);
    for (const k of ["definitions", "$defs"]) if (isObj(node[k])) for (const [dk, dv] of Object.entries(node[k] as Json)) visit(dv, `#${dk}`, depth + 1);
  };
  visit(schema, "", 0);
  ctx.add(C.schema, "properties", props, { method });
  ctx.add(C.constraints, "required", required.slice(0, 200), { method });
  ctx.add(C.constraints, "enums", enums.slice(0, 100), { method });
  ctx.add(C.constraints, "ranges", ranges.slice(0, 100), { method });
  ctx.add(C.constraints, "patterns", patterns.slice(0, 100), { method });
  const semantic = props.filter((p) => p.description).slice(0, 60).map((p) => ({ field: p.path, description: p.description }));
  ctx.add(C.semantic, "fieldDescriptions", semantic, { method });
}

export const jsonExtractor: Extractor = {
  id: "json",
  version: "1.0.0",
  description: "JSON documents: JSON Schema, OpenAPI/Swagger, Frictionless Data Package, CKAN/DCAT packages, model config.json, generic shape inference.",
  kinds: ["json"],
  categories: [C.schema, C.constraints, C.semantic, C.descriptive, C.version, C.access_security, C.lineage, C.rights, C.ai_ml, C.administrative, C.structural, C.temporal, C.spatial, C.identifiers],
  timeoutMs: 3000,
  async run(ctx) {
    let doc: unknown;
    try {
      doc = JSON.parse((await ctx.text()).replace(/^﻿/, ""));
    } catch (err) {
      ctx.add(C.quality, "parseError", (err as Error).message.slice(0, 160), { status: "extraction_failed", method: "JSON.parse", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
      return;
    }
    ctx.add(C.structural, "rootType", jsonType(doc), { status: "observed", method: "JSON.parse" });
    // Every URL-valued field becomes a typed reference for the crawler (key name = purpose hint).
    const refs: Array<{ url: string; text: string; rel: string; region: string; tag: string; type: string | null }> = [];
    const walk = (v: unknown, key: string, depth: number) => {
      if (refs.length >= 1000 || depth > 8) return;
      if (typeof v === "string") {
        const relPath = /^(path|contentUrl|downloadURL|download_url|url|accessURL|\$ref|schema|license_url|href)$/i.test(key) && !/^[a-z]+:/i.test(v) && /^[\w./-]+\.\w{2,6}$/.test(v);
        if (/^https?:\/\//.test(v) || relPath) {
          try {
            refs.push({ url: new URL(v, ctx.response.finalUrl).toString(), text: key, rel: /licen/i.test(key) ? "license" : "", region: "main", tag: `json:${key}`, type: null });
          } catch {
            /* not a URL */
          }
        }
      } else if (Array.isArray(v)) v.slice(0, 500).forEach((x) => walk(x, key, depth + 1));
      else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    };
    walk(doc, "", 0);
    ctx.shared.set("references", refs);
    if (Array.isArray(doc)) {
      ctx.add(C.structural, "itemCount", doc.length, { status: "observed", method: "array length" });
      const sample = doc.find(isObj);
      if (sample) ctx.add(C.schema, "properties", Object.entries(sample).slice(0, 80).map(([k, v]) => ({ path: `[].${k}`, type: jsonType(v) })), { status: "inferred", method: "first object element" });
      return;
    }
    if (!isObj(doc)) return;
    const d = doc;

    // JSON Schema
    if (typeof d.$schema === "string" && /json-schema/.test(d.$schema)) {
      ctx.add(C.schema, "schemaType", `JSON Schema (${d.$schema})`, { method: "$schema" });
      ctx.add(C.descriptive, "title", clean(d.title), { method: "schema title" });
      ctx.add(C.descriptive, "description", clean(d.description, 1000), { method: "schema description" });
      walkSchema(ctx, d, "json-schema keywords");
      return;
    }
    // OpenAPI / Swagger
    if (typeof d.openapi === "string" || typeof d.swagger === "string") {
      const info = isObj(d.info) ? d.info : {};
      ctx.add(C.schema, "schemaType", d.openapi ? `OpenAPI ${d.openapi}` : `Swagger ${d.swagger}`, { method: "openapi|swagger" });
      ctx.add(C.descriptive, "title", clean(info.title), { method: "info.title" });
      ctx.add(C.descriptive, "description", clean(info.description, 1000), { method: "info.description" });
      ctx.add(C.version, "version", str(info.version), { method: "info.version" });
      const lic = isObj(info.license) ? info.license : null;
      if (lic) ctx.add(C.rights, "license", clean(lic.name ?? lic.identifier), { method: "info.license", evidence: str(lic.url) ?? undefined });
      const paths = isObj(d.paths) ? Object.keys(d.paths) : [];
      ctx.add(C.schema, "apiPaths", paths.length, { method: "paths" });
      ctx.add(C.structural, "endpoints", paths.slice(0, 60), { method: "paths" });
      const comps = isObj(d.components) ? d.components : d;
      const schemas = isObj(comps.schemas) ? comps.schemas : isObj(d.definitions) ? (d.definitions as Json) : {};
      ctx.add(C.schema, "models", Object.keys(schemas).slice(0, 100), { method: "components.schemas" });
      for (const [name, s] of Object.entries(schemas).slice(0, 15)) if (isObj(s)) walkSchema(ctx, { properties: { [name]: s } }, `openapi schema ${name}`);
      const sec = isObj(comps.securitySchemes) ? comps.securitySchemes : isObj(d.securityDefinitions) ? (d.securityDefinitions as Json) : {};
      ctx.add(C.access_security, "securitySchemes", Object.entries(sec).map(([k, v]) => ({ name: k, type: isObj(v) ? v.type : null, scheme: isObj(v) ? v.scheme ?? v.in ?? null : null })), { method: "securitySchemes" });
      const servers = Array.isArray(d.servers) ? d.servers.map((s) => (isObj(s) ? str(s.url) : null)).filter(Boolean) : [];
      ctx.add(C.network, "declaredServers", servers, { method: "servers[]" });
      return;
    }
    // Frictionless Data Package
    if (Array.isArray(d.resources) && (d.profile || d.name) && d.resources.some((r) => isObj(r) && (r.path || r.data || r.schema))) {
      ctx.add(C.schema, "schemaType", "Frictionless Data Package", { method: "datapackage.json" });
      ctx.add(C.descriptive, "title", clean(d.title ?? d.name), { method: "title|name" });
      ctx.add(C.descriptive, "description", clean(d.description, 1000), { method: "description" });
      ctx.add(C.descriptive, "keywords", Array.isArray(d.keywords) ? d.keywords.map(String) : [], { method: "keywords" });
      ctx.add(C.version, "version", str(d.version), { method: "version" });
      const lic = Array.isArray(d.licenses) ? d.licenses.filter(isObj).map((l) => str(l.name) ?? str(l.title) ?? str(l.path)).filter(Boolean) : [];
      for (const l of lic) ctx.add(C.rights, "license", l, { method: "licenses[]" });
      const sources = Array.isArray(d.sources) ? d.sources.filter(isObj).map((s) => str(s.title) ?? str(s.path)).filter(Boolean) : [];
      ctx.add(C.lineage, "sources", sources, { method: "sources[]" });
      const created = normalizeDate(d.created);
      if (created) ctx.add(C.temporal, "created", created.iso, { method: "created", original: created.original });
      const cols: unknown[] = [];
      for (const r of d.resources.filter(isObj).slice(0, 20)) {
        const s = isObj(r.schema) ? r.schema : null;
        const fields = s && Array.isArray(s.fields) ? s.fields.filter(isObj) : [];
        for (const f of fields.slice(0, 80)) {
          cols.push({ resource: r.name ?? r.path, name: f.name, type: f.type, format: f.format, description: clean(f.description, 160) });
          if (isObj(f.constraints)) ctx.add(C.constraints, "fieldConstraints", [{ field: `${r.name}.${f.name}`, ...f.constraints }], { method: "schema.fields[].constraints" });
        }
        if (s && s.primaryKey) ctx.add(C.constraints, "primaryKey", [{ resource: r.name, key: s.primaryKey }], { method: "schema.primaryKey" });
      }
      ctx.add(C.schema, "columns", cols, { method: "resources[].schema.fields" });
      return;
    }
    // CKAN package_show / DCAT-ish dataset JSON
    // Internet Archive item manifest (archive.org/metadata/<id>): each file is a standalone resource.
    if (isObj(d.metadata) && Array.isArray(d.files) && typeof d.dir === "string") {
      const md = d.metadata;
      const id = str(md.identifier) ?? "";
      ctx.add(C.descriptive, "title", clean(md.title), { method: "ia metadata.title" });
      ctx.add(C.descriptive, "description", clean(Array.isArray(md.description) ? md.description[0] : md.description, 1000), { method: "ia metadata.description" });
      ctx.add(C.descriptive, "author", Array.isArray(md.creator) ? md.creator.map(String) : md.creator ? [String(md.creator)] : [], { method: "ia metadata.creator" });
      ctx.add(C.rights, "licenseUrl", str(md.licenseurl), { method: "ia metadata.licenseurl" });
      ctx.add(C.identifiers, "identifier", id ? [`ia:${id}`] : [], { method: "ia metadata.identifier" });
      ctx.add(C.administrative, "collectionOwner", Array.isArray(md.collection) ? md.collection.map(String).join(", ") : str(md.collection), { method: "ia metadata.collection" });
      const files = (d.files as Json[]).filter((f) => f.source === "original" && typeof f.name === "string").slice(0, 200);
      ctx.add(C.structural, "entryCount", files.length, { method: "ia files[] (originals)" });
      ctx.add(C.integrity, "publishedChecksums", files.slice(0, 50).map((f) => ({ file: f.name, md5: f.md5 ?? null, sha1: f.sha1 ?? null })), { method: "ia files[].md5/sha1", evidence: "publisher-provided digests for each file" });
      ctx.add(C.preservation, "archived", true, { method: "Internet Archive item" });
      ctx.shared.set("references", files.filter((f) => Number(f.size ?? 0) < 40_000_000).map((f) => ({ url: `https://archive.org/download/${encodeURIComponent(id)}/${String(f.name).split("/").map(encodeURIComponent).join("/")}`, text: `${f.format ?? ""} ${f.name}`, rel: "", region: "main", tag: "listing", type: str(f.format) })));
      return;
    }
    // Google Cloud Storage public object listing.
    if (d.kind === "storage#objects" && Array.isArray(d.items)) {
      const items = (d.items as Json[]).slice(0, 1000);
      ctx.add(C.structural, "entryCount", items.length, { method: "gcs objects.list" });
      ctx.add(C.file_system, "listing", items.slice(0, 100).map((o) => ({ name: o.name, size: Number(o.size), contentType: o.contentType, updated: o.updated })), { method: "gcs objects.list", evidence: "source-reported object properties" });
      ctx.add(C.integrity, "publishedChecksums", items.slice(0, 50).map((o) => ({ file: o.name, md5Base64: o.md5Hash ?? null, crc32c: o.crc32c ?? null })), { method: "gcs md5Hash/crc32c" });
      ctx.shared.set("references", items.filter((o) => typeof o.mediaLink === "string" && Number(o.size ?? 0) < 40_000_000).map((o) => ({ url: String(o.mediaLink), text: String(o.name), rel: "", region: "main", tag: "listing", type: str(o.contentType) })));
      return;
    }
    const pkg = isObj(d.result) && (d.result.resources || d.result.notes) ? d.result : d.notes !== undefined && Array.isArray(d.resources) ? d : null;
    if (pkg) {
      ctx.add(C.schema, "schemaType", "CKAN package", { method: "ckan package fields" });
      ctx.add(C.descriptive, "title", clean(pkg.title), { method: "ckan title" });
      ctx.add(C.descriptive, "description", clean(pkg.notes, 1000), { method: "ckan notes" });
      ctx.add(C.rights, "license", clean(pkg.license_title ?? pkg.license_id), { method: "ckan license" });
      ctx.add(C.administrative, "maintainer", clean(pkg.maintainer ?? (isObj(pkg.organization) ? pkg.organization.title : null)), { method: "ckan maintainer|organization" });
      ctx.add(C.administrative, "recordIdentifier", str(pkg.id), { method: "ckan id" });
      ctx.add(C.administrative, "status", str(pkg.state), { method: "ckan state" });
      for (const [k, f] of [["metadata_created", "created"], ["metadata_modified", "modified"]] as const) {
        const dt = normalizeDate(pkg[k]);
        if (dt) ctx.add(C.temporal, f, dt.iso, { method: `ckan ${k}`, original: dt.original });
      }
      const extras = Array.isArray(pkg.extras) ? pkg.extras.filter(isObj) : [];
      for (const e of extras) {
        if (e.key === "spatial") ctx.add(C.spatial, "spatialCoverage", clean(e.value, 400), { method: "ckan extras.spatial" });
        if (e.key === "temporal") ctx.add(C.temporal, "temporalCoverage", clean(e.value), { method: "ckan extras.temporal" });
        if (e.key === "accrualPeriodicity") ctx.add(C.operational, "refreshInterval", clean(e.value), { method: "ckan extras.accrualPeriodicity" });
      }
      ctx.add(C.descriptive, "keywords", Array.isArray(pkg.tags) ? pkg.tags.filter(isObj).map((t) => String(t.display_name ?? t.name)) : [], { method: "ckan tags" });
      return;
    }
    // ML model config (Hugging Face config.json)
    if (Array.isArray(d.architectures) || typeof d.model_type === "string") {
      ctx.add(C.ai_ml, "architectures", Array.isArray(d.architectures) ? d.architectures.map(String) : [], { method: "config.json architectures" });
      ctx.add(C.ai_ml, "modelType", str(d.model_type), { method: "config.json model_type" });
      const hp = Object.fromEntries(["hidden_size", "num_hidden_layers", "num_attention_heads", "vocab_size", "max_position_embeddings", "torch_dtype", "transformers_version"].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
      ctx.add(C.ai_ml, "hyperparameters", hp, { method: "config.json" });
    }
    // Generic: top-level keys + inferred types
    const keys = Object.entries(d).slice(0, 80).map(([k, v]) => ({ path: k, type: jsonType(v) }));
    ctx.add(C.schema, "properties", keys, { status: "inferred", method: "top-level key types" });
    ctx.add(C.descriptive, "title", clean(d.title ?? d.name), { method: "title|name key" });
    ctx.add(C.descriptive, "description", clean(d.description, 1000), { method: "description key" });
    ctx.add(C.version, "version", str(d.version), { method: "version key" });
    if (typeof d.license === "string") ctx.add(C.rights, "license", d.license, { method: "license key" });
  },
};

// ---------------------------------------------------------------- CSV

function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function inferType(values: string[]): string {
  const vs = values.filter((v) => v !== "");
  if (!vs.length) return "empty";
  if (vs.every((v) => /^-?\d+$/.test(v))) return "integer";
  if (vs.every((v) => /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(v))) return "number";
  if (vs.every((v) => /^(true|false|yes|no|0|1)$/i.test(v))) return "boolean";
  if (vs.every((v) => normalizeDate(v) !== null && /\d{4}|\d{1,2}[/-]\d{1,2}/.test(v))) return "date";
  return "string";
}

const r_nonEmpty = (a: number, b: number) => !(a === 0 && b === 0);

export const csvExtractor: Extractor = {
  id: "csv",
  version: "1.0.0",
  description: "Delimited text: dialect detection, header, inferred column types, null rates and numeric statistics over the fetched sample.",
  kinds: ["csv"],
  categories: [C.schema, C.structural, C.statistical, C.quality, C.descriptive, C.semantic, C.identifiers, C.spatial, C.temporal],
  timeoutMs: 4000,
  async run(ctx) {
    const text = (await ctx.text()).replace(/^﻿/, "");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (ctx.response.truncated) lines.pop(); // last line may be partial
    if (lines.length < 1) return;
    const first = lines[0];
    const delim = [",", "\t", ";", "|"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
    const header = parseCsvLine(first, delim);
    const rows = lines.slice(1, 20001).map((l) => parseCsvLine(l, delim));
    const o = { status: "observed" as const, method: "csv parse" };
    ctx.add(C.technical, "delimiter", delim === "\t" ? "\\t" : delim, o);
    ctx.add(C.structural, "columnCount", header.length, o);
    ctx.add(C.structural, "rowCount", rows.length, { ...o, evidence: ctx.response.truncated || lines.length > 20001 ? "sampled rows only (body/row cap)" : "all rows" });
    const ragged = rows.filter((r) => r.length !== header.length).length;
    let nulls = 0;
    const columns = header.map((name, i) => {
      const vals = rows.map((r) => r[i] ?? "");
      const empty = vals.filter((v) => v === "" || /^(na|n\/a|null|none|nan)$/i.test(v)).length;
      nulls += empty;
      const type = inferType(vals.slice(0, 2000));
      const col: Record<string, unknown> = { name, type, nullRate: rows.length ? Number((empty / rows.length).toFixed(4)) : null, distinct: new Set(vals.slice(0, 5000)).size };
      return col;
    });
    ctx.add(C.schema, "columns", columns.map((c) => ({ name: c.name, type: c.type })), { status: "inferred", method: "csv header + type inference" });
    ctx.add(C.descriptive, "columnNames", header.slice(0, 100), { method: "csv header" });
    const stats = columns
      .map((c, i) => {
        if (c.type !== "integer" && c.type !== "number") return { name: c.name, type: c.type, nullRate: c.nullRate, distinct: c.distinct };
        const nums = rows.map((r) => (r[i] ?? "").trim()).filter((v) => v !== "").map(Number).filter((n) => Number.isFinite(n));
        const mean = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
        const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length || 1));
        return { name: c.name, type: c.type, nullRate: c.nullRate, distinct: c.distinct, min: Math.min(...nums), max: Math.max(...nums), mean: Number(mean.toFixed(4)), stdDev: Number(sd.toFixed(4)), n: nums.length };
      })
      .slice(0, 100);
    ctx.add(C.statistical, "columnStats", stats, { status: "inferred", method: "computed over fetched rows" });
    ctx.add(C.statistical, "sampleSize", rows.length, { status: "observed", method: "row count of sample" });
    const cells = rows.length * header.length;
    ctx.add(C.quality, "nullRate", cells ? Number((nulls / cells).toFixed(4)) : null, { status: "observed", method: "empty/NA cells ÷ cells" });
    ctx.add(C.quality, "raggedRows", ragged, { status: "observed", method: "rows whose width ≠ header width" });
    const rowKeys = rows.map((r) => r.join("\u0001"));
    const dupRows = rowKeys.length - new Set(rowKeys).size;
    ctx.add(C.quality, "duplicateRate", rows.length ? Number((dupRows / rows.length).toFixed(4)) : 0, { status: "observed", method: "identical rows ÷ rows", evidence: `${dupRows} duplicate row(s)` });

    // Units declared in column headers: "snowfall_cm", "temp (°C)", "depth [m]".
    const UNIT_SUFFIX = /(?:[\s_(\[]|^)(mm|cm|m|km|kg|g|mg|l|ml|°c|degc|celsius|°f|fahrenheit|k|kelvin|pa|hpa|kpa|mb|mbar|%|pct|percent|ppm|ppb|m\/s|km\/h|mph|kwh|mw|kw|w|usd|eur|inr|gbp|hours?|hrs?|days?|years?|min|sec|s)[\])]?$/i;
    const units = header.map((h) => ({ column: h, unit: h.match(UNIT_SUFFIX)?.[1] ?? null })).filter((u) => u.unit);
    ctx.add(C.semantic, "units", units, { status: "inferred", method: "unit token in column header", evidence: "units read from header names, not from a published codebook" });

    // Identifier columns.
    const idCols = header.filter((h) => /(^|_|\b)(id|uuid|code|identifier|doi|isbn|station(_?id)?)$/i.test(h));
    ctx.add(C.identifiers, "identifierColumns", idCols, { status: "inferred", method: "column-name pattern" });

    // Geographic coverage computed from coordinate columns (a measurement of the data, not a claim).
    const latI = header.findIndex((h) => /^(lat|latitude|y)$/i.test(h.trim()));
    const lonI = header.findIndex((h) => /^(lon|lng|long|longitude|x)$/i.test(h.trim()));
    if (latI >= 0 && lonI >= 0) {
      const pts = rows.map((r) => [Number(r[latI]), Number(r[lonI])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && r_nonEmpty(a, b));
      if (pts.length) {
        const lats = pts.map((p) => p[0]);
        const lons = pts.map((p) => p[1]);
        ctx.add(C.spatial, "boundingBox", { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons), points: pts.length }, { status: "observed", method: "computed from latitude/longitude columns", evidenceType: "system_measurement" });
      }
    }
    const placeI = header.findIndex((h) => /^(station|site|location|place|city|district|region|state|country|name)$/i.test(h.trim()));
    if (placeI >= 0) ctx.add(C.spatial, "namedPlaces", [...new Set(rows.map((r) => r[placeI]).filter(Boolean))].slice(0, 30), { method: `values of column "${header[placeI]}"`, evidence: "place names listed in the data" });
    // Temporal coverage computed from date columns.
    const dateI = columns.findIndex((c) => c.type === "date");
    if (dateI >= 0) {
      const ds = rows.map((r) => normalizeDate(r[dateI])?.iso).filter(Boolean).sort() as string[];
      if (ds.length) ctx.add(C.temporal, "temporalCoverage", `${ds[0].slice(0, 10)}/${ds[ds.length - 1].slice(0, 10)}`, { status: "observed", method: `range of column "${header[dateI]}"`, evidenceType: "system_measurement" });
    }
    const dupHeader = header.length - new Set(header).size;
    if (dupHeader) ctx.add(C.quality, "duplicateColumnNames", dupHeader, { status: "observed", method: "header uniqueness" });
  },
};

// ---------------------------------------------------------------- XML & feeds

export const xmlExtractor: Extractor = {
  id: "xml",
  version: "1.0.0",
  description: "XML: root/namespaces/XSD, sitemaps, RSS/Atom feeds, Dublin Core/DataCite/EML records.",
  kinds: ["xml", "feed"],
  categories: [C.semantic, C.schema, C.discovery, C.descriptive, C.temporal, C.structural, C.operational, C.audit, C.identifiers, C.rights, C.spatial, C.file_system],
  timeoutMs: 4000,
  async run(ctx) {
    const $ = await ctx.dom();
    const root = $.root().children().filter((_, el) => el.type === "tag").first();
    const rootName = root.prop("tagName")?.toLowerCase() ?? null;
    ctx.add(C.structural, "rootElement", rootName, { status: "observed", method: "xml root" });
    const attrs = (root.attr() ?? {}) as Record<string, string>;
    const ns = Object.entries(attrs).filter(([k]) => k === "xmlns" || k.startsWith("xmlns:")).map(([k, v]) => ({ prefix: k.split(":")[1] ?? "", uri: v }));
    ctx.add(C.semantic, "xmlNamespaces", ns.slice(0, 40), { method: "xmlns attributes" });
    const xsd = (attrs["xsi:schemaLocation"] ?? attrs["xsi:noNamespaceSchemaLocation"] ?? "").split(/\s+/).filter((s) => /\.xsd/i.test(s));
    ctx.add(C.schema, "xsd", xsd, { method: "xsi:schemaLocation" });
    const T = (sel: string) => clean($(sel).first().text(), 500);

    if (rootName === "urlset" || rootName === "sitemapindex") {
      const locs = $("loc").map((_, el) => $(el).text().trim()).get();
      const lastmods = $("url").map((_, el) => $(el).find("lastmod").text().trim()).get();
      ctx.shared.set("references", locs.slice(0, 5000).map((u, i) => ({ url: u, text: lastmods[i] ?? "", rel: rootName === "sitemapindex" ? "sitemap" : "", region: "main", tag: "sitemap", type: rootName === "sitemapindex" ? "sitemap" : null })));
      ctx.add(C.discovery, "sitemapType", rootName, { status: "observed", method: "sitemap root" });
      ctx.add(C.discovery, "sitemapEntries", locs.length, { status: "observed", method: "count(loc)", evidence: ctx.response.truncated ? "truncated sitemap" : undefined });
      ctx.add(C.discovery, "sitemapSample", locs.slice(0, 25), { method: "loc" });
      const mods = $("lastmod").map((_, el) => normalizeDate($(el).text())?.iso).get().filter(Boolean).sort();
      if (mods.length) ctx.add(C.temporal, "modified", mods[mods.length - 1], { method: "max(lastmod)" });
      const freq = $("changefreq").map((_, el) => $(el).text().trim()).get();
      if (freq.length) ctx.add(C.operational, "refreshInterval", [...new Set(freq)].slice(0, 5).join(", "), { method: "changefreq" });
      return;
    }
    if (rootName === "rss" || rootName === "feed" || rootName === "rdf:rdf") {
      const atom = rootName === "feed";
      ctx.add(C.descriptive, "title", atom ? T("feed > title") : T("channel > title"), { method: "feed title" });
      ctx.add(C.descriptive, "description", atom ? T("feed > subtitle") : T("channel > description"), { method: "feed description" });
      ctx.add(C.descriptive, "language", T("channel > language") ?? attrs["xml:lang"] ?? null, { method: "feed language" });
      ctx.add(C.rights, "copyright", atom ? T("feed > rights") : T("channel > copyright"), { method: "feed rights|copyright" });
      const items = atom ? $("entry") : $("item");
      ctx.add(C.structural, "itemCount", items.length, { status: "observed", method: "count(item|entry)" });
      const entries = items.slice(0, 25).map((_, el) => {
        const e = $(el);
        const link = atom ? e.find("link[href]").first().attr("href") : e.find("link").first().text().trim();
        const date = normalizeDate(e.find(atom ? "updated, published" : "pubDate, dc\\:date").first().text());
        return { title: clean(e.find("title").first().text(), 200), url: link || null, date: date?.iso ?? null };
      }).get();
      ctx.add(C.audit, "changeEntries", entries, { method: "feed items (public change log)" });
      for (const e of entries) if (e.url) ctx.relate("has_part", e.url, `feed item: ${e.title ?? ""}`, "feed item link");
      const allLinks = items.map((_, el) => { const e = $(el); return (atom ? e.find("link[href]").first().attr("href") : e.find("link").first().text().trim()) || null; }).get().filter(Boolean) as string[];
      const enclosures = items.map((_, el) => $(el).find("enclosure[url], media\\:content[url]").map((__, x) => $(x).attr("url")).get()).get() as string[];
      ctx.shared.set("references", [...allLinks.map((u) => ({ url: u, text: "feed item", rel: "", region: "main", tag: "feed", type: null })), ...enclosures.map((u) => ({ url: u, text: "enclosure", rel: "", region: "main", tag: "source", type: null }))]);
      const dates = entries.map((e) => e.date).filter(Boolean).sort() as string[];
      if (dates.length) {
        ctx.add(C.temporal, "modified", dates[dates.length - 1], { method: "latest item date" });
        if (dates.length > 2) {
          const span = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (dates.length - 1) / 3600_000;
          ctx.add(C.operational, "observedPublishIntervalHours", Number(span.toFixed(1)), { status: "inferred", method: "mean gap between item dates" });
        }
      }
      const ttl = T("channel > ttl") ?? T("sy\\:updatePeriod");
      if (ttl) ctx.add(C.operational, "refreshInterval", ttl, { method: "ttl|sy:updatePeriod" });
      ctx.add(C.discovery, "feedFormat", atom ? "Atom" : rootName === "rss" ? `RSS ${attrs.version ?? ""}`.trim() : "RSS 1.0 (RDF)", { status: "observed", method: "feed root" });
      return;
    }
    // S3-compatible public bucket listing (ListBucketResult): every key is a standalone file.
    if (rootName === "listbucketresult") {
      const bucketBase = (() => {
        const u = new URL(ctx.response.finalUrl);
        u.search = "";
        return u.toString().replace(/\/?$/, "/");
      })();
      const contents = $("Contents").map((_, el) => ({ key: $(el).find("Key").text(), size: Number($(el).find("Size").text()), modified: normalizeDate($(el).find("LastModified").text())?.iso ?? null, etag: $(el).find("ETag").text().replace(/"/g, "") })).get();
      ctx.add(C.structural, "entryCount", contents.length, { status: "observed", method: "ListBucketResult/Contents" });
      ctx.add(C.file_system, "listing", contents.slice(0, 100), { method: "ListBucketResult", evidence: "source-reported object keys, sizes and modification times" });
      ctx.add(C.discovery, "storageListing", { bucket: T("Name"), truncated: T("IsTruncated") === "true" }, { method: "ListBucketResult" });
      const files = contents.filter((c) => c.key && !c.key.endsWith("/") && c.size < 40_000_000);
      const refs = files.map((c) => ({ url: bucketBase + c.key.split("/").map(encodeURIComponent).join("/"), text: c.key, rel: "", region: "main", tag: "listing", type: null as string | null }));
      const next = T("NextContinuationToken");
      if (T("IsTruncated") === "true" && next) refs.push({ url: `${bucketBase}?list-type=2&continuation-token=${encodeURIComponent(next)}`, text: "next listing page", rel: "next", region: "main", tag: "listing", type: "listing" });
      ctx.shared.set("references", refs);
      return;
    }
    // DataCite / Dublin Core / generic records
    const doi = $('identifier[identifierType="DOI"]').first().text().trim();
    if (doi) ctx.add(C.identifiers, "doi", [doi.toLowerCase()], { method: "datacite identifier" });
    ctx.add(C.descriptive, "title", T("title") ?? T("dc\\:title"), { method: "xml title" });
    ctx.add(C.descriptive, "author", $("creatorName, dc\\:creator").map((_, el) => clean($(el).text(), 120)).get().slice(0, 30), { method: "creatorName|dc:creator" });
    ctx.add(C.descriptive, "description", T("description") ?? T("dc\\:description") ?? T("abstract"), { method: "xml description" });
    ctx.add(C.rights, "rightsStatement", T("rights") ?? T("dc\\:rights"), { method: "rights|dc:rights" });
    ctx.add(C.spatial, "placename", T("geoLocationPlace"), { method: "datacite geoLocationPlace" });
    const bbox = $("geoLocationBox").first();
    if (bbox.length) {
      ctx.add(C.spatial, "boundingBox", { west: Number(bbox.find("westBoundLongitude").text()), east: Number(bbox.find("eastBoundLongitude").text()), south: Number(bbox.find("southBoundLatitude").text()), north: Number(bbox.find("northBoundLatitude").text()) }, { method: "datacite geoLocationBox" });
    }
    ctx.add(C.descriptive, "keywords", splitKeywords($("subject, keyword, dc\\:subject").map((_, el) => $(el).text()).get().join(",")), { method: "subject|keyword" });
    ctx.add(C.structural, "elementCount", $("*").length, { status: "observed", method: "count(*)" });
  },
};
