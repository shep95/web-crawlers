import { existsSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { iso6393 } from "iso-639-3";
import { countries } from "countries-list";

/**
 * OCR language routing. Tesseract models are recognisers for one language (and its
 * script); running the English model over Devanagari or Ethiopic text yields garbage,
 * so the model is chosen from the declared/detected language, and an honest
 * `ocr_model_unavailable` status is reported when no installed model covers the script.
 *
 * Models come only from npm packages `@tesseract.js-data/<code>` (no network at runtime).
 */
const require = createRequire(import.meta.url);

/** Tesseract model code → script it recognises (the subset of tessdata names we know how to route). */
export const TESSERACT_MODELS: Record<string, { script: string; iso6393: string[] }> = {
  eng: { script: "Latin", iso6393: ["eng"] }, fra: { script: "Latin", iso6393: ["fra"] }, spa: { script: "Latin", iso6393: ["spa"] }, deu: { script: "Latin", iso6393: ["deu"] }, por: { script: "Latin", iso6393: ["por"] },
  ita: { script: "Latin", iso6393: ["ita"] }, nld: { script: "Latin", iso6393: ["nld"] }, pol: { script: "Latin", iso6393: ["pol"] }, tur: { script: "Latin", iso6393: ["tur"] }, vie: { script: "Latin", iso6393: ["vie"] }, ind: { script: "Latin", iso6393: ["ind"] }, swa: { script: "Latin", iso6393: ["swa", "swh"] }, ron: { script: "Latin", iso6393: ["ron"] }, ces: { script: "Latin", iso6393: ["ces"] }, hun: { script: "Latin", iso6393: ["hun"] }, swe: { script: "Latin", iso6393: ["swe"] }, fin: { script: "Latin", iso6393: ["fin"] },
  rus: { script: "Cyrillic", iso6393: ["rus"] }, ukr: { script: "Cyrillic", iso6393: ["ukr"] }, bul: { script: "Cyrillic", iso6393: ["bul"] }, srp: { script: "Cyrillic", iso6393: ["srp"] },
  ell: { script: "Greek", iso6393: ["ell"] }, ara: { script: "Arabic", iso6393: ["ara", "arb"] }, fas: { script: "Arabic", iso6393: ["fas", "pes"] }, urd: { script: "Arabic", iso6393: ["urd"] }, heb: { script: "Hebrew", iso6393: ["heb"] },
  hin: { script: "Devanagari", iso6393: ["hin"] }, mar: { script: "Devanagari", iso6393: ["mar"] }, nep: { script: "Devanagari", iso6393: ["nep", "npi"] }, ben: { script: "Bengali", iso6393: ["ben"] }, tam: { script: "Tamil", iso6393: ["tam"] }, tel: { script: "Telugu", iso6393: ["tel"] }, kan: { script: "Kannada", iso6393: ["kan"] }, mal: { script: "Malayalam", iso6393: ["mal"] }, guj: { script: "Gujarati", iso6393: ["guj"] }, pan: { script: "Gurmukhi", iso6393: ["pan"] }, sin: { script: "Sinhala", iso6393: ["sin"] },
  tha: { script: "Thai", iso6393: ["tha"] }, lao: { script: "Lao", iso6393: ["lao"] }, khm: { script: "Khmer", iso6393: ["khm"] }, mya: { script: "Myanmar", iso6393: ["mya"] }, kat: { script: "Georgian", iso6393: ["kat"] }, hye: { script: "Armenian", iso6393: ["hye"] }, amh: { script: "Ethiopic", iso6393: ["amh"] }, tir: { script: "Ethiopic", iso6393: ["tir"] },
  chi_sim: { script: "Han (Simplified)", iso6393: ["zho", "cmn"] }, chi_tra: { script: "Han (Traditional)", iso6393: ["zho", "cmn", "yue"] }, jpn: { script: "Japanese", iso6393: ["jpn"] }, kor: { script: "Hangul", iso6393: ["kor"] },
};

/** Script of languages that have no dedicated model in the table above (so we can say what is missing). */
const SCRIPT_OF: Record<string, string> = {
  amh: "Ethiopic", tir: "Ethiopic", kat: "Georgian", hye: "Armenian", khm: "Khmer", lao: "Lao", mya: "Myanmar", sin: "Sinhala", tel: "Telugu", kan: "Kannada", mal: "Malayalam", guj: "Gujarati", pan: "Gurmukhi", tam: "Tamil", mar: "Devanagari", nep: "Devanagari", npi: "Devanagari",
  urd: "Arabic", fas: "Arabic", pes: "Arabic", pus: "Arabic", uig: "Arabic", kur: "Latin/Arabic", bel: "Cyrillic", kaz: "Cyrillic", kir: "Cyrillic", mkd: "Cyrillic", mon: "Cyrillic", tgk: "Cyrillic", tat: "Cyrillic", bak: "Cyrillic", yid: "Hebrew", div: "Thaana", bod: "Tibetan", dzo: "Tibetan", iku: "Canadian Syllabics", chr: "Cherokee", syr: "Syriac", yue: "Han (Traditional)",
};
const NON_LATIN = new Set(Object.values(TESSERACT_MODELS).map((m) => m.script).concat(Object.values(SCRIPT_OF)).filter((s) => s !== "Latin"));

const by1 = new Map(iso6393.filter((l) => l.iso6391).map((l) => [l.iso6391!, l.iso6393]));
const by2 = new Map(iso6393.flatMap((l) => [l.iso6392B, l.iso6392T].filter(Boolean).map((c) => [c!, l.iso6393] as const)));
const known3 = new Set(iso6393.map((l) => l.iso6393));

/** BCP-47-ish tag → ISO 639-3 (plus region for zh-TW style decisions). */
export function toIso6393(tag: string): { code: string; region: string | null } | null {
  const [lang, ...rest] = tag.trim().toLowerCase().replace(/_/g, "-").split("-");
  const region = rest.find((r) => /^[a-z]{2}$/.test(r) || r === "hant" || r === "hans") ?? null;
  if (lang.length === 2) return by1.has(lang) ? { code: by1.get(lang)!, region } : null;
  if (lang.length === 3) return known3.has(lang) ? { code: lang, region } : by2.has(lang) ? { code: by2.get(lang)!, region } : null;
  return null;
}

let installed: Map<string, string> | null = null;
/** Installed model code → directory containing `<code>.traineddata.gz` (LSTM best_int). */
export function installedModels(): Map<string, string> {
  if (installed) return installed;
  installed = new Map();
  for (const code of Object.keys(TESSERACT_MODELS)) {
    try {
      const dir = join(dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)), "4.0.0_best_int");
      if (existsSync(join(dir, `${code}.traineddata.gz`))) installed.set(code, dir);
    } catch {
      /* not installed */
    }
  }
  return installed;
}

