import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { clean, normalizeDate } from "../normalize.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const maskSerial = (s: string) => (s.length <= 4 ? "****" : `${"*".repeat(s.length - 4)}${s.slice(-4)}`);

export const imageExtractor: Extractor = {
  id: "image",
  version: "1.0.0",
  description: "Image dimensions/format (image-size) and EXIF/IPTC/XMP/ICC (exifr).",
  kinds: ["image"],
  categories: [C.image, C.technical, C.descriptive, C.rights, C.temporal, C.spatial, C.device_sensor, C.provenance, C.privacy, C.accessibility],
  timeoutMs: 4000,
  async run(ctx) {
    const body = ctx.response.body;
    const { imageSize } = await import("image-size");
    try {
      const dim = imageSize(body);
      const o = { status: "observed" as const, method: "image-size header parse" };
      ctx.add(C.image, "width", dim.width, o);
      ctx.add(C.image, "height", dim.height, o);
      ctx.add(C.image, "format", dim.type, o);
      ctx.add(C.technical, "width", dim.width, o);
      ctx.add(C.technical, "height", dim.height, o);
      ctx.add(C.technical, "format", dim.type, o);
      if (dim.orientation) ctx.add(C.image, "orientation", dim.orientation, o);
      if (dim.images?.length) ctx.add(C.image, "frames", dim.images.length, o);
    } catch (err) {
      ctx.add(C.image, "dimensionsError", (err as Error).message, { status: "extraction_failed", method: "image-size" });
    }
    const exifr = (await import("exifr")).default;
    let tags: Record<string, unknown> | undefined;
    try {
      tags = await exifr.parse(body, { tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: true, interop: false, translateValues: true, reviveValues: true, mergeOutput: true });
    } catch {
      tags = undefined;
    }
    if (!tags) return;
    const t = (k: string) => tags![k];
    const m = (k: string) => ({ method: `exif/iptc/xmp:${k}` });
    ctx.add(C.image, "make", clean(t("Make")), m("Make"));
    ctx.add(C.image, "model", clean(t("Model")), m("Model"));
    ctx.add(C.image, "lens", clean(t("LensModel") ?? t("Lens")), m("LensModel"));
    ctx.add(C.image, "orientation", t("Orientation"), m("Orientation"));
    ctx.add(C.image, "colorSpace", clean(t("ColorSpace") ?? t("ColorSpaceData")), m("ColorSpace"));
    ctx.add(C.image, "iccProfile", clean(t("ProfileDescription")), m("ICC ProfileDescription"));
    const exposure = Object.fromEntries(
      ["ExposureTime", "FNumber", "ISO", "FocalLength", "Flash", "WhiteBalance", "ExposureProgram"].filter((k) => t(k) !== undefined).map((k) => [k, t(k)]),
    );
    ctx.add(C.image, "exposure", exposure, m("Exposure*"));
    ctx.add(C.device_sensor, "deviceMake", clean(t("Make")), m("Make"));
    ctx.add(C.device_sensor, "deviceModel", clean(t("Model")), m("Model"));
    ctx.add(C.device_sensor, "firmware", clean(t("Software")), m("Software"));
    const serial = clean(t("SerialNumber") ?? t("BodySerialNumber") ?? t("LensSerialNumber"));
    if (serial) ctx.add(C.device_sensor, "serialNumber", maskSerial(serial), { ...m("SerialNumber"), masked: true, sensitivity: "personal" });
    ctx.add(C.provenance, "creatorTool", clean(t("CreatorTool") ?? t("Software")), m("CreatorTool|Software"));
    ctx.add(C.descriptive, "title", clean(t("title") ?? t("ObjectName") ?? t("Headline")), m("title|ObjectName"));
    ctx.add(C.descriptive, "description", clean(t("description") ?? t("ImageDescription") ?? t("Caption")), m("description|ImageDescription"));
    const creator = t("creator") ?? t("Artist") ?? t("Byline");
    ctx.add(C.descriptive, "author", Array.isArray(creator) ? creator.map(String) : creator ? [String(creator)] : [], m("creator|Artist|By-line"));
    const kw = t("subject") ?? t("Keywords");
    ctx.add(C.descriptive, "keywords", Array.isArray(kw) ? kw.map(String).slice(0, 40) : kw ? [String(kw)] : [], m("subject|Keywords"));
    ctx.add(C.rights, "copyright", clean(t("Copyright") ?? t("CopyrightNotice") ?? t("rights")), m("Copyright|rights"));
    ctx.add(C.rights, "rightsStatement", clean(t("UsageTerms") ?? t("WebStatement")), m("UsageTerms|WebStatement"));
    ctx.add(C.accessibility, "altTextExtended", clean(t("AltTextAccessibility") ?? t("ExtDescrAccessibility")), m("AltTextAccessibility"));
    for (const [k, f] of [["DateTimeOriginal", "created"], ["CreateDate", "created"], ["ModifyDate", "modified"], ["DateCreated", "created"]] as const) {
      const v = t(k);
      const d = normalizeDate(v instanceof Date ? v.toISOString() : v);
      if (d) ctx.add(C.temporal, f, d.iso, { ...m(k), original: d.original, evidence: "EXIF dates carry no timezone unless OffsetTime is set; interpreted as UTC" });
    }
    if (typeof t("latitude") === "number" && typeof t("longitude") === "number") {
      // Precise photo GPS can locate private individuals: round to ~1 km (Phase 9 / category 13 guidance).
      ctx.add(C.spatial, "gps", { lat: round2(t("latitude") as number), lon: round2(t("longitude") as number), precision: "rounded to 0.01° (~1 km)" }, { ...m("GPS"), masked: true, sensitivity: "personal" });
      ctx.add(C.privacy, "containsGps", true, { status: "observed", method: "exif GPS presence", evidence: "embedded GPS coordinates present (rounded in output)" });
    }
    ctx.add(C.spatial, "placename", clean([t("City"), t("State") ?? t("Province-State"), t("Country") ?? t("Country-PrimaryLocationName")].filter(Boolean).join(", ")), m("City/State/Country"));
  },
};

