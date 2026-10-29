import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import type { SafeResponse } from "../../src/net/safe-fetch.js";

/** Wrap a body in the shape safeFetch returns, for offline pipeline tests. */
export function response(body: Buffer | string, headers: Record<string, string> = {}, url = "https://fixture.test/resource", status = 200): SafeResponse {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    requestedUrl: url,
    finalUrl: url,
    status,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    body: buf,
    truncated: false,
    encodedBytes: buf.length,
    redirects: [],
    remoteAddress: "93.184.216.34",
    timings: { startedAt: "2026-10-29T12:00:00.000Z", ttfbMs: 12, totalMs: 20 },
    egress: "direct",
  };
}

export const HTML_RICH = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Global Temperature Dataset 2025 | Example Climate Institute</title>
<meta name="description" content="Monthly land and ocean temperature anomalies, 1880–2025.">
<meta name="author" content="Jane Researcher">
<meta name="keywords" content="climate, temperature, anomalies">
<meta name="robots" content="index, follow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Hugo 0.120">
<meta name="geo.position" content="40.7128;-74.0060">
<meta name="geo.placename" content="New York">
<meta name="DC.rights" content="Public domain in the United States">
<meta name="citation_title" content="Global Temperature Dataset 2025">
<meta name="citation_author" content="Researcher, Jane">
<meta name="citation_journal_title" content="Journal of Climate Data">
<meta name="citation_doi" content="10.1234/climate.2025.001">
<meta name="citation_publication_date" content="2025/03/14">
<meta property="og:title" content="Global Temperature Dataset 2025">
<meta property="og:site_name" content="Example Climate Institute">
<meta property="og:image" content="/img/og.png">
<meta property="article:published_time" content="2025-03-14T09:00:00Z">
<meta property="article:tag" content="climate">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://fixture.test/datasets/gtd-2025">
<link rel="alternate" hreflang="fr" href="https://fixture.test/fr/datasets/gtd-2025">
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Dataset","name":"Global Temperature Dataset 2025","description":"Monthly anomalies.","datePublished":"2025-03-10","dateModified":"2025-04-01",
  "license":"https://creativecommons.org/licenses/by/4.0/","version":"3.0","identifier":"gtd-2025-v3","isBasedOn":"https://fixture.test/datasets/gtd-2024",
  "spatialCoverage":"Global","temporalCoverage":"1880-01/2025-02","variableMeasured":["temperature anomaly (°C)","uncertainty"],
  "measurementTechnique":"Weather station network + ship-based measurements","maintainer":{"@type":"Organization","name":"Data Office"},
  "sameAs":"https://www.wikidata.org/wiki/Q000","distribution":[{"@type":"DataDownload","encodingFormat":"text/csv","contentUrl":"https://fixture.test/gtd.csv"}],
  "aggregateRating":{"ratingValue":"4.5","ratingCount":"12"},"interactionStatistic":{"@type":"InteractionCounter","interactionType":"https://schema.org/DownloadAction","userInteractionCount":"5120"},
  "isAccessibleForFree":true,"accessibilityFeature":["alternativeText","longDescription"],"expires":"2030-01-01"},
 {"@type":"Organization","name":"Example Climate Institute","legalName":"Example Climate Institute Inc.","leiCode":"5493001KJTIIGC8Y1R12","sameAs":["https://twitter.com/example"]},
 {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home"},{"@type":"ListItem","position":2,"name":"Datasets"}]}
]}
</script>
<script src="https://cdn.example-cdn.net/lib.js" integrity="sha384-abc" crossorigin="anonymous"></script>
<script type="application/ld+json">{ this is not json }</script>
</head>
<body>
<header><nav><a href="#main">Skip to content</a> <a href="/">Home</a></nav></header>
<main id="main">
<h1>Global Temperature Dataset 2025</h1>
<p>Cite as doi:10.1234/climate.2025.001. ISBN 978-0-306-40615-7. Author ORCID 0000-0002-1825-0097. arXiv:2101.00001.</p>
<h2>Methods</h2><p>Contact data-office@fixture.test or call (555) 123-4567.</p>
<table><tr><th>Year</th><th>Anomaly</th></tr><tr><td>2024</td><td>1.2</td></tr></table>
<img src="/a.png" alt="Chart of anomalies"><img src="/b.png"><img src="/c.png" alt="">
<video src="/v.mp4"><track kind="captions" src="/v.vtt" srclang="en"></video>
<form><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120">
<input name="age" type="number" min="0" max="120"><select name="unit"><option value="c">C</option><option value="f">F</option></select>
<input type="password" name="pw"></form>
<blockquote cite="https://fixture.test/source-quote">Quoted text</blockquote>
<p>We retain access logs for 90 days before they are deleted.</p>
<a href="https://other.test/page">External</a> <a href="/privacy">Privacy policy</a> <a href="/terms">Terms of use</a>
<a rel="next" href="/datasets/gtd-2025?page=2">Next</a>
</main>
<footer>© 2025 Example Climate Institute. All rights reserved.</footer>
</body></html>`;

export const JSON_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Person",
  description: "A person record",
  type: "object",
  required: ["name", "age"],
  properties: {
    name: { type: "string", description: "Full name", maxLength: 200 },
    age: { type: "integer", minimum: 0, maximum: 120, description: "Age in years" },
    status: { type: "string", enum: ["active", "inactive"] },
    zip: { type: "string", pattern: "^[0-9]{5}$" },
  },
});

export const OPENAPI = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Pets API", version: "2.4.1", description: "Pet store", license: { name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" } },
  servers: [{ url: "https://api.pets.test/v2" }],
  paths: { "/pets": { get: {} }, "/pets/{id}": { get: {} } },
  components: {
    schemas: { Pet: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 }, name: { type: "string" } } } },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
});

export const DATAPACKAGE = JSON.stringify({
  name: "rainfall",
  title: "Rainfall observations",
  version: "1.2.0",
  licenses: [{ name: "ODC-PDDL-1.0" }],
  sources: [{ title: "National Weather Service" }],
  created: "2024-05-01T00:00:00Z",
  resources: [{ name: "obs", path: "obs.csv", schema: { fields: [{ name: "station", type: "string", constraints: { required: true } }, { name: "mm", type: "number", constraints: { minimum: 0 } }], primaryKey: ["station"] } }],
});

export const HF_CONFIG = JSON.stringify({ architectures: ["BertForMaskedLM"], model_type: "bert", hidden_size: 768, num_hidden_layers: 12, vocab_size: 30522 });

export const CSV = "station,date,mm,flag\nA1,2024-01-01,3.2,ok\nA2,2024-01-02,,ok\nA3,2024-01-03,7.5,\nA4,2024-01-04,0,ok\n";

export const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Release notes</title><description>Product updates</description><language>en-us</language><copyright>© 2025 Acme</copyright><ttl>60</ttl>
<item><title>v3.0</title><link>https://fixture.test/r/3</link><pubDate>Tue, 01 Apr 2025 10:00:00 GMT</pubDate></item>
<item><title>v2.0</title><link>https://fixture.test/r/2</link><pubDate>Sat, 01 Mar 2025 10:00:00 GMT</pubDate></item>
<item><title>v1.0</title><link>https://fixture.test/r/1</link><pubDate>Sat, 01 Feb 2025 10:00:00 GMT</pubDate></item></channel></rss>`;

