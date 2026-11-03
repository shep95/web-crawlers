import * as cheerio from "cheerio";
import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { clean, normalizeDate } from "../normalize.js";
import { listZipEntries, readZipEntry } from "../zip.js";

const MAX_COORDS = 2_000_000;
const MAX_KML = 8 * 1024 * 1024;

export class BBox {
  west = Infinity;
  south = Infinity;
  east = -Infinity;
  north = -Infinity;
  n = 0;
  outOfRange = 0;
  add(lon: number, lat: number) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || this.n >= MAX_COORDS) return;
    this.n++;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) this.outOfRange++;
    if (lon < this.west) this.west = lon;
    if (lon > this.east) this.east = lon;
    if (lat < this.south) this.south = lat;
    if (lat > this.north) this.north = lat;
  }
  value(round?: number) {
    if (!this.n) return null;
    const r = (x: number) => (round === undefined ? x : Math.round(x * 10 ** round) / 10 ** round);
    return { west: r(this.west), south: r(this.south), east: r(this.east), north: r(this.north) };
  }
}

function emitBbox(ctx: ExtractionContext, bb: BBox, method: string, round?: number) {
  const v = bb.value(round);
  if (!v) return;
  ctx.add(C.spatial, "boundingBox", v, { status: "observed", method, evidence: `computed from ${bb.n} coordinate(s)${bb.n >= MAX_COORDS ? " (capped)" : ""}${round !== undefined ? `; rounded to ${round} decimals` : ""}` });
  if (bb.outOfRange) ctx.add(C.quality, "coordinatesOutOfRange", bb.outOfRange, { status: "observed", method, evidence: "values outside lon ±180 / lat ±90 — projected CRS or invalid data" });
}

// ---------------------------------------------------------------- GeoJSON (RFC 7946)

function geojson(ctx: ExtractionContext, doc: unknown) {
  const o = { status: "observed" as const, method: "GeoJSON structure (RFC 7946)" };
  if (!doc || typeof doc !== "object") {
    ctx.add(C.spatial, "geojson", "root is not an object", { status: "extraction_failed", method: "GeoJSON" });
    return;
  }
  const root = doc as Record<string, unknown>;
  const features = root.type === "FeatureCollection" && Array.isArray(root.features) ? (root.features as unknown[]) : root.type === "Feature" ? [root] : [];
  const geomTypes: Record<string, number> = {};
  const props = new Map<string, Set<string>>();
  const bb = new BBox();
  let nullGeom = 0;
  const coords = (c: unknown, depth: number) => {
    if (!Array.isArray(c) || depth > 6 || bb.n >= MAX_COORDS) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") bb.add(c[0], c[1]);
    else for (const x of c) coords(x, depth + 1);
  };
  const geom = (g: unknown, depth = 0) => {
    if (!g || typeof g !== "object") {
      nullGeom++;
      return;
    }
    const gg = g as Record<string, unknown>;
    const t = String(gg.type);
    geomTypes[t] = (geomTypes[t] ?? 0) + 1;
    if (t === "GeometryCollection" && Array.isArray(gg.geometries) && depth < 4) for (const x of gg.geometries.slice(0, 1000)) geom(x, depth + 1);
    else coords(gg.coordinates, 0);
  };
  if (root.type !== "FeatureCollection" && root.type !== "Feature") geom(root);
  for (const f of features.slice(0, 200_000)) {
    const ff = f as Record<string, unknown>;
    geom(ff?.geometry);
    if (ff?.properties && typeof ff.properties === "object" && props.size < 200) {
      for (const [k, v] of Object.entries(ff.properties as Record<string, unknown>)) {
        if (!props.has(k) && props.size >= 200) continue;
        const s = props.get(k) ?? new Set<string>();
        s.add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
        props.set(k, s);
      }
    }
  }
  ctx.add(C.spatial, "geojsonType", String(root.type), o);
  ctx.add(C.structural, "featureCount", features.length, o);
  ctx.add(C.spatial, "geometryTypes", geomTypes, o);
  if (nullGeom) ctx.add(C.spatial, "featuresWithoutGeometry", nullGeom, o);
  ctx.add(C.schema, "featureProperties", [...props].slice(0, 200).map(([path, types]) => ({ path, type: [...types].join("|") })), { status: "inferred", method: "union of feature property keys" });
  if (Array.isArray(root.bbox) && root.bbox.length >= 4) {
    const b = root.bbox as number[];
    ctx.add(C.spatial, "declaredBoundingBox", { west: b[0], south: b[1], east: b[b.length / 2], north: b[b.length / 2 + 1] }, { method: "GeoJSON bbox member" });
  }
  emitBbox(ctx, bb, "GeoJSON coordinates");
  const crs = root.crs as { properties?: { name?: string } } | undefined;
  ctx.add(C.spatial, "coordinateSystem", crs?.properties?.name ?? "WGS 84 (OGC:CRS84, RFC 7946 default)", { method: crs ? "legacy crs member (GeoJSON 2008)" : "RFC 7946 default", status: crs ? "source_declared" : "inferred" });
  const name = (root.name ?? (root.properties as Record<string, unknown> | undefined)?.name) as unknown;
  if (typeof name === "string") ctx.add(C.descriptive, "title", clean(name), { method: "name member" });
}

