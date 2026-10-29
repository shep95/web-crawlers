import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts", "dinf", "meta", "ilst"]);
const MAC_EPOCH = Date.UTC(1904, 0, 1);

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString("latin1");
    let header = 8;
    if (size === 1 && p + 16 <= end) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

function find(buf: Buffer, parent: Box, type: string): Box | undefined {
  for (const b of boxes(buf, parent.start + (parent.type === "meta" ? 4 : 0), parent.end)) if (b.type === type) return b;
  return undefined;
}

function macDate(seconds: number): string | null {
  // 0 means "not set" in ISO-BMFF; never report the 1904 epoch as a real date.
  if (!seconds) return null;
  const t = MAC_EPOCH + seconds * 1000;
  return t > Date.UTC(1990, 0, 1) && t < Date.UTC(2200, 0, 1) ? new Date(t).toISOString() : null;
}

function lang(code: number): string | null {
  if (!code || code === 0x7fff) return null;
  const s = String.fromCharCode(((code >> 10) & 31) + 0x60, ((code >> 5) & 31) + 0x60, (code & 31) + 0x60);
  return s === "und" ? null : s;
}

/** ISO Base Media (MP4/MOV/M4A/3GP): movie header, tracks, codecs, frame rate, languages, subtitles, chapters. */
export const isoBmffExtractor: Extractor = {
  id: "isobmff",
  version: "1.0.0",
  description: "MP4/MOV box parser: duration, resolution, per-track codec/handler/language, frame rate from sample timing, subtitle & chapter tracks.",
  kinds: ["video", "audio"],
  categories: [C.video, C.audio, C.technical, C.temporal, C.structural, C.accessibility],
  timeoutMs: 3000,
  async run(ctx) {
    const buf = ctx.response.body;
    if (buf.subarray(4, 8).toString("latin1") !== "ftyp") return;
    const root: Box = { type: "root", start: 0, end: buf.length };
    const ftyp = find(buf, root, "ftyp")!;
    const brand = buf.subarray(ftyp.start, ftyp.start + 4).toString("latin1");
    ctx.add(C.technical, "majorBrand", brand.trim(), { status: "observed", method: "ftyp major_brand" });
    const moov = find(buf, root, "moov");
    if (!moov) {
      ctx.add(C.video, "moovMissing", ctx.response.truncated ? "movie header beyond fetched prefix" : "no moov box", { status: "extraction_failed", method: "isobmff box walk" });
      return;
    }
    const o = (m: string) => ({ status: "observed" as const, method: `isobmff ${m}`, evidenceType: "direct_extraction" as const });
    const mvhd = find(buf, moov, "mvhd");
    let duration: number | null = null;
    if (mvhd) {
      const v = buf[mvhd.start];
      const ts = v === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12);
      const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
      const created = macDate(v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 4)) : buf.readUInt32BE(mvhd.start + 4));
      if (ts) duration = Math.round((dur / ts) * 1000) / 1000;
      const cat = ctx.kind === "video" ? C.video : C.audio;
      ctx.add(cat, "duration", duration, o("mvhd duration/timescale"));
      if (created) ctx.add(C.temporal, "created", created, { ...o("mvhd creation_time"), status: "source_declared" });
    }
    const tracks: Array<Record<string, unknown>> = [];
    for (const trak of boxes(buf, moov.start, moov.end)) {
      if (trak.type !== "trak") continue;
      const t: Record<string, unknown> = {};
      const tkhd = find(buf, trak, "tkhd");
      if (tkhd) {
        const v = buf[tkhd.start];
        const off = tkhd.start + (v === 1 ? 88 : 76);
        if (off + 8 <= tkhd.end) {
          const w = buf.readUInt32BE(off) / 65536;
          const h = buf.readUInt32BE(off + 4) / 65536;
          if (w && h) Object.assign(t, { width: Math.round(w), height: Math.round(h) });
        }
      }
      const mdia = find(buf, trak, "mdia");
      if (mdia) {
        const mdhd = find(buf, mdia, "mdhd");
        let timescale = 0;
        if (mdhd) {
          const v = buf[mdhd.start];
          timescale = v === 1 ? buf.readUInt32BE(mdhd.start + 20) : buf.readUInt32BE(mdhd.start + 12);
          const l = lang(buf.readUInt16BE(mdhd.start + (v === 1 ? 32 : 20)));
          if (l) t.language = l;
        }
        const hdlr = find(buf, mdia, "hdlr");
        if (hdlr) t.handler = buf.subarray(hdlr.start + 8, hdlr.start + 12).toString("latin1");
        const stbl = (() => {
          const minf = find(buf, mdia, "minf");
          return minf ? find(buf, minf, "stbl") : undefined;
        })();
        if (stbl) {
          const stsd = find(buf, stbl, "stsd");
          if (stsd && stsd.start + 16 <= stsd.end) t.codec = buf.subarray(stsd.start + 12, stsd.start + 16).toString("latin1");
          const stts = find(buf, stbl, "stts");
          if (stts && timescale && t.handler === "vide") {
            const n = buf.readUInt32BE(stts.start + 4);
            let samples = 0;
            let ticks = 0;
            for (let i = 0; i < Math.min(n, 1000); i++) {
              const c = buf.readUInt32BE(stts.start + 8 + i * 8);
              const d = buf.readUInt32BE(stts.start + 12 + i * 8);
              samples += c;
              ticks += c * d;
            }
            if (samples && ticks) t.frameRate = Math.round((samples / (ticks / timescale)) * 1000) / 1000;
          }
        }
      }
      tracks.push(t);
    }
    ctx.add(C.structural, "trackCount", tracks.length, o("trak count"));
    const video = tracks.find((t) => t.handler === "vide");
    const audio = tracks.find((t) => t.handler === "soun");
    const subs = tracks.filter((t) => ["subt", "text", "sbtl", "clcp"].includes(String(t.handler)));
    if (ctx.kind === "video") {
      ctx.add(C.video, "tracks", tracks, o("trak/mdia/hdlr/stsd"));
      ctx.add(C.video, "width", video?.width, o("tkhd width"));
      ctx.add(C.video, "height", video?.height, o("tkhd height"));
      ctx.add(C.video, "videoCodec", video?.codec, o("stsd sample entry"));
      ctx.add(C.video, "frameRate", video?.frameRate, o("stts sample timing"));
      ctx.add(C.video, "audioCodec", audio?.codec, o("stsd sample entry"));
      ctx.add(C.video, "subtitleTracks", subs.map((s) => ({ codec: s.codec, language: s.language ?? null })), o("hdlr subt/text"));
      ctx.add(C.accessibility, "captionTracks", subs.length, { ...o("subtitle/text tracks"), evidence: "presence of a text track does not prove caption quality" });
      ctx.add(C.technical, "width", video?.width, o("tkhd width"));
      ctx.add(C.technical, "height", video?.height, o("tkhd height"));
      const chpl = tracks.some((t) => t.handler === "text" && tracks.length > 1);
      if (chpl) ctx.add(C.video, "chapterTrack", true, o("text track referenced as chapters"));
    }
    if (audio) ctx.add(C.audio, "codec", audio.codec, o("stsd sample entry"));
    const langs = [...new Set(tracks.map((t) => t.language).filter(Boolean))];
    if (langs.length) ctx.add(C.descriptive, "language", langs.join(", "), o("mdhd language"));
  },
};
