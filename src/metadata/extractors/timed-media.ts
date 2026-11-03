import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { clean, normalizeDate } from "../normalize.js";

const MAX_CUES = 20_000;
const OUT_CUES = 200;
const MAX_TEXT = 4 * 1024 * 1024;

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** "01:02:03.456" | "02:03.456" | "01:02:03,456" → seconds. */
export function clockToSeconds(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const [, h = "0", mi, se, ms = "0"] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(se) + Number(ms.padEnd(3, "0")) / 1000;
}

/** TTML time expressions: clock time or offset time ("1.5s", "300ms", "2m", "1h"). Frames/ticks need frame rate → null. */
function ttmlTime(s: string | undefined): number | null {
  if (!s) return null;
  const off = /^([\d.]+)(h|m|s|ms)$/.exec(s.trim());
  if (off) return Number(off[1]) * ({ h: 3600, m: 60, s: 1, ms: 0.001 } as Record<string, number>)[off[2]];
  return clockToSeconds(s.replace(/^(\d+:\d{2}:\d{2}):(\d+)$/, "$1"));
}

export function parseVtt(text: string): { header: Record<string, string>; cues: Cue[]; malformed: number; notes: number; styles: number } {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const header: Record<string, string> = {};
  for (const line of blocks[0].split("\n").slice(1)) {
    const m = /^([A-Za-z-]+)\s*:\s*(.+)$/.exec(line);
    if (m) header[m[1].toLowerCase()] = m[2].trim();
  }
  const cues: Cue[] = [];
  let malformed = 0;
  let notes = 0;
  let styles = 0;
  for (const b of blocks.slice(1)) {
    if (cues.length >= MAX_CUES) break;
    const lines = b.split("\n").filter((l, i) => i > 0 || l.trim());
    if (!lines.length) continue;
    if (/^NOTE\b/.test(lines[0])) {
      notes++;
      continue;
    }
    if (/^(STYLE|REGION)\b/.test(lines[0])) {
      styles++;
      continue;
    }
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0 || ti > 1) {
      malformed++;
      continue;
    }
    const [a, rest] = lines[ti].split("-->");
    const start = clockToSeconds(a);
    const end = clockToSeconds(rest.trim().split(/\s+/)[0]);
    if (start === null || end === null || end < start) {
      malformed++;
      continue;
    }
    cues.push({ start, end, text: lines.slice(ti + 1).join("\n").replace(/<[^>]+>/g, "").trim() });
  }
  return { header, cues, malformed, notes, styles };
}

export function parseSrt(text: string): { cues: Cue[]; malformed: number } {
  const cues: Cue[] = [];
  let malformed = 0;
  for (const b of text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    if (cues.length >= MAX_CUES) break;
    const lines = b.split("\n").filter((l) => l.length);
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) {
      malformed++;
      continue;
    }
    const m = /^\s*(\S+)\s*-->\s*(\S+)/.exec(lines[ti]);
    const start = m ? clockToSeconds(m[1]) : null;
    const end = m ? clockToSeconds(m[2]) : null;
    if (start === null || end === null || end < start) {
      malformed++;
      continue;
    }
    cues.push({ start, end, text: lines.slice(ti + 1).join("\n").replace(/<[^>]+>/g, "").trim() });
  }
  return { cues, malformed };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function emitCues(ctx: ExtractionContext, format: string, cues: Cue[], malformed: number, language: string | null, langMethod: string, kindLabel: string | null) {
  const o = { status: "observed" as const, method: `${format} cue parser` };
  ctx.add(C.structural, "subtitleFormat", format.toUpperCase(), o);
  ctx.add(C.structural, "cueCount", cues.length, o);
  if (malformed) ctx.add(C.quality, "malformedCues", malformed, { ...o, evidence: "blocks without a valid start --> end timing were skipped" });
  ctx.add(C.structural, "cues", cues.slice(0, OUT_CUES).map((c) => ({ start: round3(c.start), end: round3(c.end), text: c.text.slice(0, 200) })), { ...o, evidence: cues.length > OUT_CUES ? `first ${OUT_CUES} of ${cues.length}` : undefined });
  const span = cues.length ? round3(Math.max(...cues.map((c) => c.end)) - Math.min(...cues.map((c) => c.start))) : 0;
  ctx.add(C.structural, "timedTextSpanSeconds", span, o);
  if (language) ctx.add(C.descriptive, "language", language, { method: langMethod });
  const track = { format: format.toUpperCase(), language, kind: kindLabel, cueCount: cues.length, spanSeconds: span };
  ctx.add(C.video, "subtitleTracks", [track], o);
  ctx.add(C.accessibility, "captionTrack", track, { ...o, evidence: "a timed-text track exists; its accuracy and completeness are not assessed" });
  const text = cues.map((c) => c.text).join("\n");
  ctx.add(C.descriptive, "contentSummary", clean(text, 300), { status: "observed", method: "first cue text (verbatim)" });
  ctx.shared.set("contentText", text.slice(0, 200_000));
}

