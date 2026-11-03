import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { clean } from "../normalize.js";

/** EBML variable-length integer. `keepMarker` for element IDs. Returns [value, length] or null. */
function vint(b: Buffer, p: number, keepMarker: boolean): [number, number] | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > b.length) return null;
  let v = keepMarker ? first : first & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) return [-1, len]; // unknown size
  return [v, len];
}

interface El {
  id: number;
  start: number;
  end: number;
}

function* children(b: Buffer, start: number, end: number): Generator<El> {
  let p = start;
  let guard = 0;
  while (p < end && guard++ < 100_000) {
    const id = vint(b, p, true);
    if (!id) return;
    const size = vint(b, p + id[1], false);
    if (!size) return;
    const s = p + id[1] + size[1];
    const e = size[0] < 0 ? end : Math.min(end, s + size[0]);
    yield { id: id[0], start: s, end: e };
    if (size[0] < 0 && id[0] !== 0x18538067) return;
    p = size[0] < 0 ? s : e;
  }
}

const uint = (b: Buffer, el: El) => {
  let v = 0;
  for (let i = el.start; i < el.end && i < el.start + 8; i++) v = v * 256 + b[i];
  return v;
};
const float = (b: Buffer, el: El) => (el.end - el.start === 4 ? b.readFloatBE(el.start) : el.end - el.start === 8 ? b.readDoubleBE(el.start) : null);
const text = (b: Buffer, el: El) => b.subarray(el.start, Math.min(el.end, el.start + 512)).toString("utf8").replace(/\0+$/, "");

const TRACK_TYPE: Record<number, string> = { 1: "video", 2: "audio", 3: "complex", 0x10: "logo", 0x11: "subtitle", 0x12: "buttons", 0x20: "control", 0x21: "metadata" };

