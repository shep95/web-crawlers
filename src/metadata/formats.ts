import { gunzipSync, constants as zlibConstants } from "node:zlib";
import { sniffKind } from "./normalize.js";
import type { ResourceKind } from "./types.js";

/**
 * Machine-readable format capability registry + signature-first format detection.
 *
 * Shape (kept deliberately flat so other tools — e.g. the coverage matrix — can
 * consume it without importing the pipeline):
 *
 *   FORMATS: FormatSpec[]                     one entry per format id
 *   FORMAT_BY_ID: Map<string, FormatSpec>
 *   detectFormat(body, declaredMime, nameOrUrl): FormatDetection
 *
 * `status`:
 *   implemented     a parser reads the format's metadata structures
 *   partial         a parser reads some structures; the rest is documented in `notes`
 *   signature_only  the format is recognised by its magic bytes but no parser exists:
 *                   records say `unavailable` rather than pretending nothing is there
 *   unsupported     recognised, deliberately not parsed (e.g. executables)
 * `tested`: a vitest test exercises the parser (or the signature) with an in-test fixture.
 * `categories`: metadata categories (ids of the 41 in categories.ts) this format's
 * extractor can fill. Detection never trusts the extension or declared MIME over the
 * bytes: both are recorded as hints and compared.
 */
export type FormatStatus = "implemented" | "partial" | "signature_only" | "unsupported";

export interface FormatSpec {
  id: string;
  label: string;
  family: "web" | "document" | "data" | "image" | "audio" | "video" | "streaming" | "subtitle" | "archive" | "web_archive" | "scientific" | "geo" | "database" | "code" | "config" | "email" | "binary";
  kind: ResourceKind;
  mimes: string[];
  extensions: string[];
  /** Human-readable magic-byte / structural signature. */
  signatures: string[];
  /** Extractor id(s) that parse it (null = none). */
  parser: string | null;
  status: FormatStatus;
  categories: number[];
  tested: boolean;
  notes?: string;
}

// Category ids (mirrors categories.ts; numeric to keep this module dependency-free).
const DESC = 1, STRUCT = 2, ADMIN = 3, TECH = 4, PRES = 5, RIGHTS = 6, ACCESS = 7, PROV = 8, LINEAGE = 9, VERSION = 11, TEMPORAL = 12, SPATIAL = 13, IDS = 14, REL = 15, SEM = 16, SCHEMA = 17, CONSTR = 18, STAT = 19, DISC = 25, FS = 28, IMAGE = 29, AUDIO = 30, VIDEO = 31, DOC = 32, EMAIL = 33, DEVICE = 35, SCI = 36, AIML = 37, A11Y = 38, PRIV = 39, INTEG = 41;

const f = (spec: FormatSpec) => spec;