/** WebVTT / SubRip / TTML subtitles parsed into cues (start/end/text) + declared language. */
export const subtitleExtractor: Extractor = {
  id: "subtitles",
  version: "1.0.0",
  description: "Timed text (WebVTT, SRT, TTML): cue list with start/end/text, declared language and kind, malformed-cue count.",
  kinds: ["text", "xml"],
  formats: ["vtt", "srt", "ttml"],
  categories: [C.structural, C.accessibility, C.video, C.descriptive],
  timeoutMs: 3000,
  async run(ctx) {
    const text = (await ctx.text()).slice(0, MAX_TEXT);
    if (ctx.format === "vtt") {
      const v = parseVtt(text);
      emitCues(ctx, "vtt", v.cues, v.malformed, v.header.language ?? v.header.lang ?? null, "WebVTT header Language:", v.header.kind ?? null);
      if (v.notes) ctx.add(C.structural, "noteBlocks", v.notes, { status: "observed", method: "vtt NOTE blocks" });
      if (v.styles) ctx.add(C.structural, "styleBlocks", v.styles, { status: "observed", method: "vtt STYLE/REGION blocks" });
    } else if (ctx.format === "srt") {
      const s = parseSrt(text);
      emitCues(ctx, "srt", s.cues, s.malformed, null, "", null);
      ctx.add(C.descriptive, "languageDeclared", false, { status: "observed", method: "srt has no language field", evidence: "SubRip files carry no language declaration" });
    } else {
      const $ = await ctx.dom();
      const tt = $("tt, tt\\:tt").first();
      const lang = tt.attr("xml:lang") ?? null;
      const cues: Cue[] = [];
      let malformed = 0;
      $("p, tt\\:p").each((_, el) => {
        if (cues.length >= MAX_CUES) return false;
        const p = $(el);
        const start = ttmlTime(p.attr("begin"));
        const end = ttmlTime(p.attr("end")) ?? (start !== null && p.attr("dur") ? start + (ttmlTime(p.attr("dur")) ?? 0) : null);
        if (start === null || end === null) {
          malformed++;
          return;
        }
        p.find("br, tt\\:br").replaceWith("\n");
        cues.push({ start, end, text: p.text().trim() });
        return undefined;
      });
      emitCues(ctx, "ttml", cues, malformed, lang, "tt@xml:lang", null);
      const title = clean($("ttm\\:title, title").first().text());
      if (title) ctx.add(C.descriptive, "title", title, { method: "ttm:title" });
    }
  },
};