/** One directory exposing every installed model (symlinks), so multi-language workers ("hin+eng") can load. */
export function combinedLangPath(): string {
  const dir = join(tmpdir(), "omnispider-tessdata");
  mkdirSync(dir, { recursive: true });
  const have = new Set(readdirSync(dir));
  for (const [code, src] of installedModels()) {
    const f = `${code}.traineddata.gz`;
    if (!have.has(f)) {
      try {
        symlinkSync(join(src, f), join(dir, f));
      } catch {
        /* concurrent creation */
      }
    }
  }
  return dir;
}

export interface OcrHints {
  /** Declared/detected language tags with where they came from. */
  languages?: Array<{ tag: string; source: string }>;
  url?: string;
}

export type OcrRoute =
  | { status: "ok"; models: string[]; language: string | null; script: string; source: string; note?: string }
  | { status: "ocr_model_unavailable"; models: []; language: string; script: string; source: string; note: string };

/** Language hints from the URL: path segment (/fr/, /pt-br/), lang= query, and ccTLD → the country's first listed language. */
export function urlLanguageHints(url: string | undefined): Array<{ tag: string; source: string }> {
  if (!url || !/^https?:/i.test(url)) return [];
  const out: Array<{ tag: string; source: string }> = [];
  try {
    const u = new URL(url);
    const q = u.searchParams.get("lang") ?? u.searchParams.get("hl") ?? u.searchParams.get("locale");
    if (q && toIso6393(q)) out.push({ tag: q, source: "url query lang" });
    const seg = u.pathname.split("/").find((s) => /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i.test(s) && toIso6393(s));
    if (seg) out.push({ tag: seg, source: "url path language segment" });
    const tld = u.hostname.split(".").pop()!.toUpperCase();
    const c = (countries as Record<string, { languages: string[] }>)[tld === "UK" ? "GB" : tld];
    if (c?.languages?.length) out.push({ tag: c.languages[0], source: `ccTLD .${tld.toLowerCase()} (country's first listed language; weak hint)` });
  } catch {
    /* not a URL */
  }
  return out;
}

/** Choose OCR model(s) for the strongest hint; never pretends an unsuitable model can read a script. */
export function routeOcr(hints: OcrHints, available = installedModels()): OcrRoute {
  const all = [...(hints.languages ?? []), ...urlLanguageHints(hints.url)];
  const fallback = available.has("eng") ? "eng" : [...available.keys()][0];
  for (const h of all) {
    const iso = toIso6393(h.tag);
    if (!iso) continue;
    const candidates = Object.entries(TESSERACT_MODELS).filter(([, m]) => m.iso6393.includes(iso.code));
    const traditional = iso.code === "zho" || iso.code === "cmn" || iso.code === "yue" ? ["tw", "hk", "mo", "hant"].includes(iso.region ?? "") || iso.code === "yue" : false;
    // Traditional Chinese is not read by the Simplified model (and vice versa): never substitute one for the other.
    const ordered = candidates.filter(([code]) => (code === "chi_tra" ? traditional || candidates.length === 1 : code === "chi_sim" ? !traditional : true));
    const model = ordered.find(([code]) => available.has(code));
    if (model) {
      const models = model[0] === "eng" || !available.has("eng") ? [model[0]] : [model[0], "eng"]; // eng second: mixed-script labels, numerals, URLs
      return { status: "ok", models, language: iso.code, script: model[1].script, source: h.source };
    }
    const script = ordered[0]?.[1].script ?? SCRIPT_OF[iso.code] ?? null;
    if (script && NON_LATIN.has(script)) {
      return { status: "ocr_model_unavailable", models: [], language: iso.code, script, source: h.source, note: `no installed Tesseract model reads ${script} script (language ${iso.code}); OCR not attempted rather than producing Latin-model garbage` };
    }
    // Latin-script language without its own model: a Latin model reads the letters (diacritics may be lost).
    if (fallback && (script === "Latin" || !script)) {
      return { status: "ok", models: [fallback], language: iso.code, script: script ?? "Latin (assumed)", source: h.source, note: `no dedicated model for ${iso.code}; Latin-script fallback model ${fallback} used — diacritics and language-specific words may be misread` };
    }
  }
  if (!fallback) return { status: "ocr_model_unavailable", models: [], language: "und", script: "unknown", source: "none", note: "no Tesseract model is installed" };
  return { status: "ok", models: [fallback], language: null, script: "Latin (assumed)", source: "none_declared", note: `no language declared or detectable before OCR; default model ${fallback} used — text in other scripts will not be read` };
}
