import * as F from "./build.js";
import type { SafeResponse } from "../../src/net/safe-fetch.js";

/** Named fixture corpus shared by the coverage test and scripts/coverage-matrix.ts. */
export async function fixtureCorpus(): Promise<Array<{ name: string; res: SafeResponse }>> {
  const h = (ct: string) => ({ "content-type": ct, "last-modified": "Tue, 01 Apr 2025 10:00:00 GMT", etag: '"v1"' });
  return [
    { name: "HTML (rich)", res: F.response(F.HTML_RICH, h("text/html; charset=utf-8"), "https://fixture.test/datasets/gtd-2025") },
    { name: "JSON Schema", res: F.response(F.JSON_SCHEMA, h("application/schema+json")) },
    { name: "OpenAPI", res: F.response(F.OPENAPI, h("application/json")) },
    { name: "Data Package", res: F.response(F.DATAPACKAGE, h("application/json")) },
    { name: "Model config.json", res: F.response(F.HF_CONFIG, h("application/json")) },
    { name: "CSV", res: F.response(F.CSV, h("text/csv")) },
    { name: "RSS feed", res: F.response(F.RSS, h("application/rss+xml")) },
    { name: "Sitemap", res: F.response(F.SITEMAP, h("application/xml")) },
    { name: "DataCite XML", res: F.response(F.DATACITE, h("application/xml")) },
    { name: "Model card (MD)", res: F.response(F.MODEL_CARD, h("text/markdown"), "https://fixture.test/README.md") },
    { name: "CITATION.cff", res: F.response(F.CITATION_CFF, h("text/plain")) },
    { name: "security.txt", res: F.response(F.SECURITY_TXT, h("text/plain")) },
    { name: "Email (.eml)", res: F.response(F.EML, h("message/rfc822"), "https://fixture.test/m.eml") },
    { name: "JPEG + EXIF", res: F.response(F.jpegWithExif(), h("image/jpeg"), "https://fixture.test/p.jpg") },
    { name: "WAV audio", res: F.response(F.wav(), h("audio/wav"), "https://fixture.test/a.wav") },
    { name: "MP4 video", res: F.response(F.mp4(), h("video/mp4"), "https://fixture.test/v.mp4") },
    { name: "PDF", res: F.response(await F.pdf(), h("application/pdf"), "https://fixture.test/r.pdf") },
    { name: "DOCX", res: F.response(F.docx(), h("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "https://fixture.test/p.docx") },
  ];
}