// ---------------------------------------------------------------- streaming manifests

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function isoDuration(s: string | undefined): number | null {
  const m = s && /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

function resolve(base: string, u: string): string {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

function hls(ctx: ExtractionContext, text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const o = { method: "HLS playlist tags (RFC 8216)" };
  const variants: Array<Record<string, unknown>> = [];
  const renditions: Array<Record<string, unknown>> = [];
  const keys = new Set<string>();
  let iframes = 0;
  let segments = 0;
  let total = 0;
  let target: number | null = null;
  let version: string | null = null;
  let playlistType: string | null = null;
  let endList = false;
  let pdt: string | null = null;
  for (let i = 0; i < lines.length && i < 200_000; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const a = attrs(l.slice(18));
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith("#")) ?? null;
      variants.push({ bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : null, averageBandwidth: a["AVERAGE-BANDWIDTH"] ? Number(a["AVERAGE-BANDWIDTH"]) : null, resolution: a.RESOLUTION ?? null, codecs: a.CODECS ?? null, frameRate: a["FRAME-RATE"] ? Number(a["FRAME-RATE"]) : null, audio: a.AUDIO ?? null, subtitles: a.SUBTITLES ?? null, uri: uri ? resolve(ctx.response.finalUrl, uri) : null });
    } else if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = attrs(l.slice(13));
      renditions.push({ type: a.TYPE ?? null, groupId: a["GROUP-ID"] ?? null, language: a.LANGUAGE ?? null, name: a.NAME ?? null, default: a.DEFAULT === "YES", autoselect: a.AUTOSELECT === "YES", forced: a.FORCED === "YES", characteristics: a.CHARACTERISTICS ?? null, instreamId: a["INSTREAM-ID"] ?? null, uri: a.URI ? resolve(ctx.response.finalUrl, a.URI) : null });
    } else if (l.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) iframes++;
    else if (l.startsWith("#EXTINF:")) {
      segments++;
      total += Number.parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith("#EXT-X-TARGETDURATION:")) target = Number(l.slice(22));
    else if (l.startsWith("#EXT-X-VERSION:")) version = l.slice(15);
    else if (l.startsWith("#EXT-X-PLAYLIST-TYPE:")) playlistType = l.slice(21);
    else if (l === "#EXT-X-ENDLIST") endList = true;
    else if (l.startsWith("#EXT-X-KEY:") || l.startsWith("#EXT-X-SESSION-KEY:")) {
      const a = attrs(l.slice(l.indexOf(":") + 1));
      if (a.METHOD && a.METHOD !== "NONE") keys.add(a.KEYFORMAT ? `${a.METHOD} (${a.KEYFORMAT})` : a.METHOD);
    } else if (l.startsWith("#EXT-X-PROGRAM-DATE-TIME:") && !pdt) pdt = l.slice(25);
  }
  const master = variants.length > 0 || renditions.length > 0;
  ctx.add(C.video, "streamingManifest", { protocol: "HLS", playlist: master ? "master" : "media", version, mediaDownloaded: false }, { status: "observed", method: "#EXTM3U tags", evidence: "manifest text only; no segment or variant was fetched" });
  if (master) {
    ctx.add(C.video, "variants", variants.slice(0, 100), o);
    ctx.add(C.structural, "variantCount", variants.length, { ...o, status: "observed" });
    ctx.add(C.video, "resolutions", [...new Set(variants.map((v) => v.resolution).filter(Boolean))], o);
    ctx.add(C.technical, "codecs", [...new Set(variants.flatMap((v) => String(v.codecs ?? "").split(",").map((c) => c.trim())).filter(Boolean))], o);
    const fr = variants.map((v) => v.frameRate).filter((x): x is number => typeof x === "number");
    if (fr.length) ctx.add(C.video, "frameRate", Math.max(...fr), o);
    ctx.add(C.video, "renditions", renditions.slice(0, 100), o);
    const subs = renditions.filter((r) => r.type === "SUBTITLES" || r.type === "CLOSED-CAPTIONS");
    ctx.add(C.video, "subtitleTracks", subs.map((s) => ({ type: s.type, language: s.language, name: s.name, forced: s.forced })), o);
    ctx.add(C.accessibility, "captionTracks", subs.length, { ...o, status: "observed", evidence: "declared rendition count; caption quality not assessed" });
    const audioLangs = renditions.filter((r) => r.type === "AUDIO").map((r) => r.language).filter(Boolean);
    if (audioLangs.length) ctx.add(C.audio, "languages", [...new Set(audioLangs)], o);
    const langs = [...new Set(renditions.map((r) => r.language).filter(Boolean))];
    if (langs.length) ctx.add(C.descriptive, "language", langs.join(", "), o);
    if (iframes) ctx.add(C.video, "iFramePlaylists", iframes, o);
  } else {
    ctx.add(C.structural, "segmentCount", segments, { ...o, status: "observed" });
    ctx.add(C.video, "targetDuration", target, o);
    if (segments) ctx.add(C.video, "duration", Math.round(total * 1000) / 1000, { ...o, evidence: "sum of #EXTINF durations declared by the playlist" });
    ctx.add(C.video, "liveOrVod", endList || playlistType === "VOD" ? "vod" : playlistType === "EVENT" ? "event" : "live", { ...o, evidence: endList ? "#EXT-X-ENDLIST present" : "no #EXT-X-ENDLIST" });
    const d = normalizeDate(pdt);
    if (d) ctx.add(C.temporal, "programDateTime", d.iso, { ...o, original: d.original });
  }
  if (keys.size) ctx.add(C.access_security, "encryption", [...keys], { ...o, evidence: "segments are encrypted; this system never fetches keys or decrypts" });
}

