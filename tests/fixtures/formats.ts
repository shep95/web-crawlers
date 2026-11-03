import { crc32, deflateRawSync, gzipSync } from "node:zlib";

/** Tiny, valid files for the new format extractors — all generated in-process (no network). */

const pad = (n: number, m: number) => (m - (n % m)) % m;

// ---------------------------------------------------------------- tar
export function tar(files: Array<{ name: string; body?: string | Buffer; type?: string; link?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = f.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body);
    const h = Buffer.alloc(512);
    h.write(f.name.slice(0, 100), 0, "utf8");
    h.write("0000644\0", 100, "latin1");
    h.write("0000000\0", 108, "latin1");
    h.write("0000000\0", 116, "latin1");
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
    h.write("14000000000\0", 136, "latin1");
    h.write("        ", 148, "latin1");
    h.write(f.type ?? "0", 156, "latin1");
    if (f.link) h.write(f.link, 157, "utf8");
    h.write("ustar\0", 257, "latin1");
    h.write("00", 263, "latin1");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    parts.push(h, body, Buffer.alloc(pad(body.length, 512)));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- zip with flags / stored entries
export function zipX(files: Array<{ name: string; body: string | Buffer; encrypted?: boolean; store?: boolean; declared?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body);
    const comp = f.store ? data : deflateRawSync(data);
    const name = Buffer.from(f.name, "utf8");
    const flags = f.encrypted ? 1 : 0;
    const method = f.store ? 0 : 8;
    const crc = crc32(data) >>> 0;
    const size = f.declared ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const gzip = (b: string | Buffer) => gzipSync(b);

// ---------------------------------------------------------------- audio
export function mp3WithId3(): Buffer {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, "utf8")]);
    const h = Buffer.alloc(10);
    h.write(id, 0, "latin1");
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const frames = Buffer.concat([frame("TIT2", "Rain on the Roof"), frame("TPE1", "Field Recorder"), frame("TALB", "Weather Sounds"), frame("TYER", "2021"), frame("TCON", "Ambient")]);
  const sz = frames.length;
  const syncsafe = Buffer.from([(sz >> 21) & 0x7f, (sz >> 14) & 0x7f, (sz >> 7) & 0x7f, sz & 0x7f]);
  const id3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00", "latin1"), syncsafe, frames]);
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames.
  const mpeg: Buffer[] = [];
  for (let i = 0; i < 40; i++) {
    const f = Buffer.alloc(417);
    f.writeUInt32BE(0xfffb9064, 0);
    mpeg.push(f);
  }
  return Buffer.concat([id3, ...mpeg]);
}

function extended80(n: number): Buffer {
  const b = Buffer.alloc(10);
  const e = Math.floor(Math.log2(n));
  b.writeUInt16BE(16383 + e, 0);
  b.writeBigUInt64BE(BigInt(n) << BigInt(63 - e), 2);
  return b;
}

export function aiff(seconds = 1, rate = 8000): Buffer {
  const frames = seconds * rate;
  const comm = Buffer.concat([Buffer.from("COMM", "latin1"), u32be(18), u16be(1), u32be(frames), u16be(16), extended80(rate)]);
  const data = Buffer.alloc(frames * 2);
  const ssnd = Buffer.concat([Buffer.from("SSND", "latin1"), u32be(8 + data.length), u32be(0), u32be(0), data]);
  const body = Buffer.concat([Buffer.from("AIFF", "latin1"), comm, ssnd]);
  return Buffer.concat([Buffer.from("FORM", "latin1"), u32be(body.length), body]);
}