export const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
<url><loc>https://fixture.test/a</loc><lastmod>2025-01-01</lastmod><changefreq>daily</changefreq></url><url><loc>https://fixture.test/b</loc><lastmod>2025-02-01</lastmod></url></urlset>`;

export const DATACITE = `<?xml version="1.0"?><resource xmlns="http://datacite.org/schema/kernel-4"><identifier identifierType="DOI">10.5555/ABC</identifier><creators><creator><creatorName>Smith, A.</creatorName></creator></creators><titles><title>Coral survey</title></titles><rightsList><rights>CC0</rights></rightsList><geoLocations><geoLocation><geoLocationPlace>Great Barrier Reef</geoLocationPlace><geoLocationBox><westBoundLongitude>142</westBoundLongitude><eastBoundLongitude>154</eastBoundLongitude><southBoundLatitude>-24</southBoundLatitude><northBoundLatitude>-10</northBoundLatitude></geoLocationBox></geoLocation></geoLocations></resource>`;

export const EML = `Return-Path: <alice@sender.test>
Received: from mx1.sender.test by mx.receiver.test; Tue, 1 Apr 2025 10:00:00 +0000
Received: from client by mx1.sender.test; Tue, 1 Apr 2025 09:59:59 +0000
DKIM-Signature: v=1; a=rsa-sha256; d=sender.test; s=sel; b=abc
Authentication-Results: mx.receiver.test; dkim=pass header.d=sender.test
Message-ID: <msg-1@sender.test>
In-Reply-To: <msg-0@receiver.test>
References: <msg-0@receiver.test>
From: Alice Example <alice@sender.test>
To: bob@receiver.test, carol@receiver.test
Subject: Quarterly report
Date: Tue, 1 Apr 2025 10:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain

Hello Bob.
--b1
Content-Type: application/pdf
Content-Disposition: attachment; filename="report.pdf"

JVBERi0=
--b1--
`;