// ---------------------------------------------------------------- KML / KMZ

function kml(ctx: ExtractionContext, xml: string, method: string) {
  const $ = cheerio.load(xml.slice(0, MAX_KML), { xml: { xmlMode: true, decodeEntities: true } });
  const o = { status: "observed" as const, method };
  const doc = $("Document, kml\\:Document").first();
  ctx.add(C.descriptive, "title", clean(doc.children("name").first().text() || $("name").first().text()), { method: `${method} Document/name` });
  ctx.add(C.descriptive, "description", clean(doc.children("description").first().text(), 1000), { method: `${method} Document/description` });
  ctx.add(C.structural, "placemarkCount", $("Placemark").length, o);
  ctx.add(C.structural, "folderCount", $("Folder").length, o);
  const geomTypes: Record<string, number> = {};
  for (const t of ["Point", "LineString", "LinearRing", "Polygon", "MultiGeometry", "Model", "gx\\:Track"]) {
    const n = $(t).length;
    if (n) geomTypes[t.replace("\\", "")] = n;
  }
  ctx.add(C.spatial, "geometryTypes", geomTypes, o);
  const bb = new BBox();
  $("coordinates").each((_, el) => {
    for (const tuple of $(el).text().trim().split(/\s+/)) {
      const [lon, lat] = tuple.split(",").map(Number);
      bb.add(lon, lat);
      if (bb.n >= MAX_COORDS) return false;
    }
    return undefined;
  });
  $("gx\\:coord").each((_, el) => {
    const [lon, lat] = $(el).text().trim().split(/\s+/).map(Number);
    bb.add(lon, lat);
  });
  emitBbox(ctx, bb, `${method} coordinates`);
  ctx.add(C.spatial, "coordinateSystem", "WGS 84 (KML 2.2 mandates EPSG:4326 lon,lat[,alt])", { method: "KML specification", status: "inferred" });
  const times = [...$("when").map((_, e) => $(e).text()).get(), ...$("begin").map((_, e) => $(e).text()).get(), ...$("end").map((_, e) => $(e).text()).get()].map((t) => normalizeDate(t)?.iso).filter((x): x is string => Boolean(x)).sort();
  if (times.length) {
    ctx.add(C.temporal, "coverageStart", times[0], { method: `${method} TimeStamp/TimeSpan` });
    ctx.add(C.temporal, "coverageEnd", times[times.length - 1], { method: `${method} TimeStamp/TimeSpan` });
  }
  const links = $("NetworkLink Link href, NetworkLink Url href").map((_, e) => $(e).text().trim()).get().filter(Boolean).slice(0, 50);
  if (links.length) ctx.add(C.relational, "networkLinks", links, { method: `${method} NetworkLink (not fetched)` });
  const names = $("Placemark > name").map((_, e) => clean($(e).text(), 120)).get().filter(Boolean).slice(0, 50);
  ctx.add(C.spatial, "namedPlaces", names, { method: `${method} Placemark/name` });
}

// ---------------------------------------------------------------- GPX 1.0/1.1