export const audioVideoExtractor: Extractor = {
  id: "media-container",
  version: "1.0.0",
  description: "Audio/video container metadata via music-metadata (MP3, FLAC, OGG, WAV, MP4/M4A, Matroska/WebM).",
  kinds: ["audio", "video"],
  categories: [C.audio, C.video, C.technical, C.descriptive, C.identifiers, C.rights, C.temporal, C.accessibility, C.structural, C.integrity],
  timeoutMs: 6000,
  async run(ctx) {
    const { parseBuffer } = await import("music-metadata");
    const meta = await parseBuffer(new Uint8Array(ctx.response.body), { mimeType: ctx.sniffedType, size: ctx.response.body.length }, { duration: false, skipCovers: true });
    const f = meta.format;
    const c = meta.common;
    const o = (k: string) => ({ status: "observed" as const, method: `music-metadata format.${k}` });
    const d = (k: string) => ({ method: `music-metadata tag ${k}` });
    const video = ctx.kind === "video";
    const cat = video ? C.video : C.audio;
    if (video) ctx.add(C.video, "container", f.container, o("container"));
    if (!(video && ctx.response.body.subarray(4, 8).toString("latin1") === "ftyp")) ctx.add(cat, "duration", f.duration ? round2(f.duration) : null, o("duration"));
    if (!video) {
      ctx.add(C.audio, "codec", f.codec, o("codec"));
      ctx.add(C.audio, "sampleRate", f.sampleRate, o("sampleRate"));
    }
    ctx.add(C.audio, "bitrate", f.bitrate ? Math.round(f.bitrate) : null, o("bitrate"));
    ctx.add(C.audio, "channels", f.numberOfChannels, o("numberOfChannels"));
    ctx.add(C.audio, "bitsPerSample", f.bitsPerSample, o("bitsPerSample"));
    ctx.add(C.audio, "lossless", f.lossless, o("lossless"));
    ctx.add(C.technical, "container", f.container, o("container"));
    ctx.add(C.technical, "codec", f.codec, o("codec"));
    ctx.add(C.technical, "encoder", f.tool, o("tool"));
    ctx.add(C.technical, "tagTypes", f.tagTypes, o("tagTypes"));
    const tracks = (f.trackInfo ?? []).map((tr) => ({
      type: tr.type ?? null,
      codec: tr.codecName ?? null,
      language: tr.language ?? null,
      name: tr.name ?? null,
      width: tr.video?.pixelWidth ?? null,
      height: tr.video?.pixelHeight ?? null,
      channels: tr.audio?.channels ?? null,
      sampleRate: tr.audio?.samplingFrequency ?? null,
    }));
    if (!video) ctx.add(C.structural, "trackCount", tracks.length || null, o("trackInfo"));
    // ISO-BMFF video is handled by the dedicated box parser (music-metadata is audio-centric there).
    const isoBmff = ctx.response.body.subarray(4, 8).toString("latin1") === "ftyp";
    if (video && !isoBmff) {
      ctx.add(C.video, "tracks", tracks, o("trackInfo"));
      const v = tracks.find((t) => t.width);
      ctx.add(C.video, "width", v?.width, o("trackInfo.video"));
      ctx.add(C.video, "height", v?.height, o("trackInfo.video"));
      ctx.add(C.video, "videoCodec", tracks.find((t) => String(t.type) === "1" || t.width)?.codec ?? f.codec, o("trackInfo"));
      ctx.add(C.video, "audioCodec", tracks.find((t) => t.channels)?.codec, o("trackInfo"));
      const subs = tracks.filter((t) => String(t.type) === "17" || /S_TEXT|subtitle|tx3g|wvtt|mov_text/i.test(String(t.codec)));
      ctx.add(C.video, "subtitleTracks", subs.map((s) => ({ codec: s.codec, language: s.language, name: s.name })), o("trackInfo (text tracks)"));
      ctx.add(C.accessibility, "captionTracks", subs.length, { status: "observed", method: "container text tracks", evidence: "track presence is not proof of caption quality" });
    }
    if (f.chapters?.length) ctx.add(cat, "chapters", f.chapters.slice(0, 50).map((ch) => ({ title: ch.title, start: ch.sampleOffset })), o("chapters"));
    // Container epoch-zero timestamps (1904/1970) mean "unset" — never report them as real dates.
    const real = (d?: Date) => (d && d.getTime() > Date.UTC(1990, 0, 1) ? d.toISOString() : null);
    if (real(f.creationTime)) ctx.add(C.temporal, "created", real(f.creationTime), { ...o("creationTime"), status: "source_declared" });
    if (real(f.modificationTime)) ctx.add(C.temporal, "modified", real(f.modificationTime), { ...o("modificationTime"), status: "source_declared" });
    ctx.add(C.audio, "title", c.title, d("title"));
    ctx.add(C.audio, "artist", c.artists ?? (c.artist ? [c.artist] : []), d("artist"));
    ctx.add(C.audio, "album", c.album, d("album"));
    ctx.add(C.descriptive, "title", c.title, d("title"));
    ctx.add(C.descriptive, "author", c.artists ?? (c.artist ? [c.artist] : []), d("artist"));
    ctx.add(C.descriptive, "subject", c.genre ?? [], d("genre"));
    ctx.add(C.descriptive, "description", clean(c.description?.join(" ") ?? c.comment?.map((x) => (typeof x === "string" ? x : x.text)).join(" ")), d("description|comment"));
    ctx.add(C.descriptive, "language", c.language, d("language"));
    if (c.year) ctx.add(C.temporal, "published", `${c.year}-01-01T00:00:00.000Z`, { ...d("year"), original: String(c.year) });
    ctx.add(C.identifiers, "isrc", c.isrc ?? [], d("isrc"));
    ctx.add(C.identifiers, "identifier", [...(c.musicbrainz_recordingid ? [`musicbrainz:${c.musicbrainz_recordingid}`] : []), ...(c.barcode ? [`barcode:${c.barcode}`] : [])], d("musicbrainz|barcode"));
    ctx.add(C.rights, "copyright", c.copyright, d("copyright"));
    ctx.add(C.rights, "license", c.license, d("license"));
    if (f.audioMD5) ctx.add(C.integrity, "embeddedAudioMd5", Buffer.from(f.audioMD5).toString("hex"), d("flac STREAMINFO md5"));
    if (ctx.response.truncated) ctx.add(C.quality, "truncated", true, { status: "observed", method: "body cap", evidence: "parsed from file prefix; duration/tags at end of file may be missing" });
  },
};