export const MODEL_CARD = `---
license: apache-2.0
language: en
tags: [text-classification, sentiment]
pipeline_tag: text-classification
library_name: transformers
base_model: bert-base-uncased
datasets: [imdb]
metrics: [accuracy]
model-index:
- name: sentiment-bert
  results:
  - task: {type: text-classification}
    dataset: {name: IMDB, type: imdb}
    metrics: [{type: accuracy, value: 0.93, name: Accuracy}]
---
# Sentiment BERT

Fine-tuned for sentiment.

## Limitations

Trained on English movie reviews only; performance degrades on other domains and may reflect dataset biases.

## Usage
`;

export const CITATION_CFF = `cff-version: 1.2.0
title: Omnispider
version: 2.0.0
doi: 10.5281/zenodo.123456
date-released: 2025-06-01
license: MIT
authors:
  - given-names: Jane
    family-names: Doe
    orcid: https://orcid.org/0000-0002-1825-0097
`;

export const SECURITY_TXT = `Contact: mailto:security@fixture.test
Expires: 2026-12-31T23:59:00Z
Policy: https://fixture.test/security-policy
`;

export const SHA256SUMS = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.bin
2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae  foo.txt
`;

// ---------------------------------------------------------------- binary builders

function tiffIfd(entries: Array<{ tag: number; type: number; count: number; value: Buffer | number }>, startOffset: number): { ifd: Buffer; data: Buffer } {
  // Little-endian IFD with out-of-line data appended after it.
  const ifdSize = 2 + entries.length * 12 + 4;
  const ifd = Buffer.alloc(ifdSize);
  const chunks: Buffer[] = [];
  let dataOffset = startOffset + ifdSize;
  ifd.writeUInt16LE(entries.length, 0);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    ifd.writeUInt16LE(e.tag, o);
    ifd.writeUInt16LE(e.type, o + 2);
    ifd.writeUInt32LE(e.count, o + 4);
    if (typeof e.value === "number") ifd.writeUInt32LE(e.value, o + 8);
    else if (e.value.length <= 4) e.value.copy(ifd, o + 8);
    else {
      ifd.writeUInt32LE(dataOffset, o + 8);
      chunks.push(e.value);
      dataOffset += e.value.length + (e.value.length % 2);
      if (e.value.length % 2) chunks.push(Buffer.alloc(1));
    }
  });
  ifd.writeUInt32LE(0, ifdSize - 4);
  return { ifd, data: Buffer.concat(chunks) };
}

const ascii = (s: string) => Buffer.from(`${s}\0`, "latin1");

/** Minimal baseline JPEG with an EXIF APP1 (Make, Model, Software, DateTimeOriginal) and SOF0 dimensions. */
export function jpegWithExif(width = 640, height = 480): Buffer {
  // TIFF header (8 bytes) then IFD0 at offset 8.
  const ifd0Entries = [
    { tag: 0x010f, type: 2, count: 10, value: ascii("TestMaker") },
    { tag: 0x0110, type: 2, count: 9, value: ascii("Model X1") },
    { tag: 0x0131, type: 2, count: 8, value: ascii("FW 1.02") },
    { tag: 0x8298, type: 2, count: 14, value: ascii("(c) Jane 2024") },
    { tag: 0x8769, type: 4, count: 1, value: 0 }, // ExifIFD pointer (patched below)
  ];
  const first = tiffIfd(ifd0Entries, 8);
  const exifStart = 8 + first.ifd.length + first.data.length;
  ifd0Entries[4].value = exifStart;
  const ifd0 = tiffIfd(ifd0Entries, 8);
  const exif = tiffIfd([{ tag: 0x9003, type: 2, count: 20, value: ascii("2024:06:30 14:22:01") }], exifStart);
  const tiff = Buffer.concat([Buffer.from("II*\0\x08\0\0\0", "latin1"), ifd0.ifd, ifd0.data, exif.ifd, exif.data]);
  const app1Payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(app1Payload.length + 2), app1Payload]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}
function u16be(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

export function png(width = 32, height = 16): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 16-bit PCM WAV, mono, `seconds` of silence. */
export function wav(seconds = 1, sampleRate = 8000): Buffer {
  const dataLen = seconds * sampleRate * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(dataLen, 40);
  return Buffer.concat([h, Buffer.alloc(dataLen)]);
}

export async function pdf(): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle("Annual Report 2024");
  doc.setAuthor("Finance Team");
  doc.setSubject("Financial results");
  doc.setKeywords(["finance", "annual"]);
  doc.setCreator("Fixture Writer");
  doc.setProducer("pdf-lib");
  doc.setCreationDate(new Date("2024-02-01T10:00:00Z"));
  doc.setModificationDate(new Date("2024-02-03T10:00:00Z"));
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Minimal zip writer (deflate) for OOXML fixtures. `lie` overrides declared uncompressed sizes. */
export function zip(files: Record<string, string | Buffer>, lie?: Record<string, number>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const size = lie?.[name] ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function docx(): Buffer {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Project Plan</dc:title><dc:creator>Sam Writer</dc:creator><cp:keywords>plan, q3</cp:keywords><cp:lastModifiedBy>Private Person</cp:lastModifiedBy><cp:revision>7</cp:revision><dcterms:created>2024-07-01T08:00:00Z</dcterms:created><dcterms:modified>2024-07-09T08:00:00Z</dcterms:modified></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0"?><Properties><Application>Microsoft Office Word</Application><Pages>4</Pages><Words>1200</Words><Company>Acme Corp</Company></Properties>`,
    "word/document.xml": `<w:document/>`,
  });
}

