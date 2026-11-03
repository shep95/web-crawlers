import * as cheerio from "cheerio";
import { C } from "../categories.js";
import type { Extractor } from "../extractor.js";
import { clean, isbnValid, normalizeDate } from "../normalize.js";
import { listZipEntries, readZipEntry } from "../zip.js";

const MAX_XML = 2 * 1024 * 1024;

/** EPUB 2/3: META-INF/container.xml → package document (OPF) Dublin Core metadata, manifest and spine. */
export const epubExtractor: Extractor = {
  id: "epub",
  version: "1.0.0",
  description: "EPUB: container.xml → OPF package metadata (title, creator, language, identifier, publisher, date, rights, subjects), manifest/spine counts, navigation, encryption/DRM marker.",
  kinds: ["archive"],
  formats: ["epub"],
  categories: [C.document, C.descriptive, C.identifiers, C.rights, C.temporal, C.structural, C.provenance, C.access_security, C.version, C.accessibility],
  timeoutMs: 3000,
  async run(ctx) {
    const buf = ctx.response.body;
    const entries = listZipEntries(buf, 5000);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const read = (name: string) => {
      const e = byName.get(name);
      return e ? readZipEntry(buf, e, MAX_XML).toString("utf8") : null;
    };
    const container = read("META-INF/container.xml");
    if (!container) {
      ctx.add(C.document, "epubContainer", "META-INF/container.xml missing", { status: "extraction_failed", method: "EPUB OCF container" });
      return;
    }
    const opfPath = /full-path\s*=\s*"([^"]+)"/.exec(container)?.[1];
    const opfText = opfPath ? read(opfPath) : null;
    if (!opfPath || !opfText) {
      ctx.add(C.document, "epubPackage", opfPath ? `package document ${opfPath} missing` : "no rootfile full-path in container.xml", { status: "extraction_failed", method: "EPUB OCF container" });
      return;
    }
    const $ = cheerio.load(opfText, { xml: { xmlMode: true, decodeEntities: true } });
    const pkg = $("package, opf\\:package").first();
    const dc = (tag: string) => $(`dc\\:${tag}`).map((_, el) => clean($(el).text(), 400)).get().filter(Boolean) as string[];
    const m = (k: string) => ({ method: `OPF dc:${k}` });
    const version = pkg.attr("version") ?? null;
    ctx.add(C.document, "format", `EPUB ${version ?? "?"}`, { status: "observed", method: "OPF package@version" });
    ctx.add(C.version, "epubVersion", version, { method: "OPF package@version" });
    const title = dc("title")[0] ?? null;
    ctx.add(C.document, "title", title, m("title"));
    ctx.add(C.descriptive, "title", title, m("title"));
    ctx.add(C.document, "author", dc("creator").join("; ") || null, m("creator"));
    ctx.add(C.descriptive, "author", dc("creator"), m("creator"));
    ctx.add(C.descriptive, "language", dc("language").join(", ") || null, m("language"));
    ctx.add(C.descriptive, "subject", dc("subject"), m("subject"));
    ctx.add(C.descriptive, "description", clean(dc("description")[0], 1000), m("description"));
    ctx.add(C.provenance, "publisher", dc("publisher")[0], m("publisher"));
    ctx.add(C.rights, "rightsStatement", dc("rights")[0], m("rights"));
    const ids = dc("identifier");
    ctx.add(C.identifiers, "identifier", ids, m("identifier"));
    const isbn = ids.map((i) => i.replace(/^(urn:)?isbn:/i, "").replace(/[-\s]/g, "")).filter((i) => /^\d{9}[\dX]$|^\d{13}$/i.test(i) && isbnValid(i));
    ctx.add(C.identifiers, "isbn", isbn, { method: "OPF dc:identifier + ISBN checksum" });
    const date = normalizeDate(dc("date")[0]);
    if (date) ctx.add(C.temporal, "published", date.iso, { ...m("date"), original: date.original });
    const modified = normalizeDate($('meta[property="dcterms:modified"]').first().text());
    if (modified) ctx.add(C.temporal, "modified", modified.iso, { method: "OPF meta dcterms:modified", original: modified.original });
    const manifest = $("manifest > item, opf\\:manifest > opf\\:item");
    const spine = $("spine > itemref, opf\\:spine > opf\\:itemref");
    const o = { status: "observed" as const, method: "OPF manifest/spine" };
    ctx.add(C.structural, "manifestItemCount", manifest.length, o);
    ctx.add(C.structural, "spineCount", spine.length, o);
    const media: Record<string, number> = {};
    manifest.each((_, el) => {
      const t = $(el).attr("media-type") ?? "?";
      media[t] = (media[t] ?? 0) + 1;
    });
    ctx.add(C.structural, "manifestMediaTypes", media, o);
    const nav = manifest.filter((_, el) => /\bnav\b/.test($(el).attr("properties") ?? "")).length > 0 || manifest.filter((_, el) => $(el).attr("media-type") === "application/x-dtbncx+xml").length > 0;
    ctx.add(C.accessibility, "navigationDocument", nav, { status: "observed", method: "OPF nav/ncx manifest item" });
    const a11y = $('meta[property^="schema:access"]').map((_, el) => `${$(el).attr("property")}=${$(el).text()}`).get();
    if (a11y.length) ctx.add(C.accessibility, "accessibilityMetadata", a11y.slice(0, 30), { method: "OPF schema:accessibility* meta" });
    if (byName.has("META-INF/encryption.xml")) {
      ctx.add(C.access_security, "encrypted", true, { status: "observed", method: "META-INF/encryption.xml present", evidence: "some resources are encrypted (font obfuscation or DRM); never decrypted" });
    }
    if (byName.has("META-INF/rights.xml")) ctx.add(C.access_security, "drmRightsFile", true, { status: "observed", method: "META-INF/rights.xml present" });
  },
};