/** WebM / Matroska: EBML header, Segment Info and Tracks only — clusters (media data) are never read. */
export const ebmlExtractor: Extractor = {
  id: "ebml",
  version: "1.0.0",
  description: "WebM/Matroska EBML: DocType, segment info (duration, title, muxing/writing app, date), tracks (type, codec, language, resolution, sample rate, channels, frame rate), chapters. Stops at the first Cluster.",
  kinds: ["video", "audio"],
  formats: ["webm", "mkv"],
  categories: [C.video, C.audio, C.technical, C.structural, C.accessibility, C.descriptive, C.provenance, C.temporal],
  timeoutMs: 2000,
  async run(ctx) {
    const b = ctx.response.body;
    const top = [...children(b, 0, b.length)];
    const header = top.find((e) => e.id === 0x1a45dfa3);
    const seg = top.find((e) => e.id === 0x18538067);
    if (!header) {
      ctx.add(C.technical, "ebmlHeader", "EBML header missing", { status: "extraction_failed", method: "EBML element walk" });
      return;
    }
    const o = { status: "observed" as const, method: "EBML element walk (Info/Tracks only)" };
    for (const e of children(b, header.start, header.end)) {
      if (e.id === 0x4282) ctx.add(C.technical, "docType", text(b, e), o);
      if (e.id === 0x4287) ctx.add(C.technical, "docTypeVersion", uint(b, e), o);
    }
    if (!seg) {
      ctx.add(C.video, "segment", ctx.response.truncated ? "Segment beyond fetched prefix" : "no Segment element", { status: "extraction_failed", method: "EBML element walk" });
      return;
    }
    const tracks: Array<Record<string, unknown>> = [];
    let scale = 1_000_000;
    let duration: number | null = null;
    let chapters = 0;
    for (const e of children(b, seg.start, seg.end)) {
      if (e.id === 0x1f43b675) break; // first Cluster: media data starts — stop
      if (e.id === 0x1549a966) {
        for (const i of children(b, e.start, e.end)) {
          if (i.id === 0x2ad7b1) scale = uint(b, i) || scale;
          else if (i.id === 0x4489) duration = float(b, i);
          else if (i.id === 0x7ba9) ctx.add(C.descriptive, "title", clean(text(b, i)), { method: "Matroska Info/Title" });
          else if (i.id === 0x4d80) ctx.add(C.provenance, "muxingApp", text(b, i), { method: "Matroska Info/MuxingApp" });
          else if (i.id === 0x5741) ctx.add(C.provenance, "creatorTool", text(b, i), { method: "Matroska Info/WritingApp" });
          else if (i.id === 0x4461 && i.end - i.start === 8) {
            const ms = Date.UTC(2001, 0, 1) + Number(b.readBigInt64BE(i.start) / 1_000_000n);
            if (ms > Date.UTC(1990, 0, 1) && ms < Date.UTC(2200, 0, 1)) ctx.add(C.temporal, "created", new Date(ms).toISOString(), { method: "Matroska Info/DateUTC" });
          }
        }
      } else if (e.id === 0x1654ae6b) {
        for (const t of children(b, e.start, e.end)) {
          if (t.id !== 0xae || tracks.length >= 64) continue;
          const tr: Record<string, unknown> = {};
          for (const f of children(b, t.start, t.end)) {
            if (f.id === 0xd7) tr.number = uint(b, f);
            else if (f.id === 0x83) tr.type = TRACK_TYPE[uint(b, f)] ?? `type ${uint(b, f)}`;
            else if (f.id === 0x86) tr.codec = text(b, f);
            else if (f.id === 0x22b59c) tr.language = text(b, f);
            else if (f.id === 0x22b59d) tr.language = text(b, f);
            else if (f.id === 0x536e) tr.name = text(b, f);
            else if (f.id === 0x23e383) {
              const ns = uint(b, f);
              if (ns) tr.frameRate = Math.round((1e9 / ns) * 1000) / 1000;
            } else if (f.id === 0xe0) {
              for (const v of children(b, f.start, f.end)) {
                if (v.id === 0xb0) tr.width = uint(b, v);
                if (v.id === 0xba) tr.height = uint(b, v);
              }
            } else if (f.id === 0xe1) {
              for (const a of children(b, f.start, f.end)) {
                if (a.id === 0xb5) tr.sampleRate = float(b, a);
                if (a.id === 0x9f) tr.channels = uint(b, a);
                if (a.id === 0x6264) tr.bitDepth = uint(b, a);
              }
            }
          }
          tracks.push(tr);
        }
      } else if (e.id === 0x1043a770) {
        for (const ed of children(b, e.start, e.end)) if (ed.id === 0x45b9) for (const at of children(b, ed.start, ed.end)) if (at.id === 0xb6) chapters++;
      }
    }
    const cat = ctx.kind === "video" ? C.video : C.audio;
    if (duration !== null) ctx.add(cat, "duration", Math.round(((duration * scale) / 1e9) * 1000) / 1000, { ...o, method: "Matroska Info/Duration × TimecodeScale" });
    ctx.add(C.structural, "trackCount", tracks.length, o);
    ctx.add(C.video, "tracks", tracks, o);
    const v = tracks.find((t) => t.type === "video");
    const a = tracks.find((t) => t.type === "audio");
    const subs = tracks.filter((t) => t.type === "subtitle");
    if (v) {
      ctx.add(C.video, "width", v.width, o);
      ctx.add(C.video, "height", v.height, o);
      ctx.add(C.video, "videoCodec", v.codec, o);
      ctx.add(C.video, "frameRate", v.frameRate, { ...o, method: "TrackEntry/DefaultDuration" });
    }
    if (a) {
      ctx.add(C.video, "audioCodec", a.codec, o);
      ctx.add(C.audio, "codec", a.codec, o);
      ctx.add(C.audio, "sampleRate", a.sampleRate, o);
      ctx.add(C.audio, "channels", a.channels, o);
    }
    ctx.add(C.video, "subtitleTracks", subs.map((s) => ({ codec: s.codec, language: s.language ?? "eng (Matroska default)", name: s.name ?? null })), o);
    ctx.add(C.accessibility, "captionTracks", subs.length, { ...o, evidence: "track presence is not proof of caption quality" });
    if (chapters) ctx.add(C.video, "chapters", [{ count: chapters }], o);
    const langs = [...new Set(tracks.map((t) => t.language).filter(Boolean))];
    if (langs.length) ctx.add(C.descriptive, "language", langs.join(", "), o);
    const known = /^(V_VP8|V_VP9|V_AV1|V_MPEG4\/ISO\/AVC|V_MPEGH\/ISO\/HEVC|V_THEORA|A_OPUS|A_VORBIS|A_AAC|A_FLAC|A_MPEG\/L3|A_AC3|A_EAC3|A_PCM\/.*|S_TEXT\/.*|S_VOBSUB|S_HDMV\/PGS|D_WEBVTT\/.*)$/;
    const unknown = tracks.filter((t) => t.codec && !known.test(String(t.codec))).map((t) => t.codec);
    if (unknown.length) ctx.add(C.technical, "unrecognisedCodecs", unknown, { ...o, evidence: "codec id recorded verbatim; not decoded" });
  },
};
