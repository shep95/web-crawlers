import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import { detectFormat, FORMATS, FORMAT_BY_ID } from "../src/metadata/formats.js";
import { CATEGORY_BY_ID } from "../src/metadata/categories.js";
import { EXTRACTORS } from "../src/metadata/extractors/index.js";
import type { ResourceRecord } from "../src/metadata/types.js";
import * as F from "./fixtures/build.js";
import * as X from "./fixtures/formats.js";

const run = (body: Buffer | string, name: string, headers: Record<string, string> = {}, truncated = false) => {
  const res = F.response(body, headers, `https://fixture.test/files/${name}`);
  res.truncated = truncated;
  return analyzeResponse(res, { sourceType: "url", enrich: false });
};
const vals = (r: ResourceRecord, cat: number, field: string) => r.fields.filter((f) => f.category === cat && f.field === field);
const val = (r: ResourceRecord, cat: number, field: string) => vals(r, cat, field)[0]?.value as any;
const det = (r: ResourceRecord) => val(r, 4, "formatDetection");
const state = (r: ResourceRecord, id: number) => r.categories.find((c) => c.id === id)!;
const noErrors = (r: ResourceRecord) => {
  expect(r.processing.extractors.filter((e) => e.error)).toEqual([]);
  expect(r.quality.notes.filter((n) => n.startsWith("schema:"))).toEqual([]);
};