function u32be(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function u16be(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

// ---------------------------------------------------------------- EBML (WebM/Matroska)
function ebmlId(id: number): Buffer {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(bytes);
}
function el(id: number, payload: Buffer | string | number, numBytes = 0): Buffer {
  let body: Buffer;
  if (typeof payload === "string") body = Buffer.from(payload, "utf8");
  else if (typeof payload === "number") {
    body = Buffer.alloc(numBytes || 4);
    if (numBytes === 8) body.writeDoubleBE(payload);
    else body.writeUIntBE(payload, 0, numBytes || 4);
  } else body = payload;
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  size.writeUIntBE(body.length, 2, 6);
  return Buffer.concat([ebmlId(id), size, body]);
}
const float8 = (id: number, v: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
};

export function webm(opts: { docType?: string; videoCodec?: string; width?: number; height?: number; seconds?: number; subtitles?: boolean } = {}): Buffer {
  const header = el(0x1a45dfa3, Buffer.concat([el(0x4286, 1, 1), el(0x4282, opts.docType ?? "webm"), el(0x4287, 4, 1)]));
  const info = el(0x1549a966, Buffer.concat([el(0x2ad7b1, 1_000_000), float8(0x4489, (opts.seconds ?? 12.5) * 1000), el(0x7ba9, "Glacier timelapse"), el(0x4d80, "fixture-mux"), el(0x5741, "fixture-writer")]));
  const video = el(0xae, Buffer.concat([el(0xd7, 1, 1), el(0x83, 1, 1), el(0x86, opts.videoCodec ?? "V_VP9"), el(0x23e383, 40_000_000), el(0xe0, Buffer.concat([el(0xb0, opts.width ?? 640, 2), el(0xba, opts.height ?? 360, 2)]))]));
  const audio = el(0xae, Buffer.concat([el(0xd7, 2, 1), el(0x83, 2, 1), el(0x86, "A_OPUS"), el(0x22b59c, "fra"), el(0xe1, Buffer.concat([float8(0xb5, 48000), el(0x9f, 2, 1)]))]));
  const subs = opts.subtitles ? [el(0xae, Buffer.concat([el(0xd7, 3, 1), el(0x83, 0x11, 1), el(0x86, "S_TEXT/WEBVTT"), el(0x22b59c, "spa")]))] : [];
  const tracks = el(0x1654ae6b, Buffer.concat([video, audio, ...subs]));
  const cluster = el(0x1f43b675, Buffer.alloc(64));
  return Buffer.concat([header, el(0x18538067, Buffer.concat([info, tracks, cluster]))]);
}

// ---------------------------------------------------------------- FITS
export function fits(cards: Array<[string, string | number | boolean]>, data = Buffer.alloc(0)): Buffer {
  const card = (k: string, v: string | number | boolean) => {
    const val = typeof v === "string" ? `'${v.padEnd(8)}'` : typeof v === "boolean" ? (v ? "T" : "F") : String(v);
    return `${k.padEnd(8)}= ${val.padStart(typeof v === "string" ? 0 : 20)}`.padEnd(80);
  };
  let h = cards.map(([k, v]) => card(k, v)).join("") + "END".padEnd(80);
  h = h.padEnd(Math.ceil(h.length / 2880) * 2880);
  return Buffer.concat([Buffer.from(h, "latin1"), data, Buffer.alloc(pad(data.length, 2880))]);
}

// ---------------------------------------------------------------- NetCDF classic (CDF-1), built by hand
export function netcdf(): Buffer {
  const parts: Buffer[] = [];
  const name = (s: string) => {
    const b = Buffer.from(s);
    return Buffer.concat([u32be(b.length), b, Buffer.alloc(pad(b.length, 4))]);
  };
  const charAttr = (n: string, v: string) => {
    const b = Buffer.from(v);
    return Buffer.concat([name(n), u32be(2), u32be(b.length), b, Buffer.alloc(pad(b.length, 4))]);
  };
  const doubleAttr = (n: string, v: number) => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return Buffer.concat([name(n), u32be(6), u32be(1), b]);
  };
  parts.push(Buffer.from("CDF\x01", "latin1"), u32be(0));
  // dimensions: lat=2, lon=3
  parts.push(u32be(0x0a), u32be(2), name("lat"), u32be(2), name("lon"), u32be(3));
  const gatts = [charAttr("title", "Sea surface temperature sample"), charAttr("institution", "Example Ocean Lab"), charAttr("Conventions", "CF-1.8, ACDD-1.3"), charAttr("history", "created by fixture"), charAttr("license", "CC-BY-4.0"), doubleAttr("geospatial_lat_min", -10), doubleAttr("geospatial_lat_max", 10), doubleAttr("geospatial_lon_min", 30), doubleAttr("geospatial_lon_max", 50), charAttr("time_coverage_start", "2024-01-01T00:00:00Z")];
  parts.push(u32be(0x0c), u32be(gatts.length), ...gatts);
  // one variable sst(lat, lon) float, units degC
  const header = Buffer.concat(parts);
  const vattrs = Buffer.concat([u32be(0x0c), u32be(3), charAttr("units", "degC"), charAttr("long_name", "sea surface temperature"), charAttr("standard_name", "sea_surface_temperature")]);
  const varHeadNoBegin = Buffer.concat([u32be(0x0b), u32be(1), name("sst"), u32be(2), u32be(0), u32be(1), vattrs, u32be(5), u32be(24)]);
  const begin = header.length + varHeadNoBegin.length + 4;
  const data = Buffer.alloc(24);
  for (let i = 0; i < 6; i++) data.writeFloatBE(20 + i, i * 4);
  return Buffer.concat([header, varHeadNoBegin, u32be(begin), data]);
}

// ---------------------------------------------------------------- EPUB
export function epub(): Buffer {
  return zipX([
    { name: "mimetype", body: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", body: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: "OEBPS/content.opf", body: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Rivers of the Sahel</dc:title><dc:creator>Aminata Diallo</dc:creator><dc:language>fr</dc:language><dc:identifier id="uid">urn:isbn:9780306406157</dc:identifier><dc:publisher>Éditions Exemple</dc:publisher><dc:date>2019-05-02</dc:date><dc:rights>CC BY-SA 4.0</dc:rights><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>` },
    { name: "OEBPS/c1.xhtml", body: "<html><body><p>Chapitre 1</p></body></html>" },
    { name: "OEBPS/c2.xhtml", body: "<html><body><p>Chapitre 2</p></body></html>" },
    { name: "OEBPS/nav.xhtml", body: "<html><body><nav/></body></html>" },
  ]);
}

// ---------------------------------------------------------------- WARC / ARC
export function warc(): string {
  const rec = (headers: Record<string, string>, body: string) => {
    const b = Buffer.from(body);
    return `WARC/1.1\r\n${Object.entries({ ...headers, "Content-Length": String(b.length) }).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}\r\n\r\n`;
  };
  return [
    rec({ "WARC-Type": "warcinfo", "WARC-Date": "2024-03-01T10:00:00Z", "WARC-Record-ID": "<urn:uuid:1>", "Content-Type": "application/warc-fields" }, "software: fixture-crawler/1.0\r\nformat: WARC File Format 1.1\r\nisPartOf: test-collection\r\n"),
    rec({ "WARC-Type": "request", "WARC-Date": "2024-03-01T10:00:01Z", "WARC-Target-URI": "https://example.ke/", "Content-Type": "application/http; msgtype=request" }, "GET / HTTP/1.1\r\nHost: example.ke\r\n\r\n"),
    rec({ "WARC-Type": "response", "WARC-Date": "2024-03-01T10:00:02Z", "WARC-Target-URI": "https://example.ke/", "WARC-Payload-Digest": "sha1:AAAA", "Content-Type": "application/http; msgtype=response" }, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html>habari</html>"),
    rec({ "WARC-Type": "response", "WARC-Date": "2024-03-02T08:00:00Z", "WARC-Target-URI": "https://example.ke/data.csv", "Content-Type": "application/http; msgtype=response" }, "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nmissing"),
  ].join("");
}

export function arc(): string {
  const body1 = "1 0 Fixture\nURL IP-address Archive-date Content-type Archive-length\n";
  const body2 = "HTTP/1.0 200 OK\nContent-Type: text/html\n\n<html>hi</html>";
  return `filedesc://fixture.arc 0.0.0.0 20010101000000 text/plain ${Buffer.byteLength(body1)}\n${body1}\nhttp://example.org/ 93.184.216.34 20010203040506 text/html ${Buffer.byteLength(body2)}\n${body2}\n`;
}

// ---------------------------------------------------------------- text formats
export const VTT = `WEBVTT
Kind: captions
Language: sw

NOTE produced by a fixture

1
00:00:01.000 --> 00:00:04.000
Habari za asubuhi

00:00:05.500 --> 00:00:07.250 align:start
<v Narrator>Mvua inanyesha</v>

broken
not a timing line
`;

export const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello there

2
00:00:03,000 --> 00:00:05,000
Second line
continues
`;

export const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="ja"><head><metadata><ttm:title>字幕サンプル</ttm:title></metadata></head><body><div><p begin="00:00:01.000" end="00:00:03.000">こんにちは</p><p begin="4s" end="6.5s">さようなら<br/>また明日</p></div></body></tt>`;

export const HLS_MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="hi",NAME="हिन्दी",DEFAULT=YES,URI="audio/hi.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="ta",NAME="தமிழ்",DEFAULT=NO,URI="subs/ta.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=25.000,AUDIO="aud",SUBTITLES="subs"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=50.000,AUDIO="aud",SUBTITLES="subs"
hd/index.m3u8
`;

export const HLS_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1"
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXTINF:3.5,
seg2.ts
#EXT-X-ENDLIST
`;

export const DASH = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1M30.5S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
<ProgramInformation><Title>Lecture</Title></ProgramInformation>
<Period>
<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f" frameRate="30">
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
<Representation id="v1" bandwidth="1000000" width="1280" height="720"/>
<Representation id="v2" bandwidth="400000" width="640" height="360"/>
</AdaptationSet>
<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="pt" codecs="mp4a.40.2"><Representation id="a1" bandwidth="128000" audioSamplingRate="48000"/></AdaptationSet>
<AdaptationSet mimeType="text/vtt" lang="ar"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><Representation id="t1" bandwidth="1000"/></AdaptationSet>
</Period></MPD>`;

export const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  name: "Wells",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [36.8, -1.28] }, properties: { name: "Nairobi", depth: 40 } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[39.6, -4.05], [40.1, -3.2]] }, properties: { name: "Coast", status: null } },
    { type: "Feature", geometry: null, properties: { name: "unknown" } },
  ],
});

export const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="Garmin Edge 530" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>Morning ride</name><time>2024-06-01T05:00:00Z</time></metadata>
<trk><name>Ride</name><trkseg>
<trkpt lat="-33.9249" lon="18.4241"><ele>12</ele><time>2024-06-01T05:01:00Z</time></trkpt>
<trkpt lat="-33.9300" lon="18.4300"><ele>40</ele><time>2024-06-01T05:31:00Z</time></trkpt>
<trkpt lat="-33.9400" lon="18.4500"><ele>25</ele><time>2024-06-01T06:02:00Z</time></trkpt>
</trkseg></trk>
<wpt lat="-33.9" lon="18.4"><name>Start</name></wpt>
</gpx>`;

export const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Monasteries</name><description>Heritage sites</description>
<Placemark><name>Lalibela</name><TimeStamp><when>2001-01-01</when></TimeStamp><Point><coordinates>39.0473,12.0317,0</coordinates></Point></Placemark>
<Placemark><name>Route</name><LineString><coordinates>38.7,9.0 39.5,13.5</coordinates></LineString></Placemark>
</Document></kml>`;

export const JSONL = `{"id":1,"lang":"yo","text":"Ẹ kú àárọ̀"}
{"id":2,"lang":"zu","text":"Sawubona","extra":null}
not json at all
{"id":3,"lang":"am","text":"ሰላም"}
`;

export const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Weather Stations API
  version: 2.1.0
  license:
    name: Apache-2.0
servers:
  - url: https://api.example.go.ke/v2
paths:
  /stations: {get: {responses: {"200": {description: ok}}}}
  /stations/{id}: {get: {responses: {"200": {description: ok}}}}
components:
  securitySchemes:
    key: {type: apiKey, in: header, name: X-Key}
`;

export const ROBOTS = `# robots
User-agent: *
Disallow: /private/
Allow: /public/

User-agent: GPTBot
User-agent: CCBot
Disallow: /

Sitemap: https://example.jp/sitemap.xml
Host: example.jp
`;

export const PACKAGE_JSON = JSON.stringify({ name: "@acme/rain", version: "1.4.2", description: "Rain gauge parser", license: "MIT", author: "Ana Souza <ana@acme.test>", repository: { type: "git", url: "git+https://github.com/acme/rain.git" }, dependencies: { zod: "^3.0.0" }, devDependencies: { vitest: "^2.0.0" }, scripts: { postinstall: "rm -rf /" } });

export const REQUIREMENTS = `# pinned
numpy==1.26.4
requests[socks]>=2.31 ; python_version >= "3.8"
-r base.txt
--index-url https://pypi.example/simple
git+https://github.com/org/pkg.git#egg=pkg
`;

export const PYPROJECT = `[project]
name = "sahel-hydro"
version = "0.3.0"
description = "Hydrology toolkit"
license = {text = "BSD-3-Clause"}
authors = [{name = "Moussa Traoré", email = "moussa@uni.test"}]
dependencies = ["xarray>=2024.1", "netCDF4"]
requires-python = ">=3.10"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`;

export const CARGO = `[package]
name = "tiler"
version = "0.9.1"
edition = "2021"
license = "MIT OR Apache-2.0"
authors = ["Li Wei <li@example.cn>"]
repository = "https://github.com/example/tiler"

[dependencies]
serde = { version = "1", features = ["derive"] }
rayon = "1.8"

[dev-dependencies]
criterion = "0.5"
`;

export const PYTHON = `#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2023 Example Hydrology Group

"""Compute river discharge."""

def discharge(area, velocity):
    # simple product
    return area * velocity
`;