/** core.xml declares 100 bytes but inflates to 50 MB — must be capped, not inflated. */
export function zipBomb(): Buffer {
  return zip({ "[Content_Types].xml": "<Types>wordprocessingml</Types>", "docProps/core.xml": Buffer.alloc(50 * 1024 * 1024, 0x41) }, { "docProps/core.xml": 100 });
}

/** Minimal ISO-BMFF (MP4): ftyp + moov{mvhd, trak{tkhd, mdia{mdhd, hdlr(vide), minf{stbl{stsd(avc1 WxH)}}}}}. */
export function mp4(width = 320, height = 240, seconds = 3): Buffer {
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + body.length);
    h.write(type, 4, "latin1");
    return Buffer.concat([h, body]);
  };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const zeros = (n: number) => Buffer.alloc(n);
  const matrix = Buffer.concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const ts = 1000;
  const mvhd = box("mvhd", u32(0), u32(0), u32(0), u32(ts), u32(seconds * ts), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2));
  const tkhd = box("tkhd", u32(3), u32(0), u32(0), u32(1), u32(0), u32(seconds * ts), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width << 16), u32(height << 16));
  const mdhd = box("mdhd", u32(0), u32(0), u32(0), u32(ts), u32(seconds * ts), u16(0x55c4), u16(0));
  const hdlr = box("hdlr", u32(0), u32(0), Buffer.from("vide", "latin1"), zeros(12), Buffer.from("VideoHandler\0", "latin1"));
  const avc1 = box("avc1", zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff));
  const stsd = box("stsd", u32(0), u32(1), avc1);
  const stbl = box("stbl", stsd, box("stts", u32(0), u32(0)), box("stsc", u32(0), u32(0)), box("stsz", u32(0), u32(0), u32(0)), box("stco", u32(0), u32(0)));
  const minf = box("minf", box("vmhd", u32(1), zeros(8)), stbl);
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(512), Buffer.from("isomiso2avc1mp41", "latin1"));
  return Buffer.concat([ftyp, box("moov", mvhd, trak)]);
}
