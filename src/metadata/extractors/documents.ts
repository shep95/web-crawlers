import { C } from "../categories.js";
import { listZipEntries, readZipEntry } from "../zip.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { clean, findIdentifiers, normalizeDate, splitKeywords } from "../normalize.js";

function xmpValue(xmp: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>|${tag}="([^"]*)"`, "i");
  const m = xmp.match(re);
  if (!m) return null;
  const inner = m[1] ?? m[2] ?? "";
  const li = inner.match(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i);
  return clean((li ? li[1] : inner).replace(/<[^>]+>/g, " "), 400);
}

function addDate(ctx: ExtractionContext, cat: number, field: string, raw: unknown, method: string) {
  const d = normalizeDate(raw instanceof Date ? raw.toISOString() : raw);
  if (d) ctx.add(cat, field, d.iso, { method, original: d.original });
}

export const pdfExtractor: Extractor = {
  id: "pdf",
  version: "1.0.0",
  description: "PDF Info dictionary, page count, version, encryption, XMP packet (incl. PDF/A), signature and tagging markers.",
  kinds: ["pdf"],
  categories: [C.document, C.descriptive, C.technical, C.temporal, C.provenance, C.preservation, C.integrity, C.access_security, C.structural, C.accessibility, C.rights, C.version],
  timeoutMs: 8000,
  async run(ctx) {
    const body = ctx.response.body;
    const latin = body.toString("latin1");
    const version = latin.slice(0, 16).match(/%PDF-(\d\.\d)/)?.[1];
    ctx.add(C.technical, "pdfVersion", version, { status: "observed", method: "pdf header" });
    const encrypted = /\/Encrypt\s/.test(latin);
    ctx.add(C.document, "encrypted", encrypted, { status: "observed", method: "/Encrypt in trailer" });
    ctx.add(C.access_security, "encrypted", encrypted, { status: "observed", method: "/Encrypt in trailer" });
    ctx.add(C.document, "linearized", /\/Linearized\s/.test(latin.slice(0, 2048)), { status: "observed", method: "/Linearized marker" });
    const signed = /\/Type\s*\/Sig\b/.test(latin) || /\/ByteRange\s*\[/.test(latin);
    ctx.add(C.integrity, "signed", signed, { status: "observed", method: "/Sig + /ByteRange markers", evidence: signed ? "signature dictionary present; signature validity NOT verified" : undefined });
    const tagged = /\/MarkInfo\s*<<[^>]*\/Marked\s+true/.test(latin);
    ctx.add(C.accessibility, "taggedPdf", tagged, { status: "observed", method: "/MarkInfo /Marked true" });
    const lang = latin.match(/\/Lang\s*\(([^)]{2,20})\)/)?.[1];
    ctx.add(C.accessibility, "documentLanguage", lang, { method: "/Lang catalog entry" });
    ctx.add(C.descriptive, "language", lang, { method: "/Lang catalog entry" });

    const xmpStart = latin.indexOf("<x:xmpmeta");
    if (xmpStart >= 0) {
      const xmp = latin.slice(xmpStart, latin.indexOf("</x:xmpmeta>", xmpStart) + 12 || xmpStart + 20000).slice(0, 40000);
      const part = xmpValue(xmp, "pdfaid:part");
      const conf = xmpValue(xmp, "pdfaid:conformance");
      if (part) ctx.add(C.preservation, "pdfaConformance", `PDF/A-${part}${(conf ?? "").toLowerCase()}`, { method: "xmp pdfaid" });
      ctx.add(C.rights, "rightsStatement", xmpValue(xmp, "dc:rights"), { method: "xmp dc:rights" });
      ctx.add(C.rights, "licenseUrl", xmpValue(xmp, "xmpRights:WebStatement"), { method: "xmp xmpRights:WebStatement" });
      ctx.add(C.provenance, "creatorTool", xmpValue(xmp, "xmp:CreatorTool"), { method: "xmp xmp:CreatorTool" });
      ctx.add(C.version, "documentId", xmpValue(xmp, "xmpMM:DocumentID"), { method: "xmp xmpMM:DocumentID" });
      ctx.add(C.version, "instanceId", xmpValue(xmp, "xmpMM:InstanceID"), { method: "xmp xmpMM:InstanceID" });
      ctx.add(C.descriptive, "title", xmpValue(xmp, "dc:title"), { method: "xmp dc:title" });
      ctx.add(C.descriptive, "description", xmpValue(xmp, "dc:description"), { method: "xmp dc:description" });
    }

    const { PDFDocument } = await import("pdf-lib");
    let doc: Awaited<ReturnType<typeof PDFDocument.load>>;
    try {
      doc = await PDFDocument.load(new Uint8Array(body), { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    } catch (err) {
      ctx.add(C.document, "parseError", (err as Error).message.slice(0, 200), { status: "extraction_failed", method: "pdf-lib load", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
      return;
    }
    let pages = 0;
    try {
      pages = doc.getPageCount();
    } catch {
      pages = 0;
    }
    if (!pages) {
      // pdf-lib tolerates garbage; a PDF with no page tree is a failed parse, not an empty document.
      ctx.add(C.document, "parseError", "no page tree found (malformed or truncated PDF)", { status: "extraction_failed", method: "pdf-lib page tree", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
      return;
    }
    ctx.add(C.document, "pageCount", pages, { status: "observed", method: "pdf-lib page tree" });
    ctx.add(C.structural, "pageCount", pages, { status: "observed", method: "pdf-lib page tree" });
    const first = pages ? doc.getPage(0).getSize() : null;
    if (first) ctx.add(C.technical, "pageSizePt", { width: Math.round(first.width), height: Math.round(first.height) }, { status: "observed", method: "page 1 MediaBox" });
    const info = (k: string) => {
      try {
        return clean((doc as unknown as Record<string, () => unknown>)[`get${k}`]?.call(doc));
      } catch {
        return null;
      }
    };
    const title = info("Title");
    const author = info("Author");
    ctx.add(C.document, "title", title, { method: "pdf Info /Title" });
    ctx.add(C.document, "author", author, { method: "pdf Info /Author" });
    ctx.add(C.document, "subject", info("Subject"), { method: "pdf Info /Subject" });
    ctx.add(C.document, "keywords", splitKeywords(info("Keywords")), { method: "pdf Info /Keywords" });
    ctx.add(C.document, "application", info("Creator"), { method: "pdf Info /Creator" });
    ctx.add(C.descriptive, "title", title, { method: "pdf Info /Title" });
    ctx.add(C.descriptive, "author", author ? [author] : [], { method: "pdf Info /Author" });
    ctx.add(C.descriptive, "subject", info("Subject") ? [info("Subject")!] : [], { method: "pdf Info /Subject" });
    ctx.add(C.provenance, "producer", info("Producer"), { method: "pdf Info /Producer" });
    ctx.add(C.provenance, "creatorTool", info("Creator"), { method: "pdf Info /Creator" });
    try {
      addDate(ctx, C.temporal, "created", doc.getCreationDate(), "pdf Info /CreationDate");
      addDate(ctx, C.temporal, "modified", doc.getModificationDate(), "pdf Info /ModDate");
    } catch {
      /* malformed dates */
    }

    // Embedded file attachments (/EmbeddedFiles name tree + /Filespec entries).
    const attachments = [...latin.matchAll(/\/Type\s*\/Filespec[^>]*?\/(?:UF|F)\s*\(([^)]{1,200})\)/g)].map((m) => m[1]);
    if (/\/EmbeddedFiles\b/.test(latin) || attachments.length) {
      ctx.add(C.document, "attachments", [...new Set(attachments)].slice(0, 50), { status: "observed", method: "/EmbeddedFiles + /Filespec", evidence: "attachment names only; contents not executed" });
      ctx.add(C.structural, "attachmentCount", new Set(attachments).size, { status: "observed", method: "/Filespec count" });
    }

    // Text layer (no OCR): identifiers, links and supporting references inside the document.
    if (encrypted) return;
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const proxy = await getDocumentProxy(new Uint8Array(body));
      const { text } = await extractText(proxy, { mergePages: true });
      const plain = (Array.isArray(text) ? text.join("\n") : text).replace(/\s+/g, " ").trim().slice(0, 400_000);
      ctx.shared.set("plainText", plain);
      ctx.add(C.document, "wordCount", plain ? plain.split(" ").length : 0, { status: "observed", method: "pdf text layer word count" });
      if (!plain && pages) ctx.add(C.accessibility, "textLayer", false, { status: "observed", method: "pdf text extraction", evidence: "no extractable text — likely scanned; OCR is not performed" });
      const ids = findIdentifiers(plain);
      ctx.add(C.identifiers, "doi", ids.doi, { method: "doi pattern in pdf text" });
      ctx.add(C.identifiers, "isbn", ids.isbn, { method: "isbn pattern + checksum in pdf text" });
      ctx.add(C.identifiers, "orcid", ids.orcid, { method: "orcid pattern + checksum in pdf text" });
      const urls = [...new Set(plain.match(/https?:\/\/[^\s)>\]"']+[^\s)>\]"'.,;]/g) ?? [])].slice(0, 200);
      ctx.shared.set("references", urls.map((u) => ({ url: u, text: "", rel: "", region: "main", tag: "pdf-text", type: null })));
      for (const d of ids.doi.slice(0, 30)) ctx.relate("references", `https://doi.org/${d}`, `DOI ${d} cited in document text`, "pdf text");
      const lic = plain.match(/(?:licensed under|license:|licence:)[^.]{0,120}\./i)?.[0];
      if (lic) ctx.add(C.rights, "rightsStatement", clean(lic, 200), { method: "licence sentence in pdf text" });
      const methods = plain.match(/\b(?:methodology|methods|sampling (?:design|frame|method)|data collection)\b[^.]{0,300}\./i)?.[0];
      if (methods) {
      ctx.add(C.statistical, "methodologyStatement", clean(methods, 400), { method: "methodology sentence in pdf text" });
      ctx.add(C.scientific, "method", clean(methods, 400), { method: "methodology sentence in pdf text" });
    }
      const sample = plain.match(/\b(?:n\s*=\s*|sample size of\s*)([\d,]{2,9})/i)?.[1];
      if (sample) ctx.add(C.statistical, "sampleSize", Number(sample.replace(/,/g, "")), { method: "sample size statement in pdf text", evidence: plain.match(/.{0,60}(?:n\s*=\s*|sample size of\s*)[\d,]{2,9}.{0,40}/i)?.[0] });
    } catch (err) {
      ctx.add(C.document, "textExtraction", (err as Error).message.slice(0, 160), { status: "extraction_failed", method: "unpdf text layer" });
    }
  },
};

const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024;

export const officeExtractor: Extractor = {
  id: "office",
  version: "1.0.0",
  description: "OOXML (docx/xlsx/pptx) and ODF core/app properties; zip entries are size-checked before inflation.",
  kinds: ["office"],
  categories: [C.document, C.descriptive, C.temporal, C.provenance, C.business, C.version, C.structural, C.administrative, C.integrity],
  timeoutMs: 5000,
  async run(ctx) {
    const wanted = new Set(["docProps/core.xml", "docProps/app.xml", "meta.xml", "[Content_Types].xml", "mimetype", "_xmlsignatures/origin.sigs"]);
    const body = ctx.response.body;
    const files: Record<string, Buffer> = {};
    let declaredTotal = 0;
    try {
      const entries = listZipEntries(body);
      for (const e of entries) {
        declaredTotal += e.uncompressedSize;
        if (wanted.has(e.name)) files[e.name] = readZipEntry(body, e, MAX_ENTRY_BYTES);
      }
      ctx.add(C.structural, "zipEntries", entries.length, { status: "observed", method: "zip central directory" });
    } catch (err) {
      ctx.add(C.document, "parseError", (err as Error).message.slice(0, 200), { status: "extraction_failed", method: "zip parse", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
      return;
    }
    if (declaredTotal > MAX_TOTAL_UNCOMPRESSED) {
      ctx.add(C.integrity, "decompressionRisk", true, { status: "observed", method: "zip central directory sizes", evidence: `declared uncompressed total ${declaredTotal} bytes; only metadata parts were inflated (capped)` });
    }
    const dec = (n: string) => (files[n] ? files[n].toString("utf8") : "");
    const tag = (xml: string, t: string) => clean(xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"))?.[1]?.replace(/<[^>]+>/g, " "), 400);
    const core = dec("docProps/core.xml") || dec("meta.xml");
    const app = dec("docProps/app.xml");
    const types = dec("[Content_Types].xml");
    const odfType = dec("mimetype");
    const format = odfType || (types.includes("wordprocessingml") ? "docx" : types.includes("spreadsheetml") ? "xlsx" : types.includes("presentationml") ? "pptx" : "ooxml");
    ctx.add(C.technical, "format", format, { status: "observed", method: "[Content_Types].xml / mimetype" });
    const title = tag(core, "dc:title");
    const creator = tag(core, "dc:creator") ?? tag(core, "meta:initial-creator");
    ctx.add(C.document, "title", title, { method: "core dc:title" });
    ctx.add(C.document, "author", creator, { method: "core dc:creator" });
    ctx.add(C.document, "subject", tag(core, "dc:subject"), { method: "core dc:subject" });
    ctx.add(C.document, "keywords", splitKeywords(tag(core, "cp:keywords") ?? tag(core, "meta:keyword")), { method: "core keywords" });
    ctx.add(C.document, "revision", tag(core, "cp:revision") ?? tag(core, "meta:editing-cycles"), { method: "core revision" });
    ctx.add(C.version, "revision", tag(core, "cp:revision") ?? tag(core, "meta:editing-cycles"), { method: "core revision" });
    ctx.add(C.document, "lastModifiedBy", tag(core, "cp:lastModifiedBy") ? "(present — name withheld)" : null, { method: "core cp:lastModifiedBy", masked: true, sensitivity: "personal" });
    ctx.add(C.descriptive, "title", title, { method: "core dc:title" });
    ctx.add(C.descriptive, "author", creator ? [creator] : [], { method: "core dc:creator" });
    ctx.add(C.descriptive, "description", tag(core, "dc:description"), { method: "core dc:description" });
    ctx.add(C.descriptive, "language", tag(core, "dc:language"), { method: "core dc:language" });
    addDate(ctx, C.temporal, "created", tag(core, "dcterms:created") ?? tag(core, "meta:creation-date"), "core created");
    addDate(ctx, C.temporal, "modified", tag(core, "dcterms:modified") ?? tag(core, "dc:date"), "core modified");
    ctx.add(C.document, "application", tag(app, "Application") ?? tag(core, "meta:generator"), { method: "app Application" });
    ctx.add(C.provenance, "creatorTool", tag(app, "Application") ?? tag(core, "meta:generator"), { method: "app Application" });
    ctx.add(C.business, "organization", tag(app, "Company"), { method: "app Company" });
    ctx.add(C.administrative, "company", tag(app, "Company"), { method: "app Company" });
    ctx.add(C.administrative, "manager", tag(app, "Manager") ? "(present — name withheld)" : null, { method: "app Manager", masked: true, sensitivity: "personal" });
    for (const [k, f] of [["Pages", "pageCount"], ["Words", "wordCount"], ["Slides", "slideCount"]] as const) {
      const v = tag(app, k);
      if (v) {
        ctx.add(C.document, f, Number(v), { method: `app ${k}` });
        ctx.add(C.structural, f, Number(v), { method: `app ${k}` });
      }
    }
    const odfStats = core.match(/<meta:document-statistic([^>]*)\/>/)?.[1];
    if (odfStats) {
      const pc = odfStats.match(/meta:page-count="(\d+)"/)?.[1];
      const wc = odfStats.match(/meta:word-count="(\d+)"/)?.[1];
      if (pc) ctx.add(C.document, "pageCount", Number(pc), { method: "meta:document-statistic" });
      if (wc) ctx.add(C.document, "wordCount", Number(wc), { method: "meta:document-statistic" });
    }
    ctx.add(C.integrity, "signed", Boolean(files["_xmlsignatures/origin.sigs"]), { status: "observed", method: "_xmlsignatures part", evidence: "signature validity NOT verified" });
  },
};
