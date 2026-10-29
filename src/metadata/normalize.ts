import type { ResourceKind } from "./types.js";

/** Normalise a date-ish string to ISO-8601 UTC; returns null when unparseable. */
export function normalizeDate(raw: unknown): { iso: string; original: string } | null {
  if (raw === null || raw === undefined) return null;
  let original = String(raw).trim();
  if (!original) return null;
  let s = original;
  // PDF dates: D:20230115123000+01'00'
  const pdf = s.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+-]\d{2}'?\d{2}'?)?/);
  if (pdf) {
    const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz] = pdf;
    let zone = "Z";
    if (tz && !/^z$/i.test(tz)) zone = tz.replace(/'/g, "").replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    s = `${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`;
  }
  // EXIF dates: 2021:06:30 14:22:01
  const exif = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (exif) s = `${exif[1]}-${exif[2]}-${exif[3]}T${exif[4]}Z`;
  // Compact: 20230115 or 20230115123000 (Wayback timestamps)
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/);
  if (compact) s = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] ?? "00"}:${compact[5] ?? "00"}:${compact[6] ?? "00"}Z`;
  // Date-only values: keep date semantic but anchor in UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
  if (/^\d{4}$/.test(s)) s = `${s}-01-01T00:00:00Z`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  if (year < 1000 || year > 2200) return null;
  if (original.length > 80) original = original.slice(0, 80);
  return { iso: new Date(t).toISOString(), original };
}

export function clean(s: unknown, max = 500): string | null {
  if (s === null || s === undefined) return null;
  const v = String(s).replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export function splitKeywords(s: string | null | undefined): string[] {
  if (!s) return [];
  return [...new Set(s.split(/[,;|]/).map((k) => k.trim()).filter((k) => k && k.length < 80))].slice(0, 50);
}

// ---------------------------------------------------------------- identifiers

export const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+[A-Za-z0-9])/g;
const ISBN_RE = /\bISBN(?:-1[03])?:?\s*((?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx])\b/g;
const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g;
const ISSN_RE = /\bISSN:?\s*(\d{4}-\d{3}[\dXx])\b/g;
const ARXIV_RE = /\barXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)\b/gi;

export function isbnValid(raw: string): boolean {
  const s = raw.replace(/[-\s]/g, "").toUpperCase();
  if (s.length === 10) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const c = s[i] === "X" ? 10 : Number(s[i]);
      if (Number.isNaN(c) || (s[i] === "X" && i !== 9)) return false;
      sum += c * (10 - i);
    }
    return sum % 11 === 0;
  }
  if (s.length === 13 && /^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
  }
  return false;
}

/** ORCID uses ISO 7064 MOD 11-2. */
export function orcidValid(raw: string): boolean {
  const s = raw.replace(/-/g, "");
  if (!/^\d{15}[\dX]$/.test(s)) return false;
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(s[i])) * 2;
  const check = (12 - (total % 11)) % 11;
  return (check === 10 ? "X" : String(check)) === s[15];
}

export function issnValid(raw: string): boolean {
  const s = raw.replace(/-/g, "").toUpperCase();
  if (!/^\d{7}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  return (check === 10 ? "X" : String(check)) === s[7];
}

export interface FoundIdentifiers {
  doi: string[];
  isbn: string[];
  orcid: string[];
  issn: string[];
  arxiv: string[];
}

export function findIdentifiers(text: string): FoundIdentifiers {
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 25);
  const all = (re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);
  return {
    doi: uniq(all(DOI_RE).map((d) => d.replace(/[.,;)]+$/, "").toLowerCase())),
    isbn: uniq(all(ISBN_RE).map((i) => i.replace(/[-\s]/g, "")).filter(isbnValid)),
    orcid: uniq(all(ORCID_RE).filter(orcidValid)),
    issn: uniq(all(ISSN_RE).filter(issnValid)),
    arxiv: uniq(all(ARXIV_RE)),
  };
}

// ---------------------------------------------------------------- privacy

const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(num: string): boolean {
  const d = num.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function maskEmail(e: string): string {
  const [local, domain] = e.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Count personal-data indicators without returning raw values (category 39). */
export function personalDataIndicators(text: string): {
  emails: number;
  phones: number;
  ssnLike: number;
  paymentCardLike: number;
  emailDomains: string[];
} {
  const emails = [...new Set(text.match(EMAIL_RE) ?? [])];
  return {
    emails: emails.length,
    phones: new Set(text.match(PHONE_RE) ?? []).size,
    ssnLike: new Set(text.match(SSN_RE) ?? []).size,
    paymentCardLike: new Set((text.match(CARD_RE) ?? []).filter(luhn)).size,
    emailDomains: [...new Set(emails.map((e) => e.split("@")[1].toLowerCase()))].slice(0, 10),
  };
}

// ---------------------------------------------------------------- sniffing

export function sniffKind(body: Buffer, contentType: string | null, url: string): { kind: ResourceKind; sniffed: string } {
  const b = body;
  const head = b.subarray(0, 16);
  const ascii = b.subarray(0, 512).toString("latin1");
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString("latin1") === s;
  if (at(0, "%PDF-")) return { kind: "pdf", sniffed: "application/pdf" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", sniffed: "image/jpeg" };
  if (at(0, "\x89PNG")) return { kind: "image", sniffed: "image/png" };
  if (at(0, "GIF8")) return { kind: "image", sniffed: "image/gif" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", sniffed: "image/webp" };
  if (at(0, "II*\x00") || at(0, "MM\x00*")) return { kind: "image", sniffed: "image/tiff" };
  if (at(4, "ftypheic") || at(4, "ftypheix") || at(4, "ftypmif1") || at(4, "ftypavif")) return { kind: "image", sniffed: at(4, "ftypavif") ? "image/avif" : "image/heic" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "audio", sniffed: "audio/wav" };
  if (at(0, "ID3") || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { kind: "audio", sniffed: "audio/mpeg" };
  if (at(0, "fLaC")) return { kind: "audio", sniffed: "audio/flac" };
  if (at(0, "OggS")) return { kind: /video/i.test(contentType ?? "") ? "video" : "audio", sniffed: "application/ogg" };
  if (at(4, "ftyp")) {
    const brand = b.subarray(8, 12).toString("latin1");
    const audio = /^M4A|^M4B|^M4P/.test(brand) || /audio/i.test(contentType ?? "");
    return { kind: audio ? "audio" : "video", sniffed: audio ? "audio/mp4" : "video/mp4" };
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: /audio/i.test(contentType ?? "") ? "audio" : "video", sniffed: "video/webm" };
  }
  if (at(0, "PK\x03\x04")) {
    const zipText = b.subarray(0, 4000).toString("latin1");
    if (/word\/|xl\/|ppt\/|\[Content_Types\]\.xml|mimetypeapplication\/vnd\.oasis/.test(zipText) || /\.(docx|xlsx|pptx|odt|ods|odp)(\?|$)/i.test(url)) {
      return { kind: "office", sniffed: "application/vnd.openxmlformats" };
    }
    return { kind: "archive", sniffed: "application/zip" };
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return { kind: "archive", sniffed: "application/gzip" };
  if (b.subarray(257, 262).toString("latin1") === "ustar") return { kind: "archive", sniffed: "application/x-tar" };

  const ct = (contentType ?? "").toLowerCase();
  const text = ascii.replace(/^﻿/, "").trimStart();
  if (/^(received|return-path|message-id|from|delivered-to|mime-version|x-[a-z-]+):/im.test(text.slice(0, 200)) && /\n(subject|from|date):/i.test(ascii) && !/<html/i.test(ascii)) {
    return { kind: "email", sniffed: "message/rfc822" };
  }
  if (ct.includes("message/rfc822") || /\.eml(\?|$)/i.test(url)) return { kind: "email", sniffed: "message/rfc822" };
  if (/^<(!doctype html|html|head|body|meta|title)/i.test(text) || ct.includes("html")) return { kind: "webpage", sniffed: "text/html" };
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(ascii) || /rss|atom/.test(ct)) {
    if (/<(rss|feed)[\s>]/i.test(ascii) || /<rdf:RDF[\s\S]*<item/i.test(ascii)) return { kind: "feed", sniffed: "application/rss+xml" };
  }
  if (text.startsWith("<?xml") || text.startsWith("<") || ct.includes("xml")) return { kind: "xml", sniffed: "application/xml" };
  if (text.startsWith("{") || text.startsWith("[") || ct.includes("json")) return { kind: "json", sniffed: "application/json" };
  if (ct.includes("csv") || /\.(csv|tsv)(\?|$)/i.test(url)) return { kind: "csv", sniffed: "text/csv" };
  if (ct.startsWith("image/")) return { kind: "image", sniffed: ct.split(";")[0] };
  if (ct.startsWith("audio/")) return { kind: "audio", sniffed: ct.split(";")[0] };
  if (ct.startsWith("video/")) return { kind: "video", sniffed: ct.split(";")[0] };
  // Printable ratio heuristic for plain text.
  const sample = b.subarray(0, 2048);
  let printable = 0;
  for (const byte of sample) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable++;
  if (sample.length === 0 || printable / sample.length > 0.95) return { kind: "text", sniffed: "text/plain" };
  return { kind: "binary", sniffed: "application/octet-stream" };
}

/** Decode a body using the declared/meta charset, falling back to UTF-8. */
export async function decodeBody(body: Buffer, contentType: string | null): Promise<{ text: string; charset: string }> {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase() ?? null;
  if (!charset) {
    const head = body.subarray(0, 2048).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ?? /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? "utf-8";
  }
  if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii") return { text: body.toString("utf8"), charset };
  try {
    const iconv = (await import("iconv-lite")).default;
    if (iconv.encodingExists(charset)) return { text: iconv.decode(body, charset), charset };
  } catch {
    /* fall through */
  }
  return { text: body.toString("utf8"), charset: `${charset} (unsupported; decoded as utf-8)` };
}
