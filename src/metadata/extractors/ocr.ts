import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { clean, findIdentifiers } from "../normalize.js";
import { Semaphore } from "../../util/async.js";
import { combinedLangPath, installedModels, routeOcr } from "../ocr-languages.js";

type TWorker = { recognize(img: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };

/** Workers keyed by model combination ("hin+eng"); at most MAX_WORKERS kept (least recently used is terminated). */
const workers = new Map<string, Promise<TWorker>>();
const MAX_WORKERS = Number(process.env.OCR_MAX_WORKERS ?? 2);
const slot = new Semaphore(1, 20);

function getWorker(models: string[]): Promise<TWorker> {
  const key = models.join("+");
  const hit = workers.get(key);
  if (hit) {
    workers.delete(key);
    workers.set(key, hit); // refresh LRU position
    return hit;
  }
  while (workers.size >= MAX_WORKERS) {
    const [oldKey, old] = workers.entries().next().value as [string, Promise<TWorker>];
    workers.delete(oldKey);
    void old.then((w) => w.terminate()).catch(() => undefined);
  }
  const w = (async () => {
    const { createWorker } = await import("tesseract.js");
    // Models come from npm packages @tesseract.js-data/<code> (no network); errorHandler keeps WASM aborts inside the worker.
    return (await createWorker(key, 1, { langPath: combinedLangPath(), gzip: true, cacheMethod: "none", logger: () => undefined, errorHandler: () => undefined })) as unknown as TWorker;
  })();
  w.catch(() => workers.delete(key));
  workers.set(key, w);
  return w;
}

/** Cheap structural decode check: PNG IDAT inflates; JPEG has SOF + SOS + entropy data. */
async function decodable(buf: Buffer): Promise<boolean> {
  if (buf.subarray(0, 4).toString("latin1") === "\x89PNG") {
    const { inflateSync } = await import("node:zlib");
    const parts: Buffer[] = [];
    let p = 8;
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.subarray(p + 4, p + 8).toString("latin1");
      if (type === "IDAT") parts.push(buf.subarray(p + 8, p + 8 + len));
      p += 12 + len;
    }
    try {
      return parts.length > 0 && inflateSync(Buffer.concat(parts), { maxOutputLength: 200 * 1024 * 1024 }).length > 0;
    } catch {
      return false;
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const sos = buf.indexOf(Buffer.from([0xff, 0xda]));
    const hasFrame = buf.includes(Buffer.from([0xff, 0xc0])) || buf.includes(Buffer.from([0xff, 0xc2]));
    return sos > 0 && buf.length - sos > 64 && hasFrame;
  }
  return true; // other formats: let Tesseract's own decoder decide (guarded by errorHandler)
}

export async function shutdownOcr(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map((w) => w.then((x) => x.terminate()).catch(() => undefined)));
}

/**
 * OCR for images, used only when needed: when the image carries no embedded
 * title/description and is a plausible size for legible text. Output is a
 * system measurement (not a source claim) and feeds search + identifiers.
 */
export const ocrExtractor: Extractor = {
  id: "ocr",
  version: "2.0.0",
  description: "Tesseract OCR routed by declared/hinted language & script to installed models (multilingual); honest ocr_model_unavailable when no model reads the script; bounded size, one job at a time, time-limited.",
  kinds: ["image"],
  categories: [C.image, C.descriptive, C.identifiers, C.accessibility],
  phase: "enrich",
  timeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 25_000),
  async run(ctx) {
    if (process.env.OCR_ENABLED === "off") return;
    const fields = ctx.fields();
    const width = Number(fields.find((f) => f.category === C.image && f.field === "width")?.value ?? 0);
    const height = Number(fields.find((f) => f.category === C.image && f.field === "height")?.value ?? 0);
    const hasText = fields.some((f) => f.category === C.descriptive && ["title", "description"].includes(f.field));
    const format = String(fields.find((f) => f.category === C.image && f.field === "format")?.value ?? "");
    const body = ctx.response.body;
    if (hasText) return; // embedded metadata already describes it — OCR not needed
    if (!["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp"].includes(format)) return;
    if (body.length > 4 * 1024 * 1024 || width < 64 || height < 24 || width * height > 16_000_000) return;
    // Only feed Tesseract images that genuinely decode; malformed pixel data aborts its WASM runtime.
    if (!(await decodable(body))) {
      ctx.add(C.image, "ocrSkipped", "pixel data could not be decoded", { status: "observed", method: "pre-OCR decode check" });
      return;
    }
    const declared = [
      ...fields.filter((f) => f.category === C.descriptive && f.field === "language" && typeof f.value === "string").map((f) => ({ tag: String(f.value).split(/[,;\s]/)[0], source: `embedded ${f.method}` })),
      ...(ctx.response.headers["content-language"] ? [{ tag: ctx.response.headers["content-language"].split(",")[0], source: "http Content-Language" }] : []),
      ...((ctx.shared.get("languageHints") as Array<{ tag: string; source: string }> | undefined) ?? []),
    ];
    const route = routeOcr({ languages: declared, url: ctx.sourceType === "url" ? ctx.response.finalUrl : undefined });
    const routeInfo = { status: route.status, models: route.models, language: route.language, script: route.script, languageSource: route.source, installedModels: [...installedModels().keys()], ...(route.note ? { note: route.note } : {}) };
    ctx.add(C.image, "ocrRouting", routeInfo, { status: route.status === "ok" ? "observed" : "unavailable", method: "OCR language/script routing", evidenceType: "system_measurement", evidence: route.note });
    if (route.status !== "ok") return;
    const result = await slot
      .run(async () => {
        try {
          return await (await getWorker(route.models)).recognize(body);
        } catch (err) {
          const key = route.models.join("+");
          const bad = workers.get(key);
          workers.delete(key); // a failed worker is discarded, never reused
          void bad?.then((w) => w.terminate()).catch(() => undefined);
          throw err;
        }
      })
      .catch((err: Error) => {
        if ((err as { code?: string }).code === "OVERLOADED") return null; // skip rather than queue unboundedly
        throw new Error(`OCR failed: ${String(err?.message ?? err)}`);
      });
    if (!result) return;
    const text = result.data.text.replace(/\s+/g, " ").trim();
    const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]{2,}/u.test(w)).length : 0;
    const m = { status: "observed" as const, method: `tesseract OCR (${route.models.join("+")})`, evidenceType: "system_measurement" as const };
    ctx.add(C.image, "ocrConfidence", Math.round(result.data.confidence), m);
    if (!words) {
      ctx.add(C.image, "ocrText", "", { ...m, evidence: "no legible text detected" });
      return;
    }
    ctx.add(C.image, "ocrText", clean(text, 2000), { ...m, evidence: `${words} words recognised with ${route.models.join("+")} (${route.script}); machine-read text may contain errors${result.data.confidence < 40 ? "; low confidence — the script may not match the model" : ""}` });
    ctx.add(C.accessibility, "textInImage", true, { ...m, evidence: "image contains rendered text (an accessibility concern if no alt text accompanies it)" });
    ctx.shared.set("ocrText", text.slice(0, 20_000));
    const ids = findIdentifiers(text);
    ctx.add(C.identifiers, "doi", ids.doi, { ...m, method: "doi pattern in OCR text", status: "inferred", evidenceType: "inferred" });
    ctx.add(C.identifiers, "isbn", ids.isbn, { ...m, method: "isbn pattern + checksum in OCR text", status: "inferred", evidenceType: "inferred" });
  },
};