async function dash(ctx: ExtractionContext) {
  const $ = await ctx.dom();
  const mpd = $("MPD").first();
  const o = { method: "MPEG-DASH MPD (ISO/IEC 23009-1)" };
  const dur = isoDuration(mpd.attr("mediaPresentationDuration"));
  ctx.add(C.video, "streamingManifest", { protocol: "DASH", type: mpd.attr("type") ?? "static", profiles: mpd.attr("profiles") ?? null, minBufferTime: mpd.attr("minBufferTime") ?? null, mediaDownloaded: false }, { status: "observed", method: "<MPD> attributes", evidence: "manifest XML only; no segment was fetched" });
  if (dur !== null) ctx.add(C.video, "duration", dur, { ...o, original: mpd.attr("mediaPresentationDuration") });
  const ast = normalizeDate(mpd.attr("availabilityStartTime"));
  if (ast) ctx.add(C.temporal, "availabilityStart", ast.iso, { ...o, original: ast.original });
  const sets: Array<Record<string, unknown>> = [];
  const reps: Array<Record<string, unknown>> = [];
  const drm = new Set<string>();
  $("AdaptationSet").each((_, el) => {
    const a = $(el);
    const mime = a.attr("mimeType") ?? a.find("Representation").first().attr("mimeType") ?? null;
    const codecs = a.attr("codecs") ?? null;
    const contentType = a.attr("contentType") ?? (mime ? mime.split("/")[0] : null);
    const isText = contentType === "text" || /vtt|ttml/.test(mime ?? "") || /^(stpp|wvtt)/.test(codecs ?? a.find("Representation").first().attr("codecs") ?? "");
    a.find("ContentProtection").each((__, cp) => {
      drm.add($(cp).attr("schemeIdUri") ?? "unknown scheme");
    });
    const roles = a.find("Role").map((__, r) => $(r).attr("value")).get();
    sets.push({ contentType: isText ? "text" : contentType, mimeType: mime, lang: a.attr("lang") ?? null, codecs, roles, representations: a.find("Representation").length });
    a.find("Representation").each((__, r) => {
      if (reps.length >= 200) return;
      const rr = $(r);
      reps.push({ contentType: isText ? "text" : contentType, id: rr.attr("id") ?? null, bandwidth: rr.attr("bandwidth") ? Number(rr.attr("bandwidth")) : null, width: rr.attr("width") ? Number(rr.attr("width")) : null, height: rr.attr("height") ? Number(rr.attr("height")) : null, frameRate: rr.attr("frameRate") ?? a.attr("frameRate") ?? null, codecs: rr.attr("codecs") ?? codecs, audioSamplingRate: rr.attr("audioSamplingRate") ? Number(rr.attr("audioSamplingRate")) : null, lang: a.attr("lang") ?? null });
    });
  });
  ctx.add(C.structural, "periodCount", $("Period").length, { ...o, status: "observed" });
  ctx.add(C.structural, "adaptationSets", sets.slice(0, 100), o);
  ctx.add(C.video, "representations", reps, o);
  ctx.add(C.structural, "variantCount", reps.filter((r) => r.contentType === "video").length, { ...o, status: "observed" });
  ctx.add(C.video, "resolutions", [...new Set(reps.filter((r) => r.width && r.height).map((r) => `${r.width}x${r.height}`))], o);
  ctx.add(C.technical, "codecs", [...new Set(reps.map((r) => r.codecs).filter(Boolean))], o);
  const subs = sets.filter((s) => s.contentType === "text");
  ctx.add(C.video, "subtitleTracks", subs.map((s) => ({ language: s.lang, mimeType: s.mimeType, codecs: s.codecs, roles: s.roles })), o);
  ctx.add(C.accessibility, "captionTracks", subs.length, { ...o, status: "observed", evidence: "declared text adaptation sets; caption quality not assessed" });
  const langs = [...new Set(sets.map((s) => s.lang).filter(Boolean))];
  if (langs.length) ctx.add(C.descriptive, "language", langs.join(", "), o);
  const audioRates = reps.map((r) => r.audioSamplingRate).filter((x): x is number => typeof x === "number");
  if (audioRates.length) ctx.add(C.audio, "sampleRate", Math.max(...audioRates), o);
  if (drm.size) ctx.add(C.access_security, "encryption", [...drm], { ...o, evidence: "ContentProtection declared (DRM); this system never acquires licences or decrypts" });
  const title = clean($("ProgramInformation Title").first().text());
  if (title) ctx.add(C.descriptive, "title", title, { method: "ProgramInformation/Title" });
}

/** HLS (.m3u8) and MPEG-DASH (.mpd) manifests parsed as text — media is never downloaded. */
export const streamManifestExtractor: Extractor = {
  id: "stream-manifest",
  version: "1.0.0",
  description: "HLS master/media playlists and DASH MPDs: variants, codecs, resolutions, frame rates, audio/subtitle renditions, duration, live/VOD, encryption/DRM declarations.",
  kinds: ["text", "xml"],
  formats: ["hls", "dash"],
  categories: [C.video, C.audio, C.structural, C.technical, C.accessibility, C.access_security, C.descriptive, C.temporal],
  timeoutMs: 3000,
  async run(ctx) {
    if (ctx.format === "hls") hls(ctx, (await ctx.text()).slice(0, MAX_TEXT));
    else await dash(ctx);
  },
};