export const FORMATS: FormatSpec[] = [
  // ---------------------------------------------------------------- web & documents
  f({ id: "html", label: "HTML page", family: "web", kind: "webpage", mimes: ["text/html", "application/xhtml+xml"], extensions: ["html", "htm", "xhtml"], signatures: ["<!doctype html | <html"], parser: "html", status: "implemented", categories: [DESC, STRUCT, RIGHTS, PROV, TEMPORAL, SPATIAL, IDS, REL, SEM, DISC, 26, 27, A11Y, PRIV], tested: true }),
  f({ id: "xml", label: "XML document", family: "data", kind: "xml", mimes: ["application/xml", "text/xml"], extensions: ["xml", "xsd", "rdf"], signatures: ["<?xml | <root"], parser: "xml", status: "implemented", categories: [SEM, SCHEMA, DESC, TEMPORAL, STRUCT, IDS, RIGHTS, SPATIAL], tested: true }),
  f({ id: "feed", label: "RSS/Atom feed", family: "web", kind: "feed", mimes: ["application/rss+xml", "application/atom+xml"], extensions: ["rss", "atom"], signatures: ["<rss | <feed"], parser: "xml", status: "implemented", categories: [DESC, STRUCT, TEMPORAL, DISC, 22, 10], tested: true }),
  f({ id: "json", label: "JSON document", family: "data", kind: "json", mimes: ["application/json"], extensions: ["json"], signatures: ["{ | ["], parser: "json", status: "implemented", categories: [SCHEMA, CONSTR, SEM, DESC, VERSION, STRUCT], tested: true }),
  f({ id: "csv", label: "CSV/TSV table", family: "data", kind: "csv", mimes: ["text/csv", "text/tab-separated-values"], extensions: ["csv", "tsv"], signatures: ["(none — declared type or extension + delimiter structure)"], parser: "csv", status: "implemented", categories: [SCHEMA, STRUCT, STAT, 20], tested: true }),
  f({ id: "text", label: "Plain text / Markdown", family: "document", kind: "text", mimes: ["text/plain", "text/markdown"], extensions: ["txt", "md", "cff"], signatures: ["(printable-byte ratio)"], parser: "text", status: "implemented", categories: [DESC, STRUCT, IDS, AIML, SCI], tested: true }),
  f({ id: "email", label: "Email message (RFC 5322)", family: "email", kind: "email", mimes: ["message/rfc822"], extensions: ["eml"], signatures: ["header block: Received:/From:/Subject:"], parser: "email", status: "implemented", categories: [EMAIL, TEMPORAL, REL, INTEG, PRIV], tested: true }),
  f({ id: "pdf", label: "PDF", family: "document", kind: "pdf", mimes: ["application/pdf"], extensions: ["pdf"], signatures: ["%PDF-"], parser: "pdf", status: "implemented", categories: [DOC, DESC, TECH, TEMPORAL, PROV, PRES, INTEG, ACCESS, STRUCT, A11Y], tested: true }),
  f({ id: "office", label: "OOXML / ODF office document", family: "document", kind: "office", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.oasis.opendocument.text"], extensions: ["docx", "xlsx", "pptx", "odt", "ods", "odp"], signatures: ["PK\\x03\\x04 + [Content_Types].xml | mimetype application/vnd.oasis"], parser: "office", status: "implemented", categories: [DOC, DESC, TEMPORAL, PROV, 21, VERSION, STRUCT], tested: true }),
  f({ id: "epub", label: "EPUB e-book", family: "document", kind: "archive", mimes: ["application/epub+zip"], extensions: ["epub"], signatures: ["PK\\x03\\x04 + first entry 'mimetype' = application/epub+zip"], parser: "epub", status: "implemented", categories: [DOC, DESC, IDS, RIGHTS, TEMPORAL, STRUCT, PROV, ACCESS], tested: true }),
  // ---------------------------------------------------------------- data / config / code
  f({ id: "jsonl", label: "JSON Lines / NDJSON", family: "data", kind: "text", mimes: ["application/x-ndjson", "application/jsonl", "application/x-jsonlines"], extensions: ["jsonl", "ndjson"], signatures: ["one JSON value per line (structure)"], parser: "data-lines", status: "implemented", categories: [SCHEMA, STRUCT, CONSTR, 20], tested: true }),
  f({ id: "yaml", label: "YAML", family: "config", kind: "text", mimes: ["application/yaml", "application/x-yaml", "text/yaml"], extensions: ["yaml", "yml"], signatures: ["(extension / declared type; parsed with the safe core schema)"], parser: "config", status: "implemented", categories: [STRUCT, SCHEMA, DESC, VERSION], tested: true }),
  f({ id: "toml", label: "TOML", family: "config", kind: "text", mimes: ["application/toml"], extensions: ["toml"], signatures: ["(extension / declared type)"], parser: "config", status: "implemented", categories: [STRUCT, SCHEMA], tested: true }),
  f({ id: "openapi", label: "OpenAPI / Swagger spec", family: "data", kind: "json", mimes: ["application/vnd.oai.openapi", "application/vnd.oai.openapi+json"], extensions: [], signatures: ['top-level "openapi"/"swagger" key (JSON or YAML)'], parser: "json | config", status: "implemented", categories: [SCHEMA, DESC, VERSION, ACCESS, RIGHTS, STRUCT], tested: true }),
  f({ id: "robots_txt", label: "robots.txt", family: "config", kind: "text", mimes: [], extensions: [], signatures: ["file name robots.txt + User-agent:/Disallow: lines"], parser: "config", status: "implemented", categories: [DISC, ACCESS, STRUCT], tested: true }),
  f({ id: "package_json", label: "npm package.json", family: "code", kind: "json", mimes: [], extensions: [], signatures: ["file name package.json + name/version keys"], parser: "package-manifest", status: "implemented", categories: [DESC, VERSION, RIGHTS, LINEAGE, PROV, REL], tested: true }),
  f({ id: "requirements_txt", label: "pip requirements.txt", family: "code", kind: "text", mimes: [], extensions: [], signatures: ["file name requirements*.txt"], parser: "package-manifest", status: "implemented", categories: [LINEAGE, STRUCT], tested: true }),
  f({ id: "pyproject", label: "Python pyproject.toml", family: "code", kind: "text", mimes: [], extensions: [], signatures: ["file name pyproject.toml"], parser: "package-manifest", status: "implemented", categories: [DESC, VERSION, RIGHTS, LINEAGE, PROV], tested: true }),
  f({ id: "cargo_toml", label: "Rust Cargo.toml", family: "code", kind: "text", mimes: [], extensions: [], signatures: ["file name Cargo.toml"], parser: "package-manifest", status: "implemented", categories: [DESC, VERSION, RIGHTS, LINEAGE, PROV], tested: true }),
  f({ id: "source_code", label: "Source code", family: "code", kind: "text", mimes: ["text/x-python", "text/javascript", "application/javascript", "text/x-c", "text/x-java-source", "text/x-go", "text/x-rust", "application/x-sh"], extensions: ["py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "go", "rs", "rb", "php", "swift", "scala", "r", "jl", "lua", "pl", "sh", "bash", "zsh", "ps1", "sql", "m", "hs", "ex", "exs", "erl", "clj", "dart", "f90", "for", "ipynb"], signatures: ["#! shebang | extension"], parser: "source-code", status: "implemented", categories: [TECH, STRUCT, RIGHTS, DESC], tested: true, notes: "Language by extension + shebang; never executed. Server-side extensions (php/asp/jsp) count only when the bytes are not HTML." }),
  f({ id: "parquet", label: "Apache Parquet", family: "data", kind: "binary", mimes: ["application/vnd.apache.parquet", "application/x-parquet"], extensions: ["parquet"], signatures: ["PAR1 at start and end"], parser: "scientific (hyparquet)", status: "implemented", categories: [SCHEMA, STRUCT, STAT, TECH, PROV, SPATIAL], tested: true, notes: "Footer metadata only (schema, row groups, codecs, key-value metadata); needs the whole file — truncated bodies are extraction_failed." }),
  f({ id: "sqlite", label: "SQLite database", family: "database", kind: "binary", mimes: ["application/vnd.sqlite3", "application/x-sqlite3"], extensions: ["sqlite", "sqlite3", "db", "gpkg", "mbtiles"], signatures: ["'SQLite format 3\\0'"], parser: "scientific (byte parser)", status: "partial", categories: [TECH, SCHEMA, STRUCT, VERSION], tested: true, notes: "100-byte header + sqlite_schema rows read from b-tree pages by a byte parser; no SQL is executed, no triggers run, the file is never opened by an engine. Schema rows on overflow pages are truncated." }),
  // ---------------------------------------------------------------- images
  f({ id: "jpeg", label: "JPEG image", family: "image", kind: "image", mimes: ["image/jpeg"], extensions: ["jpg", "jpeg"], signatures: ["FF D8 FF"], parser: "image + ocr", status: "implemented", categories: [IMAGE, TECH, DESC, RIGHTS, TEMPORAL, SPATIAL, DEVICE, PRIV], tested: true }),
  f({ id: "png", label: "PNG image", family: "image", kind: "image", mimes: ["image/png"], extensions: ["png"], signatures: ["\\x89PNG"], parser: "image + ocr", status: "implemented", categories: [IMAGE, TECH], tested: true }),
  f({ id: "gif", label: "GIF image", family: "image", kind: "image", mimes: ["image/gif"], extensions: ["gif"], signatures: ["GIF8"], parser: "image", status: "implemented", categories: [IMAGE, TECH], tested: false }),
  f({ id: "webp", label: "WebP image", family: "image", kind: "image", mimes: ["image/webp"], extensions: ["webp"], signatures: ["RIFF....WEBP"], parser: "image", status: "implemented", categories: [IMAGE, TECH], tested: false }),
  f({ id: "tiff", label: "TIFF image", family: "image", kind: "image", mimes: ["image/tiff"], extensions: ["tif", "tiff"], signatures: ["II*\\0 | MM\\0*"], parser: "image", status: "implemented", categories: [IMAGE, TECH], tested: false }),
  f({ id: "heic", label: "HEIC/AVIF image", family: "image", kind: "image", mimes: ["image/heic", "image/avif"], extensions: ["heic", "heif", "avif"], signatures: ["ftypheic | ftypmif1 | ftypavif"], parser: "image", status: "implemented", categories: [IMAGE, TECH], tested: false }),
  // ---------------------------------------------------------------- audio
  f({ id: "mp3", label: "MP3 audio", family: "audio", kind: "audio", mimes: ["audio/mpeg"], extensions: ["mp3"], signatures: ["ID3 | FF Ex frame sync"], parser: "media-container (music-metadata)", status: "implemented", categories: [AUDIO, TECH, DESC, IDS, RIGHTS, TEMPORAL], tested: true }),
  f({ id: "flac", label: "FLAC audio", family: "audio", kind: "audio", mimes: ["audio/flac"], extensions: ["flac"], signatures: ["fLaC"], parser: "media-container (music-metadata)", status: "implemented", categories: [AUDIO, TECH, DESC, INTEG], tested: true }),
  f({ id: "ogg", label: "Ogg Vorbis audio", family: "audio", kind: "audio", mimes: ["audio/ogg", "application/ogg"], extensions: ["ogg", "oga"], signatures: ["OggS + \\x01vorbis"], parser: "media-container (music-metadata)", status: "implemented", categories: [AUDIO, TECH, DESC], tested: false }),
  f({ id: "opus", label: "Ogg Opus audio", family: "audio", kind: "audio", mimes: ["audio/opus"], extensions: ["opus"], signatures: ["OggS + OpusHead"], parser: "media-container (music-metadata)", status: "implemented", categories: [AUDIO, TECH, DESC], tested: false }),
  f({ id: "wav", label: "WAV audio", family: "audio", kind: "audio", mimes: ["audio/wav", "audio/x-wav", "audio/vnd.wave"], extensions: ["wav"], signatures: ["RIFF....WAVE"], parser: "media-container (music-metadata)", status: "implemented", categories: [AUDIO, TECH], tested: true }),
  f({ id: "aiff", label: "AIFF audio", family: "audio", kind: "audio", mimes: ["audio/aiff", "audio/x-aiff"], extensions: ["aif", "aiff", "aifc"], signatures: ["FORM....AIFF | AIFC"], parser: "media-container (music-metadata)", status: "implemented", categories: [AUDIO, TECH], tested: true }),
  f({ id: "m4a", label: "MPEG-4 audio (M4A)", family: "audio", kind: "audio", mimes: ["audio/mp4", "audio/x-m4a"], extensions: ["m4a", "m4b"], signatures: ["....ftypM4A"], parser: "isobmff + media-container", status: "implemented", categories: [AUDIO, TECH, DESC], tested: false }),
  // ---------------------------------------------------------------- video & streaming
  f({ id: "mp4", label: "MP4 video", family: "video", kind: "video", mimes: ["video/mp4"], extensions: ["mp4", "m4v"], signatures: ["....ftyp"], parser: "isobmff", status: "implemented", categories: [VIDEO, AUDIO, TECH, TEMPORAL, STRUCT, A11Y], tested: true }),
  f({ id: "mov", label: "QuickTime video", family: "video", kind: "video", mimes: ["video/quicktime"], extensions: ["mov", "qt"], signatures: ["....ftypqt"], parser: "isobmff", status: "implemented", categories: [VIDEO, AUDIO, TECH, TEMPORAL, STRUCT], tested: false }),
  f({ id: "webm", label: "WebM video", family: "video", kind: "video", mimes: ["video/webm", "audio/webm"], extensions: ["webm"], signatures: ["1A 45 DF A3 + DocType webm"], parser: "ebml", status: "implemented", categories: [VIDEO, AUDIO, TECH, STRUCT, A11Y, DESC], tested: true }),
  f({ id: "mkv", label: "Matroska video", family: "video", kind: "video", mimes: ["video/x-matroska", "video/matroska"], extensions: ["mkv", "mka", "mks"], signatures: ["1A 45 DF A3 + DocType matroska"], parser: "ebml", status: "implemented", categories: [VIDEO, AUDIO, TECH, STRUCT, A11Y, DESC], tested: true }),
  f({ id: "hls", label: "HLS playlist (.m3u8)", family: "streaming", kind: "text", mimes: ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"], extensions: ["m3u8", "m3u"], signatures: ["#EXTM3U"], parser: "stream-manifest", status: "implemented", categories: [VIDEO, AUDIO, STRUCT, TECH, A11Y, ACCESS, DESC], tested: true, notes: "Manifest text only; segments and variant media are never downloaded." }),
  f({ id: "dash", label: "MPEG-DASH manifest (.mpd)", family: "streaming", kind: "xml", mimes: ["application/dash+xml"], extensions: ["mpd"], signatures: ["<MPD"], parser: "stream-manifest", status: "implemented", categories: [VIDEO, AUDIO, STRUCT, TECH, A11Y, ACCESS, DESC], tested: true, notes: "Manifest XML only; media segments are never downloaded." }),
  f({ id: "vtt", label: "WebVTT subtitles", family: "subtitle", kind: "text", mimes: ["text/vtt"], extensions: ["vtt"], signatures: ["WEBVTT"], parser: "subtitles", status: "implemented", categories: [A11Y, STRUCT, DESC, VIDEO], tested: true }),
  f({ id: "srt", label: "SubRip subtitles", family: "subtitle", kind: "text", mimes: ["application/x-subrip", "text/srt"], extensions: ["srt"], signatures: ["1\\n00:00:00,000 --> 00:00:00,000"], parser: "subtitles", status: "implemented", categories: [A11Y, STRUCT, VIDEO], tested: true }),
  f({ id: "ttml", label: "TTML subtitles", family: "subtitle", kind: "xml", mimes: ["application/ttml+xml"], extensions: ["ttml", "dfxp"], signatures: ["<tt xmlns=http://www.w3.org/ns/ttml"], parser: "subtitles", status: "implemented", categories: [A11Y, STRUCT, DESC, VIDEO], tested: true }),
  // ---------------------------------------------------------------- archives
  f({ id: "zip", label: "ZIP archive", family: "archive", kind: "archive", mimes: ["application/zip", "application/x-zip-compressed"], extensions: ["zip"], signatures: ["PK\\x03\\x04 | PK\\x05\\x06"], parser: "archive", status: "implemented", categories: [STRUCT, FS, PRES, INTEG, TECH, ACCESS], tested: true, notes: "Nested enumeration bounded by depth/entries/bytes/time; traversal paths rejected; ratio guard; encrypted entries unavailable without credentials; ZIP64 not supported." }),
  f({ id: "tar", label: "TAR archive", family: "archive", kind: "archive", mimes: ["application/x-tar"], extensions: ["tar"], signatures: ["ustar at offset 257 | valid v7 header checksum"], parser: "archive", status: "implemented", categories: [STRUCT, FS, PRES, INTEG, TECH, ACCESS], tested: true }),
  f({ id: "tar_gz", label: "gzip-compressed TAR", family: "archive", kind: "archive", mimes: ["application/gzip", "application/x-gtar", "application/x-compressed-tar"], extensions: ["tgz", "tar.gz"], signatures: ["1F 8B + ustar after inflate"], parser: "archive", status: "implemented", categories: [STRUCT, FS, PRES, INTEG, TECH, ACCESS], tested: true }),
  f({ id: "gzip", label: "gzip (single file)", family: "archive", kind: "archive", mimes: ["application/gzip", "application/x-gzip"], extensions: ["gz"], signatures: ["1F 8B"], parser: "archive", status: "implemented", categories: [STRUCT, FS, TECH], tested: true, notes: "Decompressed (capped) and handed on as one child resource." }),
  f({ id: "7z", label: "7-Zip archive", family: "archive", kind: "archive", mimes: ["application/x-7z-compressed"], extensions: ["7z"], signatures: ["37 7A BC AF 27 1C"], parser: null, status: "signature_only", categories: [TECH], tested: true, notes: "No pure-JS 7z reader is bundled: contents are unavailable." }),
  f({ id: "rar", label: "RAR archive", family: "archive", kind: "archive", mimes: ["application/vnd.rar", "application/x-rar-compressed"], extensions: ["rar"], signatures: ["Rar!\\x1A\\x07"], parser: null, status: "signature_only", categories: [TECH], tested: true, notes: "No RAR reader is bundled: contents are unavailable." }),
  f({ id: "bzip2", label: "bzip2 stream", family: "archive", kind: "archive", mimes: ["application/x-bzip2"], extensions: ["bz2", "tbz2"], signatures: ["BZh"], parser: null, status: "signature_only", categories: [TECH], tested: false }),
  f({ id: "xz", label: "xz stream", family: "archive", kind: "archive", mimes: ["application/x-xz"], extensions: ["xz", "txz"], signatures: ["FD 37 7A 58 5A 00"], parser: null, status: "signature_only", categories: [TECH], tested: true }),
  f({ id: "zstd", label: "Zstandard stream", family: "archive", kind: "archive", mimes: ["application/zstd"], extensions: ["zst"], signatures: ["28 B5 2F FD"], parser: null, status: "signature_only", categories: [TECH], tested: false }),
  f({ id: "warc", label: "WARC web archive", family: "web_archive", kind: "archive", mimes: ["application/warc"], extensions: ["warc", "warc.gz"], signatures: ["WARC/1.x (optionally per-record gzip)"], parser: "web-archive", status: "implemented", categories: [STRUCT, PRES, TEMPORAL, PROV, REL, TECH, INTEG], tested: true, notes: "Record headers + captured HTTP status/content type; payloads are not re-analysed." }),
  f({ id: "arc", label: "ARC web archive (legacy)", family: "web_archive", kind: "archive", mimes: ["application/x-internet-archive"], extensions: ["arc", "arc.gz"], signatures: ["filedesc://"], parser: "web-archive", status: "implemented", categories: [STRUCT, PRES, TEMPORAL], tested: true }),
  // ---------------------------------------------------------------- scientific / geo
  f({ id: "netcdf", label: "NetCDF classic / 64-bit offset", family: "scientific", kind: "binary", mimes: ["application/x-netcdf", "application/netcdf"], extensions: ["nc", "cdf", "nc3"], signatures: ["CDF\\x01 | CDF\\x02"], parser: "scientific (netcdfjs)", status: "implemented", categories: [SCHEMA, SEM, DESC, PROV, LINEAGE, SPATIAL, TEMPORAL, SCI, STRUCT, RIGHTS], tested: true, notes: "Header only (dimensions, variables, attributes); variable data never read. NetCDF-4 is HDF5 (signature_only); CDF5 unsupported by netcdfjs." }),
  f({ id: "hdf5", label: "HDF5 / NetCDF-4", family: "scientific", kind: "binary", mimes: ["application/x-hdf5", "application/x-hdf"], extensions: ["h5", "hdf5", "he5", "nc4"], signatures: ["\\x89HDF\\r\\n\\x1A\\n at 0/512/1024/2048"], parser: null, status: "signature_only", categories: [TECH], tested: true, notes: "No safe pure-JS HDF5 parser is bundled." }),
  f({ id: "fits", label: "FITS (astronomy)", family: "scientific", kind: "binary", mimes: ["application/fits", "image/fits"], extensions: ["fits", "fit", "fts"], signatures: ["'SIMPLE  =' card at byte 0"], parser: "scientific", status: "implemented", categories: [SCI, DEVICE, TEMPORAL, STRUCT, TECH, DESC, SEM], tested: true, notes: "2880-byte header blocks of every HDU (bounded); data units skipped, never decoded." }),
  f({ id: "geojson", label: "GeoJSON", family: "geo", kind: "json", mimes: ["application/geo+json", "application/vnd.geo+json"], extensions: ["geojson"], signatures: ['"type": "FeatureCollection" | "Feature"'], parser: "geo", status: "implemented", categories: [SPATIAL, STRUCT, SCHEMA], tested: true }),
  f({ id: "kml", label: "KML", family: "geo", kind: "xml", mimes: ["application/vnd.google-earth.kml+xml"], extensions: ["kml"], signatures: ["<kml"], parser: "geo", status: "implemented", categories: [SPATIAL, STRUCT, DESC, TEMPORAL], tested: true }),
  f({ id: "kmz", label: "KMZ (zipped KML)", family: "geo", kind: "archive", mimes: ["application/vnd.google-earth.kmz"], extensions: ["kmz"], signatures: ["PK\\x03\\x04 + *.kml entry"], parser: "geo + archive", status: "implemented", categories: [SPATIAL, STRUCT, DESC, TEMPORAL], tested: true }),
  f({ id: "gpx", label: "GPX track", family: "geo", kind: "xml", mimes: ["application/gpx+xml"], extensions: ["gpx"], signatures: ["<gpx"], parser: "geo", status: "implemented", categories: [SPATIAL, TEMPORAL, STRUCT, DESC, PROV, DEVICE, PRIV], tested: true }),
  // ---------------------------------------------------------------- opaque binaries
  f({ id: "executable", label: "Executable / native binary", family: "binary", kind: "binary", mimes: ["application/x-msdownload", "application/x-executable", "application/x-mach-binary"], extensions: ["exe", "dll", "so", "dylib", "elf"], signatures: ["MZ | \\x7FELF | FE ED FA CE/CF | CA FE BA BE"], parser: null, status: "unsupported", categories: [TECH], tested: true, notes: "Recognised and never executed or parsed." }),
  f({ id: "unknown_binary", label: "Unidentified binary", family: "binary", kind: "binary", mimes: ["application/octet-stream"], extensions: [], signatures: ["(none matched)"], parser: "binary", status: "unsupported", categories: [TECH, INTEG, FS], tested: true, notes: "Only hash, size and leading bytes are recorded." }),
];

export const FORMAT_BY_ID = new Map(FORMATS.map((x) => [x.id, x]));

export interface FormatDetection {
  format: string;
  kind: ResourceKind;
  mime: string;
  method: "signature" | "structure" | "extension" | "declared_mime" | "text_heuristic" | "fallback";
  /** The matched signature (hex/ascii excerpt), when bytes decided. */
  signature: string | null;
  extension: string | null;
  /** Formats the extension alone would suggest. */
  extensionSuggests: string[];
  declaredMime: string | null;
  declaredSuggests: string[];
  /** null when there was no hint to compare against. */
  extensionAgrees: boolean | null;
  declaredAgrees: boolean | null;
  support: FormatStatus;
  /** Extra detection details (e.g. compression wrapper, source-code language). */
  detail?: Record<string, unknown>;
}

/** Lower-case extension of a file name or URL path ("tar.gz"/"warc.gz" style double extensions kept). */
export function extensionOf(nameOrUrl: string | null | undefined): { ext: string | null; base: string } {
  if (!nameOrUrl) return { ext: null, base: "" };
  let path = nameOrUrl;
  const entry = /#entry=([^&]+)/.exec(path);
  if (entry) path = decodeURIComponent(entry[1]);
  else {
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) path = decodeURIComponent(new URL(path).pathname);
    } catch {
      /* keep raw */
    }
  }
  path = path.split(/[?#]/)[0];
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const double = /\.((?:tar|warc|arc)\.gz)$/.exec(base);
  if (double) return { ext: double[1], base };
  const m = /\.([a-z0-9]{1,8})$/.exec(base);
  return { ext: m ? m[1] : null, base };
}

const SOURCE_EXT: Record<string, string> = {
  py: "Python", js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript (TSX)", jsx: "JavaScript (JSX)", java: "Java", kt: "Kotlin", c: "C", h: "C/C++ header", cc: "C++", cpp: "C++", hpp: "C++ header", cs: "C#", go: "Go", rs: "Rust", rb: "Ruby", php: "PHP", swift: "Swift", scala: "Scala", r: "R", jl: "Julia", lua: "Lua", pl: "Perl", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", sql: "SQL", m: "MATLAB/Objective-C", hs: "Haskell", ex: "Elixir", exs: "Elixir", erl: "Erlang", clj: "Clojure", dart: "Dart", f90: "Fortran", for: "Fortran", ipynb: "Jupyter notebook",
};
const SHEBANG: Array<[RegExp, string]> = [[/python/, "Python"], [/node|deno|bun/, "JavaScript"], [/\b(ba|z|k|da)?sh\b/, "Shell"], [/ruby/, "Ruby"], [/perl/, "Perl"], [/php/, "PHP"], [/Rscript/, "R"], [/lua/, "Lua"], [/julia/, "Julia"]];
const SERVER_SIDE = new Set(["php", "asp", "aspx", "jsp", "cgi"]);

export function sourceLanguage(ext: string | null, body: Buffer): string | null {
  const head = body.subarray(0, 200).toString("utf8");
  const sb = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(head);
  if (sb) {
    const interp = sb[1].endsWith("/env") ? sb[2] ?? "" : sb[1];
    for (const [re, lang] of SHEBANG) if (re.test(interp)) return lang;
  }
  if (head.startsWith("<?php")) return "PHP";
  return ext ? SOURCE_EXT[ext] ?? null : null;
}

function hex(b: Buffer, n = 8): string {
  return [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
}

function tarHeaderValid(b: Buffer, off = 0): boolean {
  if (b.length < off + 512) return false;
  const stored = parseInt(b.subarray(off + 148, off + 156).toString("latin1").replace(/\0.*$/s, "").trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[off + i];
  return sum === stored && b[off] !== 0;
}

/** Inflate only a small prefix of a gzip stream (bounded output) to look inside. */
export function gunzipPrefix(b: Buffer, maxIn = 16 * 1024, maxOut = 64 * 1024): Buffer | null {
  try {
    return gunzipSync(b.subarray(0, maxIn), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: maxOut });
  } catch (err) {
    // Output cap reached is fine for peeking — retry with a smaller input window.
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" && maxIn > 512) return gunzipPrefix(b, Math.floor(maxIn / 8), maxOut);
    return null;
  }
}

function gzipOriginalName(b: Buffer): string | null {
  if (!(b[3] & 0x08)) return null; // FNAME flag
  let p = 10;
  if (b[3] & 0x04) p += 2 + b.readUInt16LE(10); // FEXTRA
  const end = b.indexOf(0, p);
  return end > p && end - p < 256 ? b.subarray(p, end).toString("latin1") : null;
}

function ebmlDocType(b: Buffer): string | null {
  const s = b.subarray(0, 128);
  const i = s.indexOf(Buffer.from([0x42, 0x82]));
  if (i < 0) return null;
  const first = s[i + 2];
  if (!first) return null;
  let n = 1;
  while (n <= 8 && !(first & (0x80 >> (n - 1)))) n++;
  if (n > 8) return null;
  let len = first & (0xff >> n);
  for (let k = 1; k < n; k++) len = len * 256 + s[i + 2 + k];
  if (len > 32) return null;
  return s.subarray(i + 2 + n, i + 2 + n + len).toString("latin1");
}

/**
 * Decide a format from the bytes first. Extension and declared MIME are hints
 * that are recorded and compared, never trusted over a signature.
 */
export function detectFormat(body: Buffer, declaredMime: string | null, nameOrUrl: string | null | undefined): FormatDetection {
  const b = body;
  const at = (i: number, s: string) => b.length >= i + s.length && b.subarray(i, i + s.length).toString("latin1") === s;
  const { ext, base } = extensionOf(nameOrUrl);
  const declared = declaredMime?.split(";")[0].trim().toLowerCase() || null;
  let id = null as string | null;
  let method = "signature" as FormatDetection["method"];
  let signature = null as string | null;
  const detail: Record<string, unknown> = {};
  const sig = (format: string, s: string | null = null) => {
    id = format;
    signature = s ?? hex(b);
  };

  // ---- binary signatures
  if (at(0, "%PDF-")) sig("pdf", "%PDF-");
  else if (at(0, "PK\x03\x04") || at(0, "PK\x05\x06")) {
    const head = b.subarray(0, 8000).toString("latin1");
    if (at(30, "mimetype") && /^mimetypeapplication\/epub\+zip/.test(b.subarray(30, 70).toString("latin1"))) sig("epub", "PK\\x03\\x04 mimetype=application/epub+zip");
    else if (/word\/|xl\/|ppt\/|\[Content_Types\]\.xml|mimetypeapplication\/vnd\.oasis/.test(head) || (ext && ["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(ext))) sig("office", "PK\\x03\\x04 + OOXML/ODF parts");
    else if (/\.kml/i.test(head) || ext === "kmz") sig("kmz", "PK\\x03\\x04 + .kml entry");
    else sig("zip", "PK\\x03\\x04");
  } else if (at(0, "Rar!\x1a\x07")) sig("rar", "Rar!\\x1A\\x07");
  else if (at(0, "7z\xbc\xaf\x27\x1c")) sig("7z", "37 7A BC AF 27 1C");
  else if (at(0, "BZh") && b[3] >= 0x31 && b[3] <= 0x39) sig("bzip2", "BZh");
  else if (at(0, "\xfd7zXZ\x00")) sig("xz", "FD 37 7A 58 5A 00");
  else if (b.length >= 4 && b.readUInt32LE(0) === 0xfd2fb528) sig("zstd", "28 B5 2F FD");
  else if (b[0] === 0x1f && b[1] === 0x8b) {
    const inner = gunzipPrefix(b);
    const orig = gzipOriginalName(b);
    if (orig) detail.originalName = orig;
    detail.compression = "gzip";
    if (inner && inner.subarray(257, 262).toString("latin1") === "ustar") sig("tar_gz", "1F 8B + ustar");
    else if (inner && inner.subarray(0, 6).toString("latin1") === "WARC/1") sig("warc", "1F 8B + WARC/1");
    else if (inner && inner.subarray(0, 11).toString("latin1") === "filedesc://") sig("arc", "1F 8B + filedesc://");
    else if (inner && tarHeaderValid(inner)) sig("tar_gz", "1F 8B + tar header checksum");
    else sig("gzip", "1F 8B");
  } else if (b.subarray(257, 262).toString("latin1") === "ustar") sig("tar", "ustar@257");
  else if (at(0, "WARC/1.")) sig("warc", b.subarray(0, 8).toString("latin1"));
  else if (at(0, "filedesc://")) sig("arc", "filedesc://");
  else if (at(0, "CDF\x01") || at(0, "CDF\x02") || at(0, "CDF\x05")) {
    sig("netcdf", `CDF\\x0${b[3]}`);
    detail.netcdfVersion = b[3] === 1 ? "classic" : b[3] === 2 ? "64-bit offset" : "CDF5 (64-bit data)";
  } else if ([0, 512, 1024, 2048].some((o) => at(o, "\x89HDF\r\n\x1a\n"))) {
    sig("hdf5", "\\x89HDF\\r\\n\\x1A\\n");
    if (ext === "nc" || ext === "nc4") detail.note = "NetCDF-4 files are HDF5 containers";
  } else if (at(0, "SIMPLE  =")) sig("fits", "SIMPLE  =");
  else if (at(0, "PAR1")) sig("parquet", "PAR1");
  else if (at(0, "SQLite format 3\x00")) sig("sqlite", "SQLite format 3\\0");
  else if (at(0, "FORM") && (at(8, "AIFF") || at(8, "AIFC"))) sig("aiff", `FORM....${b.subarray(8, 12).toString("latin1")}`);
  else if (at(0, "OggS")) {
    const head = b.subarray(0, 200).toString("latin1");
    if (head.includes("OpusHead")) sig("opus", "OggS + OpusHead");
    else if (head.includes("\x80theora")) {
      sig("ogg", "OggS + theora");
      detail.video = true;
    } else sig("ogg", "OggS");
  } else if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
    const doc = ebmlDocType(b);
    detail.docType = doc;
    sig(doc === "webm" ? "webm" : "mkv", `1A 45 DF A3 DocType=${doc ?? "?"}`);
  } else if (at(4, "ftyp")) {
    const brand = b.subarray(8, 12).toString("latin1");
    if (/^(heic|heix|mif1|avif|msf1)/.test(brand)) sig("heic", `ftyp${brand}`);
    else if (/^M4[ABP]/.test(brand)) sig("m4a", `ftyp${brand}`);
    else if (brand === "qt  ") sig("mov", "ftypqt");
    else sig("mp4", `ftyp${brand}`);
  } else if (at(0, "MZ") || at(0, "\x7fELF") || (b.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(b.readUInt32BE(0)))) sig("executable");

  // ---- text structures (only when no binary signature matched)
  if (!id) {
    const head = b.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
    const trimmed = head.trimStart();
    method = "structure";
    if (/^WEBVTT(?:[ \t]|\r?\n|$)/.test(trimmed)) sig("vtt", "WEBVTT");
    else if (/^#EXTM3U/.test(trimmed)) sig("hls", "#EXTM3U");
    else if (/^\d+\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(trimmed)) sig("srt", "SRT cue block");
    else if (trimmed.startsWith("<")) {
      const root = /<(?!\?|!)([A-Za-z_][\w.:-]*)/.exec(trimmed.replace(/<!--[\s\S]*?-->/g, ""))?.[1] ?? "";
      const local = root.split(":").pop()!.toLowerCase();
      if (local === "mpd") sig("dash", "<MPD");
      else if (local === "tt" && /ttml/i.test(trimmed)) sig("ttml", "<tt xmlns=…ttml");
      else if (local === "kml") sig("kml", "<kml");
      else if (local === "gpx") sig("gpx", "<gpx");
    } else if (/^[{[]/.test(trimmed)) {
      if (base === "package.json" && /"name"\s*:/.test(head)) sig("package_json", "package.json name/version");
      else if (/^\{[\s\S]{0,3000}?"(openapi|swagger)"\s*:\s*"\d/.test(trimmed)) sig("openapi", '"openapi"|"swagger" key');
      else if (/"type"\s*:\s*"(FeatureCollection|Feature|GeometryCollection)"/.test(head) || ext === "geojson" || declared === "application/geo+json") sig("geojson", '"type":"FeatureCollection|Feature"');
      else {
        const lines = b.subarray(0, 64 * 1024).toString("utf8").split(/\r?\n/).filter((l) => l.trim()).slice(0, 4);
        const parsesAsLines = lines.length >= 2 && lines.every((l) => {
          try {
            JSON.parse(l);
            return /^\s*[{[]/.test(l);
          } catch {
            return false;
          }
        });
        if ((ext === "jsonl" || ext === "ndjson" || /ndjson|jsonl|jsonlines/.test(declared ?? "")) || (parsesAsLines && !isWholeJson(b))) sig("jsonl", "one JSON value per line");
      }
    }
    if (!id) {
      method = "extension";
      const textual = looksTextual(b);
      if (textual) {
        if (base === "robots.txt" || (/\/robots\.txt$/i.test(nameOrUrl ?? "") && /^(user-agent|disallow|allow|sitemap)\s*:/im.test(head))) sig("robots_txt", "robots.txt");
        else if (/^requirements[\w.-]*\.(txt|in)$/.test(base)) sig("requirements_txt", base);
        else if (base === "pyproject.toml") sig("pyproject", base);
        else if (base === "cargo.toml") sig("cargo_toml", base);
        else if (ext === "toml" || declared === "application/toml") sig("toml", ".toml");
        else if (ext === "yaml" || ext === "yml" || /yaml/.test(declared ?? "")) sig(/^(openapi|swagger)\s*:/m.test(head) ? "openapi" : "yaml", ext ? `.${ext}` : declared);
        else if (ext === "jsonl" || ext === "ndjson") sig("jsonl", `.${ext}`);
        else if (ext === "m3u8") sig("hls", ".m3u8");
        else if (ext === "srt") sig("srt", ".srt");
        else {
          const sniff = sniffKind(b, declared, nameOrUrl ?? "");
          const lang = sniff.kind === "webpage" ? null : sourceLanguage(ext && SERVER_SIDE.has(ext) && !head.startsWith("<?php") ? null : ext, b);
          if (lang && !(ext && ["json", "xml", "csv", "md", "txt", "html", "htm"].includes(ext))) {
            sig("source_code", head.startsWith("#!") ? "#! shebang" : `.${ext}`);
            if (head.startsWith("#!")) method = "signature";
            detail.language = lang;
          }
        }
      }
    }
  }

  let kind: ResourceKind;
  let mime: string;
  if (id) {
    const spec = FORMAT_BY_ID.get(id)!;
    kind = spec.kind;
    mime = spec.mimes[0] ?? (spec.kind === "text" ? "text/plain" : "application/octet-stream");
    if (id === "office" || id === "pdf" || ["jpeg", "png"].includes(id)) {
      const s = sniffKind(b, declared, nameOrUrl ?? "");
      mime = s.sniffed;
    }
    if (id === "ogg" && detail.video) kind = "video";
    if (id === "openapi" && !/^\s*\{/.test(b.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, ""))) kind = "text"; // YAML spec
    if (id === "webm" && /audio/.test(declared ?? "")) kind = "audio";
  } else {
    // Fall back to the established sniffer for web/text/image formats.
    const s = sniffKind(b, declared, nameOrUrl ?? "");
    kind = s.kind;
    mime = s.sniffed;
    id = mimeToFormat(s.sniffed, s.kind);
    method = s.kind === "binary" ? "fallback" : signatureKinds.has(s.kind) ? "signature" : s.kind === "text" ? "text_heuristic" : declared && s.sniffed === declared ? "declared_mime" : "structure";
    signature = method === "signature" ? hex(b) : null;
  }
  const spec = FORMAT_BY_ID.get(id)!;
  const extensionSuggests = ext ? FORMATS.filter((x) => x.extensions.includes(ext)).map((x) => x.id) : [];
  const declaredSuggests = declared ? FORMATS.filter((x) => x.mimes.includes(declared)).map((x) => x.id) : [];
  const agrees = (sugg: string[]) => (sugg.length ? sugg.includes(id!) || sugg.some((s) => FORMAT_BY_ID.get(s)!.family === spec.family && spec.family !== "binary") : null);
  return {
    format: id,
    kind,
    mime,
    method,
    signature,
    extension: ext,
    extensionSuggests,
    declaredMime: declared,
    declaredSuggests,
    extensionAgrees: agrees(extensionSuggests),
    declaredAgrees: declared && !["application/octet-stream", "text/plain", "binary/octet-stream"].includes(declared) ? agrees(declaredSuggests) : null,
    support: spec.status,
    detail: Object.keys(detail).length ? detail : undefined,
  };
}

const signatureKinds = new Set<ResourceKind>(["image", "audio", "video", "pdf", "office", "archive"]);

function isWholeJson(b: Buffer): boolean {
  if (b.length > 2 * 1024 * 1024) return false; // too big to probe; line structure decides
  try {
    JSON.parse(b.toString("utf8").replace(/^﻿/, ""));
    return true;
  } catch {
    return false;
  }
}

function looksTextual(b: Buffer): boolean {
  const sample = b.subarray(0, 2048);
  if (!sample.length) return true;
  let printable = 0;
  for (const byte of sample) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable++;
  return printable / sample.length > 0.95 && !sample.includes(0);
}

function mimeToFormat(mime: string, kind: ResourceKind): string {
  const exact = FORMATS.find((x) => x.mimes.includes(mime));
  if (exact) return exact.id;
  if (kind === "image") return "jpeg";
  if (kind === "binary") return "unknown_binary";
  return FORMATS.find((x) => x.kind === kind && ["html", "xml", "feed", "json", "csv", "text", "email", "pdf", "office", "zip", "mp4", "mp3"].includes(x.id))?.id ?? "unknown_binary";
}

/** Formats whose metadata applies to a category even when the coarse kind would not (used by coverage). */
export function formatCategories(formatId: string | undefined): number[] {
  return (formatId && FORMAT_BY_ID.get(formatId)?.categories) || [];
}