async function gpx(ctx: ExtractionContext) {
  const $ = await ctx.dom();
  const root = $("gpx").first();
  const o = { status: "observed" as const, method: "GPX structure" };
  ctx.add(C.technical, "gpxVersion", root.attr("version") ?? null, o);
  const creator = root.attr("creator");
  ctx.add(C.provenance, "creatorTool", creator ?? null, { method: "gpx@creator" });
  if (creator && /garmin|suunto|polar|wahoo|coros|fitbit|apple watch|edge|forerunner|fenix/i.test(creator)) ctx.add(C.device_sensor, "deviceModel", creator, { method: "gpx@creator (device-like)", status: "inferred" });
  const md = root.children("metadata").first();
  ctx.add(C.descriptive, "title", clean(md.children("name").text() || root.find("trk > name").first().text()), { method: "metadata/name | trk/name" });
  ctx.add(C.descriptive, "description", clean(md.children("desc").text(), 1000), { method: "metadata/desc" });
  const created = normalizeDate(md.children("time").text());
  if (created) ctx.add(C.temporal, "created", created.iso, { method: "metadata/time", original: created.original });
  ctx.add(C.structural, "waypointCount", root.children("wpt").length, o);
  ctx.add(C.structural, "routeCount", root.children("rte").length, o);
  ctx.add(C.structural, "trackCount", root.children("trk").length, o);
  ctx.add(C.structural, "trackSegmentCount", root.find("trkseg").length, o);
  const pts = root.find("trkpt, rtept, wpt");
  ctx.add(C.structural, "pointCount", pts.length, o);
  const bb = new BBox();
  const times: number[] = [];
  let eleMin = Infinity;
  let eleMax = -Infinity;
  pts.each((i, el) => {
    if (i >= MAX_COORDS) return false;
    const p = $(el);
    bb.add(Number(p.attr("lon")), Number(p.attr("lat")));
    const t = Date.parse(p.children("time").text());
    if (Number.isFinite(t)) times.push(t);
    const e = Number(p.children("ele").text());
    if (p.children("ele").length && Number.isFinite(e)) {
      eleMin = Math.min(eleMin, e);
      eleMax = Math.max(eleMax, e);
    }
    return undefined;
  });
  // Tracks are often a person's movements: report only a ~1 km rounded extent, never points.
  emitBbox(ctx, bb, "GPX lat/lon attributes", 2);
  if (times.length) {
    ctx.add(C.temporal, "coverageStart", new Date(Math.min(...times)).toISOString(), { ...o, method: "earliest point time" });
    ctx.add(C.temporal, "coverageEnd", new Date(Math.max(...times)).toISOString(), { ...o, method: "latest point time" });
  }
  if (Number.isFinite(eleMin)) ctx.add(C.spatial, "elevationRange", { min: eleMin, max: eleMax, units: "m" }, o);
  if (root.find("trkpt").length) ctx.add(C.privacy, "containsLocationTrack", true, { status: "observed", method: "GPX trkpt presence", evidence: "location traces may identify a person; points are not reproduced, extent rounded to ~1 km" });
}

/** GeoJSON, KML, KMZ and GPX: feature/geometry inventory, computed bounding boxes, time ranges, property schema. */
export const geoExtractor: Extractor = {
  id: "geo",
  version: "1.0.0",
  description: "Geospatial vector formats: GeoJSON (features, geometry types, bbox, property keys), KML/KMZ (placemarks, geometries, time spans), GPX (tracks/points/time range, rounded extent).",
  kinds: ["json", "xml", "archive"],
  formats: ["geojson", "kml", "kmz", "gpx"],
  categories: [C.spatial, C.structural, C.schema, C.descriptive, C.temporal, C.provenance, C.device_sensor, C.privacy, C.relational],
  timeoutMs: 4000,
  async run(ctx) {
    if (ctx.format === "geojson") {
      let doc: unknown;
      try {
        doc = JSON.parse((await ctx.text()).replace(/^﻿/, ""));
      } catch (err) {
        ctx.add(C.spatial, "geojson", `invalid JSON: ${(err as Error).message.slice(0, 100)}`, { status: "extraction_failed", method: "JSON.parse", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
        return;
      }
      geojson(ctx, doc);
    } else if (ctx.format === "kml") kml(ctx, await ctx.text(), "KML");
    else if (ctx.format === "kmz") {
      const entries = listZipEntries(ctx.response.body, 2000);
      const doc = entries.find((e) => /(^|\/)doc\.kml$/i.test(e.name)) ?? entries.find((e) => /\.kml$/i.test(e.name));
      if (!doc) {
        ctx.add(C.spatial, "kmz", "no .kml entry inside the KMZ", { status: "extraction_failed", method: "KMZ zip directory" });
        return;
      }
      kml(ctx, readZipEntry(ctx.response.body, doc, MAX_KML).toString("utf8"), `KMZ:${doc.name}`);
    } else await gpx(ctx);
  },
};