describe("format capability registry", () => {
  it("every entry is well-formed, references real categories and existing extractors", () => {
    const ids = new Set<string>();
    const extractorIds = new Set(EXTRACTORS.map((e) => e.id));
    for (const f of FORMATS) {
      expect(ids.has(f.id), f.id).toBe(false);
      ids.add(f.id);
      expect(["implemented", "partial", "signature_only", "unsupported"]).toContain(f.status);
      for (const c of f.categories) expect(CATEGORY_BY_ID.has(c), `${f.id}:${c}`).toBe(true);
      if (f.status === "signature_only") expect(f.parser).toBeNull();
      if (f.parser && f.status !== "unsupported") {
        const first = f.parser.split(/[ +|(]/)[0];
        expect(extractorIds.has(first), `${f.id} parser ${first}`).toBe(true);
      }
    }
    // every format-gated extractor points at registry ids
    for (const e of EXTRACTORS) for (const id of e.formats ?? []) expect(FORMAT_BY_ID.has(id), `${e.id}→${id}`).toBe(true);
  });
});

describe("signature-first detection", () => {
  it("a PDF named .jpg is detected as PDF with an extension-mismatch note", async () => {
    const r = await run(await F.pdf(), "photo.jpg", { "content-type": "image/jpeg" });
    expect(r.kind).toBe("pdf");
    expect(r.format?.id).toBe("pdf");
    expect(det(r)).toMatchObject({ format: "pdf", method: "signature", extension: "jpg", extensionAgrees: false, declaredAgrees: false });
    expect(r.quality.extensionMismatch).toEqual({ extension: "jpg", suggests: ["jpeg"], detected: "pdf" });
    expect(r.quality.notes.join(" ")).toMatch(/\.jpg suggests jpeg but the bytes are pdf/);
  });
  it("unknown binary: hash + size + leading bytes + unsupported_binary status", async () => {
    const body = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0x99, 0x00, 0x13, 0x37, ...Array(200).fill(0x00)]);
    const r = await run(body, "blob.bin");
    expect(r.format?.id).toBe("unknown_binary");
    expect(val(r, 41, "sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(val(r, 28, "byteSize")).toBe(208);
    expect(val(r, 4, "parseStatus")).toMatchObject({ status: "unsupported_binary" });
    expect(vals(r, 4, "parseStatus")[0].status).toBe("unavailable");
  });
  it("detects signatures of 7z, RAR, HDF5, xz and executables without parsing them", () => {
    expect(detectFormat(Buffer.from("377abcaf271c000400", "hex"), null, "x.7z").format).toBe("7z");
    expect(detectFormat(Buffer.from("Rar!\x1a\x07\x01\x00", "latin1"), null, "x.rar").format).toBe("rar");
    expect(detectFormat(Buffer.from("\x89HDF\r\n\x1a\n\0\0\0\0", "latin1"), null, "x.nc").format).toBe("hdf5");
    expect(detectFormat(Buffer.from("fd377a585a000004", "hex"), null, null).format).toBe("xz");
    expect(detectFormat(Buffer.from("\x7fELF\x02\x01\x01", "latin1"), null, "run.dat").format).toBe("executable");
  });
});

describe("archives", () => {
  it("tar: entries, manifests and child resources with original relative paths", async () => {
    const r = await run(X.tar([{ name: "bag/bagit.txt", body: "BagIt-Version: 1.0\n" }, { name: "bag/data/rain.csv", body: F.CSV }, { name: "bag/link", type: "2", link: "../../etc/passwd" }]), "bag.tar");
    noErrors(r);
    expect(val(r, 4, "archiveFormat")).toBe("tar");
    expect(val(r, 2, "entryCount")).toBe(3);
    expect(val(r, 5, "packaging")).toBe("BagIt");
    expect(val(r, 2, "childResources").map((c: any) => c.path)).toContain("bag/data/rain.csv");
    expect(val(r, 7, "linkEntries")).toEqual([{ path: "bag/link", target: "../../etc/passwd", type: "symlink" }]);
  });
  it("tar.gz and single-file gzip", async () => {
    const tgz = await run(X.gzip(X.tar([{ name: "a/readme.md", body: "# hi\n" }])), "a.tgz");
    expect(tgz.format?.id).toBe("tar_gz");
    expect(val(tgz, 4, "archiveFormat")).toBe("tar.gz");
    expect(val(tgz, 2, "childResources")).toEqual([{ path: "a/readme.md", size: 5 }]);
    const gz = await run(X.gzip(F.CSV), "rain.csv.gz");
    expect(gz.format?.id).toBe("gzip");
    expect(val(gz, 28, "decompressedBytes")).toBe(Buffer.byteLength(F.CSV));
    expect(val(gz, 2, "childResources")).toEqual([{ path: "rain.csv", size: Buffer.byteLength(F.CSV) }]);
  });
  it("nested zip-in-tar.gz-in-zip is enumerated with depth-qualified paths", async () => {
    const inner = X.zipX([{ name: "deep/notes.txt", body: "deep text" }]);
    const mid = X.gzip(X.tar([{ name: "inner.zip", body: inner }]));
    const r = await run(X.zipX([{ name: "mid.tar.gz", body: mid }, { name: "top.json", body: "{}" }]), "outer.zip");
    noErrors(r);
    const nested = val(r, 2, "nestedArchives");
    expect(nested.map((n: any) => n.format)).toEqual(["tar_gz", "zip"]);
    expect(val(r, 2, "childResources").map((c: any) => c.path)).toEqual(["mid.tar.gz!/inner.zip!/deep/notes.txt", "top.json"]);
  });
  it("rejects path traversal entries (zip-slip)", async () => {
    const r = await run(X.zipX([{ name: "../../x", body: "evil" }, { name: "/etc/cron", body: "evil" }, { name: "ok.txt", body: "fine" }]), "slip.zip");
    expect(val(r, 7, "pathTraversalRejected")).toEqual([{ path: "../../x", reason: "parent_traversal" }, { path: "/etc/cron", reason: "absolute_path" }]);
    expect(val(r, 2, "childResources")).toEqual([{ path: "ok.txt", size: 4 }]);
  });
  it("zip bomb: high-ratio entry is not inflated; lying size header is capped", async () => {
    const r = await run(X.zipX([{ name: "zeros.txt", body: Buffer.alloc(20 * 1024 * 1024) }, { name: "liar.csv", body: Buffer.alloc(8 * 1024 * 1024, 0x41), declared: 100 }]), "bomb.zip");
    const bombs = val(r, 7, "zipBombSuspected");
    expect(bombs.map((b: any) => b.path)).toEqual(["zeros.txt", "liar.csv"]);
    expect(bombs[0].reason).toMatch(/ratio/);
    expect(bombs[1].reason).toMatch(/inflates beyond/);
    expect(val(r, 2, "childResources")).toBeUndefined();
  });
  it("too many entries stops at the entry budget and says so", async () => {
    const { ARCHIVE_LIMITS } = await import("../src/metadata/extractors/archive.js");
    const saved = ARCHIVE_LIMITS.maxEntries;
    ARCHIVE_LIMITS.maxEntries = 50;
    try {
      const r = await run(X.zipX(Array.from({ length: 120 }, (_, i) => ({ name: `f${i}.bin`, body: "x" }))), "many.zip");
      expect(val(r, 2, "totalEntryCount")).toBe(50);
      expect(val(r, 4, "archiveLimits").limitsHit).toContain("max_entries");
      expect(val(r, 20, "archiveTruncated")).toContain("max_entries");
    } finally {
      ARCHIVE_LIMITS.maxEntries = saved;
    }
  });
  it("encrypted zip: listing observed, contents unavailable without credentials", async () => {
    const r = await run(X.zipX([{ name: "secret.csv", body: "a,b\n1,2\n", encrypted: true }]), "locked.zip");
    expect(val(r, 7, "encryptedEntries")).toEqual({ count: 1, examples: ["secret.csv"] });
    expect(vals(r, 4, "parseStatus")[0]).toMatchObject({ status: "unavailable" });
    expect(val(r, 2, "childResources")).toBeUndefined();
  });
  it("7z and RAR are signature-only: honest unavailable coverage", async () => {
    for (const [name, body] of [["a.7z", Buffer.from("377abcaf271c0004aabbccdd00000000", "hex")], ["a.rar", Buffer.from("Rar!\x1a\x07\x01\x00junkjunk", "latin1")]] as const) {
      const r = await run(body, name);
      noErrors(r);
      expect(val(r, 4, "parseStatus").reason).toMatch(/no parser is bundled/);
      expect(state(r, 2).state).toBe("unavailable");
      expect(state(r, 2).note).toMatch(/signature/);
    }
  });
  it("corrupt tar is extraction_failed, never empty", async () => {
    const t = X.tar([{ name: "a.txt", body: "hello" }]);
    t[0] = 0x41; // breaks the header checksum
    t[1] = 0x41;
    const r = await run(t, "bad.tar");
    expect(vals(r, 2, "entries")[0].status).toBe("extraction_failed");
    expect(state(r, 2).state).toBe("extraction_failed");
  });
});

describe("web archives", () => {
  it("WARC: record inventory and captured responses as bounded references", async () => {
    for (const body of [X.warc(), X.gzip(X.warc())]) {
      const r = await run(body, "crawl.warc.gz");
      noErrors(r);
      expect(r.format?.id).toBe("warc");
      expect(val(r, 2, "recordCount")).toBe(4);
      expect(val(r, 2, "recordTypes")).toEqual({ warcinfo: 1, request: 1, response: 2 });
      expect(val(r, 2, "capturedResponses")).toEqual([
        { uri: "https://example.ke/", date: "2024-03-01T10:00:02.000Z", status: 200, contentType: "text/html", recordType: "response", length: expect.any(Number) },
        { uri: "https://example.ke/data.csv", date: "2024-03-02T08:00:00.000Z", status: 404, contentType: "text/plain", recordType: "response", length: expect.any(Number) },
      ]);
      expect(val(r, 8, "crawlerSoftware")).toBe("fixture-crawler/1.0");
      expect(val(r, 12, "captureStart")).toBe("2024-03-01T10:00:00.000Z");
      expect(r.relationships.filter((x) => x.method.includes("response record")).map((x) => x.target)).toEqual(["https://example.ke/", "https://example.ke/data.csv"]);
    }
  });
  it("ARC v1 records", async () => {
    const r = await run(X.arc(), "old.arc");
    expect(r.format?.id).toBe("arc");
    expect(val(r, 2, "capturedResponses")[0]).toMatchObject({ uri: "http://example.org/", status: 200 });
  });
  it("corrupt WARC reports the parse error", async () => {
    const r = await run(`WARC/1.0\r\nWARC-Type: response\r\n\r\nno length`, "bad.warc");
    expect(vals(r, 2, "records")[0].status).toBe("extraction_failed");
  });
});

describe("audio", () => {
  it("MP3 with ID3 tags + technical properties", async () => {
    const r = await run(X.mp3WithId3(), "rain.mp3");
    noErrors(r);
    expect(r.format?.id).toBe("mp3");
    expect(val(r, 30, "title")).toBe("Rain on the Roof");
    expect(val(r, 30, "artist")).toEqual(["Field Recorder"]);
    expect(val(r, 30, "album")).toBe("Weather Sounds");
    expect(val(r, 30, "sampleRate")).toBe(44100);
    expect(val(r, 30, "bitrate")).toBe(128000);
    expect(val(r, 30, "channels")).toBe(2);
    expect(val(r, 30, "duration")).toBeGreaterThan(0.9);
  });
  it("WAV and AIFF", async () => {
    const w = await run(F.wav(2, 8000), "tone.wav");
    expect(val(w, 30, "duration")).toBe(2);
    expect(val(w, 30, "sampleRate")).toBe(8000);
    const a = await run(X.aiff(1, 8000), "tone.aiff");
    noErrors(a);
    expect(a.format?.id).toBe("aiff");
    expect(val(a, 30, "sampleRate")).toBe(8000);
    expect(val(a, 30, "channels")).toBe(1);
    expect(val(a, 30, "duration")).toBe(1);
  });
});

describe("video & streaming", () => {
  it("WebM EBML header + tracks (stops before clusters)", async () => {
    const r = await run(X.webm({ subtitles: true }), "clip.webm");
    noErrors(r);
    expect(r.format?.id).toBe("webm");
    expect(val(r, 4, "docType")).toBe("webm");
    expect(val(r, 31, "duration")).toBe(12.5);
    expect(val(r, 31, "width")).toBe(640);
    expect(val(r, 31, "videoCodec")).toBe("V_VP9");
    expect(val(r, 31, "frameRate")).toBe(25);
    expect(val(r, 30, "sampleRate")).toBe(48000);
    expect(val(r, 31, "subtitleTracks")).toEqual([{ codec: "S_TEXT/WEBVTT", language: "spa", name: null }]);
    expect(val(r, 1, "language")).toBe("fra, spa");
  });
  it("Matroska with an unsupported codec records it verbatim", async () => {
    const r = await run(X.webm({ docType: "matroska", videoCodec: "V_FANTASY/9000" }), "odd.mkv");
    expect(r.format?.id).toBe("mkv");
    expect(val(r, 4, "unrecognisedCodecs")).toEqual(["V_FANTASY/9000"]);
  });
  it("MP4 tracks/codec/duration via the box parser", async () => {
    const r = await run(F.mp4(320, 240, 3), "a.mp4");
    expect(val(r, 31, "duration")).toBe(3);
    expect(val(r, 31, "videoCodec")).toBe("avc1");
  });
  it("HLS master playlist: variants, codecs, subtitle renditions — nothing downloaded", async () => {
    const r = await run(X.HLS_MASTER, "master.m3u8", { "content-type": "application/vnd.apple.mpegurl" });
    noErrors(r);
    expect(r.format?.id).toBe("hls");
    expect(val(r, 31, "streamingManifest")).toMatchObject({ protocol: "HLS", playlist: "master", mediaDownloaded: false });
    expect(val(r, 31, "resolutions")).toEqual(["640x360", "1280x720"]);
    expect(val(r, 4, "codecs")).toEqual(["avc1.4d401e", "mp4a.40.2", "avc1.4d401f"]);
    expect(val(r, 31, "frameRate")).toBe(50);
    expect(val(r, 31, "subtitleTracks")).toEqual([{ type: "SUBTITLES", language: "ta", name: "தமிழ்", forced: false }]);
    expect(val(r, 31, "variants")[1].uri).toBe("https://fixture.test/files/hd/index.m3u8");
    expect(r.relationships.some((x) => x.target.includes("index.m3u8"))).toBe(false);
  });
  it("HLS media playlist: duration, VOD, encryption", async () => {
    const r = await run(X.HLS_MEDIA, "index.m3u8");
    expect(val(r, 31, "duration")).toBe(15.5);
    expect(val(r, 2, "segmentCount")).toBe(3);
    expect(val(r, 31, "liveOrVod")).toBe("vod");
    expect(val(r, 7, "encryption")).toEqual(["AES-128"]);
  });
  it("DASH MPD: representations, subtitles, DRM", async () => {
    const r = await run(X.DASH, "stream.mpd", { "content-type": "application/dash+xml" });
    noErrors(r);
    expect(r.format?.id).toBe("dash");
    expect(val(r, 31, "duration")).toBe(90.5);
    expect(val(r, 31, "resolutions")).toEqual(["1280x720", "640x360"]);
    expect(val(r, 31, "subtitleTracks")).toEqual([{ language: "ar", mimeType: "text/vtt", codecs: null, roles: ["subtitle"] }]);
    expect(val(r, 7, "encryption")).toEqual(["urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"]);
    expect(val(r, 30, "sampleRate")).toBe(48000);
    expect(val(r, 1, "title")).toBe("Lecture");
  });
});

describe("subtitles", () => {
  it("WebVTT cues + declared language; malformed blocks counted", async () => {
    const r = await run(X.VTT, "captions.vtt");
    noErrors(r);
    expect(r.format?.id).toBe("vtt");
    expect(val(r, 2, "cues")).toEqual([{ start: 1, end: 4, text: "Habari za asubuhi" }, { start: 5.5, end: 7.25, text: "Mvua inanyesha" }]);
    expect(val(r, 1, "language")).toBe("sw");
    expect(val(r, 20, "malformedCues")).toBe(1);
    expect(val(r, 38, "captionTrack")).toMatchObject({ format: "VTT", kind: "captions", cueCount: 2 });
  });
  it("SRT cues (no language declared → said so)", async () => {
    const r = await run(X.SRT, "movie.srt");
    expect(r.format?.id).toBe("srt");
    expect(val(r, 2, "cues")[1]).toEqual({ start: 3, end: 5, text: "Second line\ncontinues" });
    expect(val(r, 1, "languageDeclared")).toBe(false);
  });
  it("TTML cues with xml:lang", async () => {
    const r = await run(X.TTML, "subs.ttml");
    noErrors(r);
    expect(r.format?.id).toBe("ttml");
    expect(val(r, 1, "language")).toBe("ja");
    expect(val(r, 2, "cues")).toEqual([{ start: 1, end: 3, text: "こんにちは" }, { start: 4, end: 6.5, text: "さようなら\nまた明日" }]);
  });
});

describe("scientific & geo", () => {
  it("NetCDF classic header: dimensions, variables, units, ACDD extent", async () => {
    const r = await run(X.netcdf(), "sst.nc");
    noErrors(r);
    expect(r.format?.id).toBe("netcdf");
    expect(val(r, 17, "dimensions")).toEqual([{ name: "lat", size: 2, unlimited: false }, { name: "lon", size: 3, unlimited: false }]);
    expect(val(r, 17, "variables")[0]).toMatchObject({ name: "sst", dimensions: ["lat", "lon"], units: "degC", standardName: "sea_surface_temperature" });
    expect(val(r, 16, "units")).toEqual([{ variable: "sst", units: "degC" }]);
    expect(val(r, 1, "title")).toBe("Sea surface temperature sample");
    expect(val(r, 8, "institution")).toBe("Example Ocean Lab");
    expect(val(r, 13, "boundingBox")).toEqual({ south: -10, north: 10, west: 30, east: 50 });
    expect(val(r, 36, "conventions")).toBe("CF-1.8, ACDD-1.3");
  });
  it("truncated NetCDF header → extraction_failed", async () => {
    const r = await run(X.netcdf().subarray(0, 40), "sst.nc", {}, true);
    expect(vals(r, 17, "netcdfHeader")[0].status).toBe("extraction_failed");
  });
  it("FITS header cards across HDUs", async () => {
    const primary = X.fits([["SIMPLE", true], ["BITPIX", 16], ["NAXIS", 2], ["NAXIS1", 4], ["NAXIS2", 2], ["EXTEND", true], ["OBJECT", "NGC 1300"], ["TELESCOP", "SALT"], ["INSTRUME", "RSS"], ["DATE-OBS", "2023-11-02T21:14:00"], ["RA", 49.92], ["DEC", -19.41], ["EXPTIME", 300], ["BUNIT", "ADU"]], Buffer.alloc(16));
    const ext = X.fits([["XTENSION", "BINTABLE"], ["BITPIX", 8], ["NAXIS", 2], ["NAXIS1", 8], ["NAXIS2", 1], ["PCOUNT", 0], ["GCOUNT", 1], ["EXTNAME", "EVENTS"]], Buffer.alloc(8));
    const r = await run(Buffer.concat([primary, ext]), "galaxy.fits");
    noErrors(r);
    expect(r.format?.id).toBe("fits");
    expect(val(r, 2, "hduCount")).toBe(2);
    expect(val(r, 36, "hdus")[1]).toMatchObject({ xtension: "BINTABLE", extname: "EVENTS" });
    expect(val(r, 35, "telescope")).toBe("SALT");
    expect(val(r, 36, "celestialCoordinates")).toMatchObject({ ra: 49.92, dec: -19.41 });
    expect(val(r, 12, "observationDate")).toBe("2023-11-02T21:14:00.000Z");
  });
  it("Parquet footer: schema, row groups, statistics", async () => {
    const { parquetWriteBuffer } = await import("hyparquet-writer");
    const buf = Buffer.from(parquetWriteBuffer({ columnData: [{ name: "station", data: ["A", "B", "C"], type: "STRING" }, { name: "mm", data: [1.5, 2.5, 0], type: "DOUBLE" }] }));
    const r = await run(buf, "rain.parquet");
    noErrors(r);
    expect(r.format?.id).toBe("parquet");
    expect(val(r, 17, "columns").map((c: any) => c.name)).toEqual(["station", "mm"]);
    expect(val(r, 2, "rowCount")).toBe(3);
    expect(val(r, 2, "rowGroupCount")).toBe(1);
    expect(val(r, 8, "createdBy")).toMatch(/hyparquet/);
    const truncated = await run(buf.subarray(0, buf.length - 20), "rain.parquet", {}, true);
    expect(vals(truncated, 17, "parquetFooter")[0].status).toBe("extraction_failed");
  });
  it("SQLite: header + schema rows read without executing SQL or triggers", async () => {
    const Database = (await import("better-sqlite3")).default;
    const path = join(mkdtempSync(join(tmpdir(), "fmt-")), "x.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL); CREATE INDEX ix_name ON stations(name); CREATE VIEW v AS SELECT name FROM stations; CREATE TABLE log (msg TEXT); CREATE TRIGGER t AFTER INSERT ON stations BEGIN INSERT INTO log VALUES ('x'); END; PRAGMA user_version = 7;");
    db.close();
    const r = await run(readFileSync(path), "stations.sqlite");
    noErrors(r);
    expect(r.format?.id).toBe("sqlite");
    expect(val(r, 4, "sqliteHeader")).toMatchObject({ pageSize: 4096, textEncoding: "UTF-8" });
    expect(val(r, 11, "userVersion")).toBe(7);
    expect(val(r, 17, "tables")).toEqual([{ name: "stations", columns: ["id INTEGER PRIMARY KEY", "name TEXT NOT NULL", "lat REAL"] }, { name: "log", columns: ["msg TEXT"] }]);
    expect(val(r, 17, "views")).toEqual(["v"]);
    expect(val(r, 17, "triggers")).toEqual([{ name: "t", table: "stations" }]);
  });
  it("HDF5: signature only → unavailable", async () => {
    const r = await run(Buffer.concat([Buffer.from("\x89HDF\r\n\x1a\n", "latin1"), Buffer.alloc(100)]), "model.h5");
    noErrors(r);
    expect(val(r, 4, "parseStatus").reason).toMatch(/no safe pure-JS parser/);
    expect(state(r, 17).state).toBe("not_applicable");
  });
  it("GeoJSON: feature count, geometry types, computed bbox, property keys", async () => {
    const r = await run(X.GEOJSON, "wells.geojson");
    noErrors(r);
    expect(r.format?.id).toBe("geojson");
    expect(val(r, 2, "featureCount")).toBe(3);
    expect(val(r, 13, "geometryTypes")).toEqual({ Point: 1, LineString: 1 });
    expect(val(r, 13, "featuresWithoutGeometry")).toBe(1);
    expect(val(r, 13, "boundingBox")).toEqual({ west: 36.8, south: -4.05, east: 40.1, north: -1.28 });
    expect(val(r, 17, "featureProperties").map((p: any) => p.path)).toEqual(["name", "depth", "status"]);
  });
  it("GPX: tracks, points, time range, rounded extent, privacy flag", async () => {
    const r = await run(X.GPX, "ride.gpx");
    noErrors(r);
    expect(r.format?.id).toBe("gpx");
    expect(val(r, 2, "trackCount")).toBe(1);
    expect(val(r, 2, "pointCount")).toBe(4);
    expect(val(r, 12, "coverageStart")).toBe("2024-06-01T05:01:00.000Z");
    expect(val(r, 12, "coverageEnd")).toBe("2024-06-01T06:02:00.000Z");
    expect(val(r, 13, "boundingBox")).toEqual({ west: 18.4, south: -33.94, east: 18.45, north: -33.9 });
    expect(val(r, 39, "containsLocationTrack")).toBe(true);
    expect(val(r, 8, "creatorTool")).toBe("Garmin Edge 530");
  });
  it("KML and KMZ", async () => {
    const k = await run(X.KML, "sites.kml");
    noErrors(k);
    expect(k.format?.id).toBe("kml");
    expect(val(k, 2, "placemarkCount")).toBe(2);
    expect(val(k, 13, "boundingBox")).toEqual({ west: 38.7, south: 9, east: 39.5, north: 13.5 });
    expect(val(k, 1, "title")).toBe("Monasteries");
    const z = await run(X.zipX([{ name: "doc.kml", body: X.KML }]), "sites.kmz");
    noErrors(z);
    expect(z.format?.id).toBe("kmz");
    expect(val(z, 2, "placemarkCount")).toBe(2);
  });
});

describe("documents, data and code", () => {
  it("EPUB OPF metadata", async () => {
    const r = await run(X.epub(), "book.epub");
    noErrors(r);
    expect(r.format?.id).toBe("epub");
    expect(val(r, 32, "title")).toBe("Rivers of the Sahel");
    expect(val(r, 32, "author")).toBe("Aminata Diallo");
    expect(val(r, 1, "language")).toBe("fr");
    expect(val(r, 14, "isbn")).toEqual(["9780306406157"]);
    expect(val(r, 8, "publisher")).toBe("Éditions Exemple");
    expect(val(r, 12, "published")).toBe("2019-05-02T00:00:00.000Z");
    expect(val(r, 2, "spineCount")).toBe(2);
    expect(val(r, 38, "navigationDocument")).toBe(true);
  });
  it("JSON Lines: records, invalid lines, key union", async () => {
    const r = await run(X.JSONL, "corpus.jsonl");
    noErrors(r);
    expect(r.format?.id).toBe("jsonl");
    expect(val(r, 2, "recordCount")).toBe(3);
    expect(val(r, 20, "invalidLines")).toEqual({ count: 1, firstLine: 3 });
    expect(val(r, 17, "properties").map((p: any) => p.path)).toEqual(["id", "lang", "text", "extra"]);
    expect(val(r, 18, "alwaysPresentKeys")).toEqual(["id", "lang", "text"]);
  });
  it("OpenAPI in YAML: title, version, servers, path count", async () => {
    const r = await run(X.OPENAPI_YAML, "api.yaml");
    noErrors(r);
    expect(r.format?.id).toBe("openapi");
    expect(val(r, 1, "title")).toBe("Weather Stations API");
    expect(val(r, 11, "version")).toBe("2.1.0");
    expect(val(r, 4, "servers")).toEqual(["https://api.example.go.ke/v2"]);
    expect(val(r, 17, "apiPaths")).toBe(2);
  });
  it("YAML and TOML generic + invalid YAML", async () => {
    const y = await run("a: 1\nb:\n  c: [1, 2]\n---\nsecond: true\n", "conf.yml");
    expect(y.format?.id).toBe("yaml");
    expect(val(y, 2, "documentCount")).toBe(2);
    expect(val(y, 17, "nesting")).toBe(3);
    const t = await run('title = "x"\n[server]\nport = 8080\n', "conf.toml");
    expect(t.format?.id).toBe("toml");
    expect(val(t, 2, "topLevelKeys")).toEqual(["title", "server"]);
    const bad = await run("a: [1, 2\nb: }", "broken.yaml");
    expect(vals(bad, 2, "parseError")[0].status).toBe("extraction_failed");
  });
  it("robots.txt: groups, sitemaps, AI-crawler rules", async () => {
    const r = await run(X.ROBOTS, "robots.txt");
    noErrors(r);
    expect(r.format?.id).toBe("robots_txt");
    expect(val(r, 2, "userAgentGroupCount")).toBe(2);
    expect(val(r, 25, "sitemaps")).toEqual(["https://example.jp/sitemap.xml"]);
    expect(val(r, 7, "aiCrawlerRestrictions")).toEqual(["GPTBot", "CCBot"]);
    expect(val(r, 25, "nonStandardDirectives")).toEqual({ host: 1 });
  });
  it("package manifests parsed as data (scripts never run, emails masked)", async () => {
    const p = await run(X.PACKAGE_JSON, "package.json");
    noErrors(p);
    expect(p.format?.id).toBe("package_json");
    expect(val(p, 1, "title")).toBe("@acme/rain");
    expect(val(p, 6, "license")).toBe("MIT");
    expect(val(p, 8, "authors")).toEqual(["Ana Souza <a***@acme.test>"]);
    expect(val(p, 9, "dependencies")).toEqual([{ name: "zod", spec: "^3.0.0", scope: "runtime" }, { name: "vitest", spec: "^2.0.0", scope: "dev" }]);
    expect(val(p, 4, "scriptNames")).toEqual(["postinstall"]);
    const req = await run(X.REQUIREMENTS, "requirements.txt");
    expect(req.format?.id).toBe("requirements_txt");
    expect(val(req, 9, "dependencies").map((d: any) => d.name)).toEqual(["numpy", "requests", "git+https://github.com/org/pkg.git#egg=pkg"]);
    expect(val(req, 15, "includes")).toEqual(["base.txt"]);
    const py = await run(X.PYPROJECT, "pyproject.toml");
    expect(py.format?.id).toBe("pyproject");
    expect(val(py, 11, "version")).toBe("0.3.0");
    expect(val(py, 6, "license")).toBe("BSD-3-Clause");
    expect(val(py, 9, "dependencies").map((d: any) => d.name)).toEqual(["xarray", "netCDF4"]);
    const cargo = await run(X.CARGO, "Cargo.toml");
    expect(cargo.format?.id).toBe("cargo_toml");
    expect(val(cargo, 9, "dependencies").map((d: any) => `${d.name}:${d.scope}`)).toEqual(["serde:runtime", "rayon:runtime", "criterion:dev"]);
    expect(val(cargo, 8, "authors")).toEqual(["Li Wei <l***@example.cn>"]);
  });
  it("source code: language by shebang/extension, line counts, SPDX header", async () => {
    const r = await run(X.PYTHON, "tool");
    noErrors(r);
    expect(r.format?.id).toBe("source_code");
    expect(val(r, 4, "programmingLanguage")).toBe("Python");
    expect(val(r, 2, "commentLines")).toBe(4);
    expect(val(r, 6, "license")).toBe("GPL-3.0-or-later");
    expect(val(r, 6, "copyright")).toMatch(/Copyright 2023 Example Hydrology Group/);
    const js = await run("// MIT License\n/* Permission is hereby granted, free of charge */\nexport const x = 1;\n", "lib.ts");
    expect(val(js, 4, "programmingLanguage")).toBe("TypeScript");
    expect(val(js, 2, "codeLines")).toBe(1);
    // An HTML page at a .php URL stays a webpage.
    const php = await run("<!doctype html><html><head><title>Hi</title></head></html>", "index.php", { "content-type": "text/html" });
    expect(php.kind).toBe("webpage");
  });
});

describe("crawler: archive children become contained resources with their original relative paths", () => {
  it("nested tar.gz inside zip → child resources indexed under #entry=<path>", async () => {
    const { AutonomousCrawler } = await import("../src/corpus/crawler.js");
    const { SqliteCorpus } = await import("../src/corpus/store.js");
    const store = new SqliteCorpus(join(mkdtempSync(join(tmpdir(), "fmtc-")), "c.db"));
    const body = X.zipX([{ name: "pkg/inner.tar.gz", body: X.gzip(X.tar([{ name: "sub/captions.vtt", body: X.VTT }])) }, { name: "../escape.txt", body: "no" }]);
    const url = "https://files.example.ng/bundle.zip";
    const crawler = new AutonomousCrawler({
      store,
      sources: [{ id: "t", description: "t", intervalMs: 3600_000, run: async () => [{ url, priority: 60, depth: 0, via: "bootstrap:t", purpose: "artifact" as const }] }],
      fetch: async (u) => ({ ...F.response(body, { "content-type": "application/zip" }, u) }),
      robots: async () => ({ allowed: true, crawlDelay: null, sitemaps: [] }),
      enrich: false,
      hostDelayMs: 0,
      urlPolicy: () => ({ ok: true }),
    });
    await crawler.drain(5);
    const child = await store.byUrl(`${url}#entry=${encodeURIComponent("pkg/inner.tar.gz!/sub/captions.vtt")}`);
    expect(child?.state).toBe("indexed");
    expect(child?.kind).toBe("text");
    expect(await store.byUrl(`${url}#entry=${encodeURIComponent("../escape.txt")}`)).toBeUndefined();
    await store.close();
  });
});
