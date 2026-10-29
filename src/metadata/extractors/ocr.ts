import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { clean, findIdentifiers } from "../normalize.js";
import { Semaphore } from "../../util/async.js";

const require = createRequire(import.meta.url);
type TWorker = { recognize(img: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };

let worker: Promise<TWorker> | null = null;
const slot = new Semaphore(1, 20);

/** One shared Tesseract worker, English model loaded from the bundled npm package (no network). */
function getWorker(): Promise<TWorker> {
  if (!worker) {
    worker = (async () => {
      const { createWorker } = await import("tesseract.js");
      const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
      // errorHandler keeps WASM aborts inside the worker from surfacing as process-level errors.
      return (await createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none", logger: () => undefined, errorHandler: () => undefined })) as unknown as TWorker;
    })();
    worker.catch(() => (worker = null));
  }
  return worker;
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
  if (worker) await (await worker).terminate().catch(() => undefined);
  worker = null;
}

/**
 * OCR for images, used only when needed: when the image carries no embedded
 * title/description and is a plausible size for legible text. Output is a
 * system measurement (not a source claim) and feeds search + identifiers.
 */
export const ocrExtractor: Extractor = {
  id: "ocr",
  version: "1.0.0",
  description: "Tesseract OCR (eng) for images without embedded descriptive text; bounded size, one job at a time, time-limited.",
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
    const result = await slot
      .run(async () => {
        try {
          return await (await getWorker()).recognize(body);
        } catch (err) {
          await shutdownOcr(); // a failed worker is discarded, never reused
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
    const m = { status: "observed" as const, method: "tesseract OCR (eng)", evidenceType: "system_measurement" as const };
    ctx.add(C.image, "ocrConfidence", Math.round(result.data.confidence), m);
    if (!words) {
      ctx.add(C.image, "ocrText", "", { ...m, evidence: "no legible text detected" });
      return;
    }
    ctx.add(C.image, "ocrText", clean(text, 2000), { ...m, evidence: `${words} words recognised; machine-read text may contain errors` });
    ctx.add(C.accessibility, "textInImage", true, { ...m, evidence: "image contains rendered text (an accessibility concern if no alt text accompanies it)" });
    ctx.shared.set("ocrText", text.slice(0, 20_000));
    const ids = findIdentifiers(text);
    ctx.add(C.identifiers, "doi", ids.doi, { ...m, method: "doi pattern in OCR text", status: "inferred", evidenceType: "inferred" });
    ctx.add(C.identifiers, "isbn", ids.isbn, { ...m, method: "isbn pattern + checksum in OCR text", status: "inferred", evidenceType: "inferred" });
  },
};
