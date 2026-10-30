import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { isType, ldString, ldStrings, ldTypes, ldUrl, type LdNode } from "../jsonld.js";
import { clean, findIdentifiers, normalizeDate, splitKeywords } from "../normalize.js";
import { mineResearchText } from "./research-text.js";

const CC_RE = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d\.\d)?/i;
const SPDX_HINT = /\b(MIT License|Apache License,? Version 2\.0|GNU General Public License|BSD \d-Clause|CC[- ]BY(?:[- ](?:SA|NC|ND))*[- ]\d\.\d|CC0)\b/i;
const RETENTION_RE = /[^.]{0,120}\b(?:retain(?:ed|s)?|retention|keep|stored?|delete[ds]?)\b[^.]{0,80}\b(\d{1,3})\s*(days?|months?|years?)\b[^.]{0,80}\./gi;

function abs(base: string, href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function dateField(ctx: ExtractionContext, category: number, field: string, raw: unknown, method: string) {
  const d = normalizeDate(raw);
  if (d) ctx.add(category, field, d.iso, { method, original: d.original, evidence: `${method}=${d.original}` });
}

function licenseLabel(url: string): string | null {
  const m = url.match(CC_RE);
  if (m) return m[1] === "publicdomain" ? `CC ${m[2].toUpperCase()}${m[3] ? ` ${m[3]}` : ""}` : `CC ${m[2].toUpperCase()} ${m[3] ?? ""}`.trim();
  if (/opensource\.org\/licenses?\/([\w.-]+)/i.test(url)) return url.match(/opensource\.org\/licenses?\/([\w.-]+)/i)![1];
  if (/gnu\.org\/licenses\/([\w.-]+)/i.test(url)) return url.match(/gnu\.org\/licenses\/([\w.-]+)/i)![1].toUpperCase();
  return null;
}

const BLOCKS = "address,article,aside,blockquote,br,caption,dd,div,dl,dt,figcaption,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,td,th,tr,ul";
/** Visible text with block boundaries kept as spaces (cheerio's .text() would fuse "Title</h1><p>Body" into "TitleBody"). */
function blockText(root: { find(sel: string): { append(content: string): unknown }; text(): string }): string {
  root.find(BLOCKS).append(" ");
  return root.text().replace(/\s+/g, " ").trim();
}

export const htmlExtractor: Extractor = {
  id: "html",
  version: "1.0.0",
  description: "HTML head/body metadata: meta tags, Open Graph, Twitter Cards, JSON-LD, microdata, RDFa, Dublin Core, Highwire citation tags, DOM structure, accessibility and form constraints.",
  kinds: ["webpage"],
  categories: [C.descriptive, C.structural, C.rights, C.provenance, C.temporal, C.spatial, C.identifiers, C.relational, C.semantic, C.constraints, C.business, C.usage, C.social_annotation, C.discovery, C.web_seo, C.social_sharing, C.scientific, C.accessibility, C.privacy, C.retention, C.integrity, C.access_security, C.version, C.statistical, C.lineage, C.administrative, C.device_sensor, C.ai_ml],
  timeoutMs: 4000,
  async run(ctx) {
    const $ = await ctx.dom();
    const base = abs(ctx.response.finalUrl, $("base[href]").attr("href")) ?? ctx.response.finalUrl;
    const meta = (sel: string) => clean($(sel).first().attr("content"), 1000);
    const metaAll = (sel: string) => $(sel).map((_, el) => clean($(el).attr("content"), 500)).get().filter(Boolean) as string[];
    const host = new URL(ctx.response.finalUrl).hostname;

    // ------------------------------------------------------------ descriptive
    const title = clean($("head > title").first().text() || $("title").first().text(), 500);
    const description = meta('meta[name="description" i]');
    ctx.add(C.descriptive, "title", title, { method: "html.title", evidence: `<title>${title ?? ""}</title>` });
    ctx.add(C.descriptive, "description", description, { method: "html.meta[name=description]" });
    const authors = metaAll('meta[name="author" i]');
    ctx.add(C.descriptive, "author", authors, { method: "html.meta[name=author]" });
    ctx.add(C.descriptive, "keywords", splitKeywords(meta('meta[name="keywords" i]')), { method: "html.meta[name=keywords]" });
    const lang = clean($("html").attr("lang"), 35);
    ctx.add(C.descriptive, "language", lang, { method: "html[lang]" });
    ctx.add(C.descriptive, "generator", meta('meta[name="generator" i]'), { method: "html.meta[name=generator]" });
    ctx.add(C.descriptive, "headline", clean($("h1").first().text(), 300), { method: "html.h1" });

    // Dublin Core (DC.* / DCTERMS.*)
    $('meta[name^="dc." i], meta[name^="dcterms." i], meta[property^="dc:" i]').each((_, el) => {
      const name = ($(el).attr("name") ?? $(el).attr("property") ?? "").toLowerCase().replace(/^(dc|dcterms)[.:]/, "");
      const content = clean($(el).attr("content"), 500);
      if (!content) return;
      const method = `html.meta[dublin-core:${name}]`;
      if (name === "title") ctx.add(C.descriptive, "title", content, { method });
      else if (name === "creator") ctx.add(C.descriptive, "author", [content], { method });
      else if (name === "subject") ctx.add(C.descriptive, "subject", splitKeywords(content), { method });
      else if (name === "description" || name === "abstract") ctx.add(C.descriptive, "description", content, { method });
      else if (name === "rights" || name === "license") ctx.add(C.rights, name === "license" ? "license" : "rightsStatement", content, { method });
      else if (name === "publisher") ctx.add(C.provenance, "publisher", content, { method });
      else if (name === "identifier") ctx.add(C.identifiers, "identifier", [content], { method });
      else if (name === "language") ctx.add(C.descriptive, "language", content, { method });
      else if (name === "date" || name === "issued" || name === "created") dateField(ctx, C.temporal, name === "created" ? "created" : "published", content, method);
      else if (name === "modified") dateField(ctx, C.temporal, "modified", content, method);
      else if (name === "coverage" || name === "spatial") ctx.add(C.spatial, "spatialCoverage", content, { method });
      else if (name === "source") ctx.add(C.lineage, "sources", [content], { method });
      else if (name === "relation" || name === "ispartof") ctx.add(C.relational, `dc:${name}`, content, { method });
      else if (name === "provenance") ctx.add(C.provenance, "custodyHistory", [content], { method });
      else if (name === "accessrights") ctx.add(C.access_security, "accessConditions", content, { method });
      else if (name === "accrualperiodicity") ctx.add(C.operational, "refreshSchedule", content, { method });
      else if (name === "conformsto") ctx.add(C.schema, "conformsTo", content, { method });
      else if (name === "temporal") ctx.add(C.temporal, "temporalCoverage", content, { method });
    });

    // ------------------------------------------------------------ JSON-LD
    const nodes = await ctx.jsonLd();
    const types = [...new Set(nodes.flatMap(ldTypes))];
    ctx.add(C.semantic, "types", types, { method: "json-ld @type" });
    ctx.add(C.web_seo, "structuredDataTypes", types, { method: "json-ld @type" });
    const ldContexts = ctx.shared.get("jsonld.contexts") as string[] | undefined;
    const microdataTypes = [...new Set($("[itemtype]").map((_, el) => $(el).attr("itemtype")).get())].slice(0, 30);
    ctx.add(C.semantic, "microdataTypes", microdataTypes, { method: "html[itemtype]" });
    const rdfa = [...new Set($("[vocab],[prefix],[typeof]").map((_, el) => $(el).attr("vocab") ?? $(el).attr("prefix") ?? $(el).attr("typeof")).get())].slice(0, 20);
    ctx.add(C.semantic, "rdfaVocab", rdfa, { method: "html[vocab|prefix|typeof]" });
    const vocabularies = new Set<string>(ldContexts ?? []);
    for (const t of microdataTypes) vocabularies.add(new URL(t, "https://x/").origin);
    if ($('meta[name^="dc." i], meta[name^="dcterms." i]').length) vocabularies.add("http://purl.org/dc/terms/");
    if ($('meta[property^="og:"]').length) vocabularies.add("https://ogp.me/ns#");
    ctx.add(C.semantic, "vocabularies", [...vocabularies].slice(0, 20), { method: "json-ld @context / microdata / meta prefixes" });

    for (const node of nodes.slice(0, 60)) {
      const t = ldTypes(node).join(",");
      const m = (prop: string) => `json-ld ${t}.${prop}`;
      const primary = isType(node, "Article", "NewsArticle", "BlogPosting", "ScholarlyArticle", "WebPage", "Dataset", "CreativeWork", "Book", "Report", "TechArticle", "Product", "SoftwareApplication", "SoftwareSourceCode", "VideoObject", "AudioObject", "ImageObject", "Course", "Event", "Recipe", "MedicalWebPage", "Thesis", "Collection", "DataCatalog");
      if (primary) {
        ctx.add(C.descriptive, "title", clean(ldString(node.headline ?? node.name), 500), { method: m("headline|name") });
        ctx.add(C.descriptive, "description", clean(ldString(node.description ?? node.abstract), 1000), { method: m("description") });
        ctx.add(C.descriptive, "author", ldStrings(node.author ?? node.creator), { method: m("author") });
        const kw = node.keywords;
        ctx.add(C.descriptive, "keywords", typeof kw === "string" ? splitKeywords(kw) : ldStrings(kw, 40), { method: m("keywords") });
        ctx.add(C.descriptive, "subject", ldStrings(node.about ?? node.genre ?? node.articleSection, 20), { method: m("about|genre|articleSection") });
        ctx.add(C.descriptive, "language", ldString(node.inLanguage), { method: m("inLanguage") });
        dateField(ctx, C.temporal, "published", node.datePublished, m("datePublished"));
        dateField(ctx, C.temporal, "modified", node.dateModified, m("dateModified"));
        dateField(ctx, C.temporal, "created", node.dateCreated, m("dateCreated"));
        dateField(ctx, C.retention, "expires", node.expires, m("expires"));
        ctx.add(C.temporal, "temporalCoverage", ldString(node.temporalCoverage), { method: m("temporalCoverage") });
        const publisher = ldString(node.publisher ?? node.sourceOrganization);
        ctx.add(C.provenance, "publisher", publisher, { method: m("publisher") });
        const license = ldUrl(node.license) ?? ldString(node.license);
        if (license) {
          ctx.add(C.rights, "license", licenseLabel(license) ?? license, { method: m("license"), evidence: license });
          if (/^https?:/.test(license)) ctx.relate("licensed_under", license, `json-ld license`, m("license"));
        }
        ctx.add(C.rights, "copyrightHolder", ldString(node.copyrightHolder), { method: m("copyrightHolder") });
        if (node.copyrightYear) ctx.add(C.rights, "copyright", `© ${ldString(node.copyrightYear)} ${ldString(node.copyrightHolder) ?? ""}`.trim(), { method: m("copyrightYear") });
        if (typeof node.isAccessibleForFree === "boolean" || typeof node.isAccessibleForFree === "string") {
          ctx.add(C.access_security, "isAccessibleForFree", String(node.isAccessibleForFree).toLowerCase() === "true", { method: m("isAccessibleForFree") });
        }
        ctx.add(C.version, "version", ldString(node.version), { method: m("version") });
        ctx.add(C.descriptive, "alternativeTitle", clean(ldString(node.alternativeHeadline ?? node.alternateName), 300), { method: m("alternativeHeadline|alternateName") });
        ctx.add(C.access_security, "accessConditions", clean(ldString(node.conditionsOfAccess), 400), { method: m("conditionsOfAccess") });
        ctx.add(C.rights, "reuseConditions", clean(ldString(node.usageInfo), 400), { method: m("usageInfo") });
        ctx.add(C.rights, "attributionRequirement", clean(ldString(node.creditText), 300), { method: m("creditText") });
        ctx.add(C.rights, "acquireLicensePage", ldUrl(node.acquireLicensePage), { method: m("acquireLicensePage") });
        ctx.add(C.business, "funder", ldStrings(node.funder ?? node.funding, 10), { method: m("funder|funding"), scope: "organization" });
        ctx.add(C.provenance, "sdPublisher", ldString(node.sdPublisher), { method: m("sdPublisher"), evidence: "publisher of the structured data itself (may differ from the content publisher)" });
        ctx.add(C.file_system, "contentSize", ldString(node.contentSize), { method: m("contentSize") });
        ctx.add(C.technical, "encodingFormat", ldString(node.encodingFormat), { method: m("encodingFormat") });
        ctx.add(C.accessibility, "transcriptAvailable", node.transcript ? true : null, { method: m("transcript"), evidence: "declared transcript; quality not assessed" });
        dateField(ctx, C.temporal, "uploaded", node.uploadDate, m("uploadDate"));
        ctx.add(C.video, "declaredDuration", ldString(node.duration), { method: m("duration"), evidence: "ISO 8601 duration declared by the page (not measured from the file)" });
        ctx.add(C.version, "softwareVersion", ldString(node.softwareVersion), { method: m("softwareVersion") });
        for (const id of ldStrings(node.identifier, 10)) ctx.add(C.identifiers, "identifier", [id], { method: m("identifier") });
        for (const s of ldStrings(node.sameAs, 20)) if (/^https?:/.test(s)) ctx.relate("same_as", s, "json-ld sameAs", m("sameAs"));
        for (const s of ldStrings(node.isPartOf, 5)) ctx.relate("part_of", s, "json-ld isPartOf", m("isPartOf"));
        for (const s of ldStrings(node.hasPart, 20)) ctx.relate("has_part", s, "json-ld hasPart", m("hasPart"));
        for (const s of ldStrings(node.citation, 50)) ctx.relate("cites", s, "json-ld citation", m("citation"));
        const basedOn = ldStrings(node.isBasedOn ?? node.isBasedOnUrl, 20);
        ctx.add(C.lineage, "derivedFrom", basedOn, { method: m("isBasedOn") });
        for (const s of basedOn) ctx.relate("derived_from", s, "json-ld isBasedOn", m("isBasedOn"));
        // Accessibility declarations
        ctx.add(C.accessibility, "accessibilityFeatures", ldStrings(node.accessibilityFeature, 20), { method: m("accessibilityFeature") });
        ctx.add(C.accessibility, "accessibilityHazards", ldStrings(node.accessibilityHazard, 10), { method: m("accessibilityHazard") });
        ctx.add(C.accessibility, "accessibilitySummary", clean(ldString(node.accessibilitySummary), 500), { method: m("accessibilitySummary") });
        // Social / usage
        const rating = node.aggregateRating as LdNode | undefined;
        if (rating && typeof rating === "object") {
          ctx.add(C.social_annotation, "rating", { value: Number(ldString(rating.ratingValue)), count: Number(ldString(rating.ratingCount ?? rating.reviewCount)) || null, best: Number(ldString(rating.bestRating)) || null }, { method: m("aggregateRating") });
        }
        if (node.commentCount !== undefined) ctx.add(C.social_annotation, "commentCount", Number(ldString(node.commentCount)), { method: m("commentCount") });
        const stats = (Array.isArray(node.interactionStatistic) ? node.interactionStatistic : node.interactionStatistic ? [node.interactionStatistic] : []) as LdNode[];
        const counts = stats.map((s) => ({ type: ldString(s.interactionType)?.replace(/^.*[/#]/, "") ?? "unknown", count: Number(ldString(s.userInteractionCount)) })).filter((s) => Number.isFinite(s.count));
        ctx.add(C.usage, "interactionCounts", counts, { method: m("interactionStatistic"), evidence: "public counters declared by the page" });
        // Dataset-specific
        if (isType(node, "Dataset", "DataCatalog")) {
          ctx.add(C.spatial, "spatialCoverage", ldString(node.spatialCoverage), { method: m("spatialCoverage") });
          const vm = (Array.isArray(node.variableMeasured) ? node.variableMeasured : node.variableMeasured ? [node.variableMeasured] : []) as unknown[];
          const pv = vm.filter((v): v is LdNode => Boolean(v) && typeof v === "object");
          ctx.add(C.semantic, "units", pv.filter((v) => v.unitText || v.unitCode).map((v) => ({ variable: ldString(v.name), unit: ldString(v.unitText ?? v.unitCode) })), { method: m("variableMeasured.unitText|unitCode") });
          ctx.add(C.semantic, "fieldDescriptions", pv.filter((v) => v.description).map((v) => ({ field: ldString(v.name), description: clean(ldString(v.description), 200) })), { method: m("variableMeasured.description") });
          const sc = node.spatialCoverage as LdNode | undefined;
          const box = sc && typeof sc === "object" ? ldString((sc.geo as LdNode | undefined)?.box) : null;
          if (box) {
            const [s1, w1, n1, e1] = box.split(/[\s,]+/).map(Number);
            if ([s1, w1, n1, e1].every(Number.isFinite)) ctx.add(C.spatial, "boundingBox", { south: s1, west: w1, north: n1, east: e1 }, { method: m("spatialCoverage.geo.box") });
          }
          ctx.add(C.technical, "distributionFormats", [...new Set(((Array.isArray(node.distribution) ? node.distribution : node.distribution ? [node.distribution] : []) as LdNode[]).map((dd) => ldString(dd.encodingFormat)).filter(Boolean))], { method: m("distribution.encodingFormat") });
          const variables = ldStrings(node.variableMeasured, 50);
          ctx.add(C.statistical, "variables", variables, { method: m("variableMeasured") });
          ctx.add(C.statistical, "measurementTechnique", ldString(node.measurementTechnique), { method: m("measurementTechnique") });
          ctx.add(C.device_sensor, "instrument", ldString(node.instrument ?? node.measurementTechnique), { method: m("instrument|measurementTechnique") });
          ctx.add(C.administrative, "maintainer", ldString(node.maintainer ?? node.creator), { method: m("maintainer|creator") });
          const dist = (Array.isArray(node.distribution) ? node.distribution : node.distribution ? [node.distribution] : []) as LdNode[];
          for (const d of dist.slice(0, 20)) {
            const u = ldUrl(d.contentUrl ?? d.url);
            if (u) ctx.relate("alternate_format", u, `distribution ${ldString(d.encodingFormat) ?? ""}`.trim(), m("distribution"));
          }
          ctx.add(C.scientific, "datasetCitation", ldStrings(node.citation, 10), { method: m("citation") });
        }
        if (isType(node, "ScholarlyArticle")) {
          ctx.add(C.scientific, "authors", ldStrings(node.author, 50), { method: m("author") });
          ctx.add(C.scientific, "journal", ldString((node.isPartOf as LdNode | undefined)?.name ?? node.isPartOf), { method: m("isPartOf") });
        }
        if (isType(node, "SoftwareApplication", "SoftwareSourceCode")) {
          ctx.add(C.technical, "softwareRequirements", ldStrings(node.softwareRequirements ?? node.operatingSystem, 10), { method: m("softwareRequirements|operatingSystem") });
          ctx.add(C.technical, "programmingLanguage", ldStrings(node.programmingLanguage, 10), { method: m("programmingLanguage") });
        }
        const loc = (node.contentLocation ?? node.locationCreated ?? node.spatialCoverage) as LdNode | undefined;
        const geo = (loc && typeof loc === "object" ? (loc.geo as LdNode | undefined) : undefined) ?? (node.geo as LdNode | undefined);
        if (geo && geo.latitude !== undefined && geo.longitude !== undefined) {
          ctx.add(C.spatial, "coordinates", { lat: Number(geo.latitude), lon: Number(geo.longitude) }, { method: m("geo") });
        }
        if (loc && typeof loc === "object") ctx.add(C.spatial, "placename", ldString(loc), { method: m("contentLocation") });
      }
      if (isType(node, "Organization", "Corporation", "NGO", "GovernmentOrganization", "EducationalOrganization", "LocalBusiness", "NewsMediaOrganization")) {
        ctx.add(C.business, "organization", ldString(node.name), { method: m("name"), scope: "organization" });
        ctx.add(C.business, "legalName", ldString(node.legalName), { method: m("legalName"), scope: "organization" });
        ctx.add(C.business, "lei", ldString(node.leiCode), { method: m("leiCode"), scope: "organization" });
        ctx.add(C.business, "duns", ldString(node.duns), { method: m("duns"), scope: "organization" });
        ctx.add(C.business, "taxId", ldString(node.taxID ?? node.vatID), { method: m("taxID|vatID"), scope: "organization" });
        ctx.add(C.business, "industry", ldString(node.naics ?? node.isicV4), { method: m("naics|isicV4"), scope: "organization" });
        for (const s of ldStrings(node.sameAs, 20)) if (/^https?:/.test(s)) ctx.relate("same_as", s, `organization ${ldString(node.name) ?? ""} sameAs`, m("sameAs"));
        const logo = ldUrl(node.logo);
        if (logo) ctx.add(C.business, "logo", logo, { method: m("logo"), scope: "organization" });
      }
      if (isType(node, "Product", "Offer")) {
        const ids = ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn", "sku", "isbn"].map((k) => (node[k] ? `${k}:${ldString(node[k])}` : null)).filter(Boolean);
        ctx.add(C.business, "productIds", ids, { method: m("gtin|mpn|sku") });
        ctx.add(C.business, "brand", ldString(node.brand), { method: m("brand") });
      }
      if (isType(node, "BreadcrumbList")) {
        const items = ((node.itemListElement as LdNode[]) ?? []).map((i) => ldString(i.name ?? i.item)).filter(Boolean);
        ctx.add(C.structural, "breadcrumbs", items, { method: m("itemListElement") });
      }
    }

    // ------------------------------------------------------------ Highwire / scholarly
    const citeTitle = meta('meta[name="citation_title"]');
    if (citeTitle) {
      ctx.add(C.scientific, "citationTitle", citeTitle, { method: "html.meta[citation_title]" });
      ctx.add(C.scientific, "authors", metaAll('meta[name="citation_author"]').slice(0, 100), { method: "html.meta[citation_author]" });
      ctx.add(C.scientific, "journal", meta('meta[name="citation_journal_title"]') ?? meta('meta[name="citation_conference_title"]'), { method: "html.meta[citation_journal_title]" });
      ctx.add(C.scientific, "volume", meta('meta[name="citation_volume"]'), { method: "html.meta[citation_volume]" });
      ctx.add(C.scientific, "issue", meta('meta[name="citation_issue"]'), { method: "html.meta[citation_issue]" });
      const fp = meta('meta[name="citation_firstpage"]');
      const lp = meta('meta[name="citation_lastpage"]');
      if (fp) ctx.add(C.scientific, "pages", lp ? `${fp}-${lp}` : fp, { method: "html.meta[citation_firstpage/lastpage]" });
      dateField(ctx, C.scientific, "publicationDate", meta('meta[name="citation_publication_date"]') ?? meta('meta[name="citation_date"]'), "html.meta[citation_publication_date]");
      ctx.add(C.provenance, "publisher", meta('meta[name="citation_publisher"]'), { method: "html.meta[citation_publisher]" });
      const pdf = abs(base, meta('meta[name="citation_pdf_url"]') ?? undefined);
      if (pdf) ctx.relate("alternate_format", pdf, "citation_pdf_url", "html.meta[citation_pdf_url]");
      for (const ref of metaAll('meta[name="citation_reference"]').slice(0, 100)) ctx.relate("cites", ref, "citation_reference", "html.meta[citation_reference]");
    }
    const citeDoi = meta('meta[name="citation_doi"]') ?? meta('meta[name="dc.identifier" i][content^="10."]') ?? meta('meta[name="prism.doi"]');
    if (citeDoi) ctx.add(C.identifiers, "doi", [citeDoi.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, "").toLowerCase()], { method: "html.meta[citation_doi]" });
    const isbnMeta = metaAll('meta[name="citation_isbn"]');
    if (isbnMeta.length) ctx.add(C.identifiers, "isbn", isbnMeta, { method: "html.meta[citation_isbn]" });
    const issnMeta = metaAll('meta[name="citation_issn"]');
    if (issnMeta.length) ctx.add(C.identifiers, "issn", issnMeta, { method: "html.meta[citation_issn]" });
    const arxivId = meta('meta[name="citation_arxiv_id"]');
    if (arxivId) ctx.add(C.identifiers, "arxiv", [arxivId], { method: "html.meta[citation_arxiv_id]" });

    // ------------------------------------------------------------ Open Graph / Twitter
    const og: Record<string, string> = {};
    $('meta[property^="og:"], meta[name^="og:"]').each((_, el) => {
      const k = ($(el).attr("property") ?? $(el).attr("name") ?? "").slice(3);
      const v = clean($(el).attr("content"), 500);
      if (k && v && !(k in og)) og[k] = v;
    });
    ctx.add(C.social_sharing, "openGraph", og, { method: "html.meta[og:*]" });
    const tw: Record<string, string> = {};
    $('meta[name^="twitter:"], meta[property^="twitter:"]').each((_, el) => {
      const k = ($(el).attr("name") ?? $(el).attr("property") ?? "").slice(8);
      const v = clean($(el).attr("content"), 500);
      if (k && v && !(k in tw)) tw[k] = v;
    });
    ctx.add(C.social_sharing, "twitterCard", tw, { method: "html.meta[twitter:*]" });
    const previewImage = abs(base, og.image ?? tw.image);
    ctx.add(C.social_sharing, "previewImage", previewImage, { method: og.image ? "og:image" : "twitter:image" });
    if (og.title) ctx.add(C.descriptive, "title", og.title, { method: "html.meta[og:title]" });
    // The site's own icon, largest declared first; /favicon.ico is the conventional fallback location.
    const icons = $('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="apple-touch-icon"]')
      .map((_, el) => ({ href: abs(base, $(el).attr("href")), size: Number(String($(el).attr("sizes") ?? "").split(/[x\s]/)[0]) || (($(el).attr("rel") ?? "").includes("apple") ? 180 : 0) }))
      .get()
      .filter((i: { href: string | null }) => i.href && /^https?:/.test(i.href))
      .sort((a: { size: number }, b: { size: number }) => b.size - a.size);
    if (icons.length) ctx.add(C.social_sharing, "siteIcon", icons[0].href, { method: "html.link[rel=icon]" });
    if (og.description) ctx.add(C.descriptive, "description", og.description, { method: "html.meta[og:description]" });
    if (og.site_name) ctx.add(C.provenance, "siteName", og.site_name, { method: "html.meta[og:site_name]" });
    dateField(ctx, C.temporal, "published", meta('meta[property="article:published_time"]'), "html.meta[article:published_time]");
    dateField(ctx, C.temporal, "modified", meta('meta[property="article:modified_time"]') ?? og.updated_time, "html.meta[article:modified_time]");
    dateField(ctx, C.temporal, "expires", meta('meta[property="article:expiration_time"]'), "html.meta[article:expiration_time]");
    const articleTags = metaAll('meta[property="article:tag"]');
    ctx.add(C.social_annotation, "tags", articleTags, { method: "html.meta[article:tag]" });
    const relTags = $('a[rel~="tag"]').map((_, el) => clean($(el).text(), 60)).get().filter(Boolean).slice(0, 40);
    ctx.add(C.social_annotation, "tags", relTags, { method: "a[rel=tag]" });
    const timeEls = $("time[datetime]").map((_, el) => $(el).attr("datetime")).get().slice(0, 5);
    if (timeEls.length) dateField(ctx, C.temporal, "firstTimeElement", timeEls[0], "html.time[datetime]");

    // ------------------------------------------------------------ SEO / discovery
    const canonical = abs(base, $('link[rel="canonical" i]').attr("href"));
    if (canonical) {
      ctx.add(C.web_seo, "canonical", canonical, { method: "link[rel=canonical]" });
      ctx.add(C.identifiers, "canonicalUrl", canonical, { method: "link[rel=canonical]" });
      ctx.relate("canonical", canonical, "link rel=canonical", "link[rel=canonical]");
    }
    if (title) ctx.add(C.web_seo, "titleLength", title.length, { status: "observed", method: "len(title)" });
    if (description) ctx.add(C.web_seo, "descriptionLength", description.length, { status: "observed", method: "len(meta description)" });
    ctx.add(C.web_seo, "viewport", meta('meta[name="viewport" i]'), { method: "html.meta[viewport]" });
    ctx.add(C.web_seo, "charsetDeclared", $("meta[charset]").attr("charset") ?? null, { method: "meta[charset]" });
    ctx.add(C.web_seo, "h1Count", $("h1").length, { status: "observed", method: "count(h1)" });
    ctx.add(C.web_seo, "themeColor", meta('meta[name="theme-color" i]'), { method: "meta[theme-color]" });
    const robotsMeta = [meta('meta[name="robots" i]'), meta('meta[name="googlebot" i]')].filter(Boolean) as string[];
    ctx.add(C.discovery, "robotsDirectives", robotsMeta.flatMap((r) => r.split(",").map((x) => x.trim().toLowerCase())), { method: "meta[name=robots]" });
    const hreflang = $('link[rel="alternate" i][hreflang]').map((_, el) => ({ lang: $(el).attr("hreflang"), href: abs(base, $(el).attr("href")) })).get().filter((x) => x.href).slice(0, 60);
    ctx.add(C.web_seo, "hreflang", hreflang, { method: "link[rel=alternate][hreflang]" });
    for (const h of hreflang) ctx.relate("alternate_language", h.href!, `hreflang=${h.lang}`, "link[rel=alternate][hreflang]");
    const feeds = $('link[rel="alternate" i][type*="rss" i], link[rel="alternate" i][type*="atom" i], link[rel="alternate" i][type*="feed+json" i]').map((_, el) => abs(base, $(el).attr("href"))).get().filter(Boolean) as string[];
    ctx.add(C.discovery, "feeds", feeds, { method: "link[rel=alternate][type=rss|atom]" });
    for (const f of feeds) ctx.relate("feed", f, "link rel=alternate feed", "link[rel=alternate]");
    const sitemapLinks = $('link[rel="sitemap" i]').map((_, el) => abs(base, $(el).attr("href"))).get().filter(Boolean) as string[];
    ctx.add(C.discovery, "sitemaps", sitemapLinks, { method: "link[rel=sitemap]" });
    for (const [rel, type] of [["prev", "previous"], ["next", "next"], ["author", "authored_by"], ["license", "licensed_under"], ["publisher", "published_by"], ["up", "part_of"], ["index", "part_of"], ["cite-as", "same_as"], ["describedby", "references"]] as const) {
      $(`link[rel~="${rel}" i], a[rel~="${rel}" i]`).slice(0, 5).each((_, el) => {
        const href = abs(base, $(el).attr("href"));
        if (href) ctx.relate(type, href, `rel=${rel}`, `link|a[rel=${rel}]`);
      });
    }
    const oembed = $('link[type="application/json+oembed"]').attr("href");
    if (oembed) ctx.add(C.discovery, "oembed", abs(base, oembed), { method: "link[type=json+oembed]" });
    const manifest = abs(base, $('link[rel="manifest" i]').attr("href"));
    ctx.add(C.discovery, "webAppManifest", manifest, { method: "link[rel=manifest]" });

    // ------------------------------------------------------------ rights
    // A licence link inside header/nav/footer is a site-wide statement; inside the content it applies to this resource.
    const regionOf = (el: Parameters<typeof $>[0]): "site" | "resource" => ($(el).closest("footer, nav, header, [role=contentinfo], [role=navigation]").length ? "site" : "resource");
    const licenseLinks = new Map<string, "site" | "resource">();
    $('a[rel~="license" i], link[rel~="license" i], a[href*="creativecommons.org/licenses"], a[href*="creativecommons.org/publicdomain"]').each((_, el) => {
      const href = abs(base, $(el).attr("href"));
      if (href && !licenseLinks.has(href)) licenseLinks.set(href, el.tagName === "link" ? "resource" : regionOf(el));
    });
    for (const [l, scope] of [...licenseLinks].slice(0, 5)) {
      ctx.add(C.rights, "license", licenseLabel(l) ?? l, { method: "a|link[rel=license]", evidence: `${l} (${scope === "site" ? "site-wide link in header/footer" : "in page content"})`, scope });
      ctx.add(C.rights, "licenseUrl", l, { method: "a|link[rel=license]", scope });
      ctx.relate("licensed_under", l, `rel=license / CC link (${scope} scope)`, "a|link[rel=license]");
    }
    ctx.add(C.rights, "copyright", meta('meta[name="copyright" i]'), { method: "meta[name=copyright]" });

    // ------------------------------------------------------------ structure & body text
    const headingOutline: Array<{ level: number; text: string }> = [];
    $("h1, h2, h3, h4, h5, h6").each((_, el) => {
      if (headingOutline.length >= 60) return;
      const text = clean($(el).text(), 160);
      if (text) headingOutline.push({ level: Number(el.tagName.slice(1)), text });
    });
    ctx.add(C.structural, "headingOutline", headingOutline, { status: "observed", method: "html h1-h6" });
    ctx.add(C.structural, "headingCount", $("h1, h2, h3, h4, h5, h6").length, { status: "observed", method: "count(h1-h6)" });
    ctx.add(C.structural, "tableCount", $("table").length, { status: "observed", method: "count(table)" });
    ctx.add(C.structural, "listCount", $("ul, ol").length, { status: "observed", method: "count(ul|ol)" });
    ctx.add(C.structural, "sectionCount", $("section, article").length, { status: "observed", method: "count(section|article)" });
    const landmarks = [...new Set(["header", "nav", "main", "aside", "footer"].filter((t) => $(t).length).concat($("[role]").map((_, el) => $(el).attr("role")).get().filter((r) => ["banner", "navigation", "main", "complementary", "contentinfo", "search"].includes(r))))];
    ctx.add(C.structural, "landmarks", landmarks, { status: "observed", method: "html landmarks/roles" });
    const tableHeaders = $("table").slice(0, 10).map((_, t) => [$(t).find("th").slice(0, 15).map((__, th) => clean($(th).text(), 60)).get()]).get();
    if (tableHeaders.some((h: string[]) => h.length)) ctx.add(C.structural, "tableHeaders", tableHeaders.filter((h: string[]) => h.length), { status: "observed", method: "table th" });

    const body = $("body").clone();
    body.find("script, style, noscript, template, svg").remove();
    const plain = blockText(body);
    ctx.shared.set("plainText", plain);
    // Research context (methods, samples, instruments…) only from main content, never nav/footer boilerplate.
    const mainEl = $("main, article, [role=main]").first();
    if (mainEl.length) {
      const mc = mainEl.clone();
      mc.find("script, style, nav, footer").remove();
      mineResearchText(ctx, blockText(mc), "page main content");
    }
    const words = plain ? plain.split(" ").length : 0;
    ctx.add(C.structural, "wordCount", words, { status: "observed", method: "body text word count" });

    // Copyright line (©)
    const copy = plain.match(/(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?[^.|·]{0,60}?(?=\s+(?:all rights|site ?map|privacy|terms|contact|about|deployed|\||·)|[.|·]|$)/i)?.[0];
    const footerText = $("footer, [role=contentinfo]").text();
    if (copy) ctx.add(C.rights, "copyright", clean(copy, 160), { method: "body text © notice", scope: footerText.includes(copy.slice(0, 20)) ? "site" : "resource", evidence: footerText.includes(copy.slice(0, 20)) ? "site footer notice — applies to the site, not necessarily this resource" : undefined });
    const spdx = plain.match(SPDX_HINT)?.[0];
    if (spdx && !licenseLinks.size) ctx.add(C.rights, "license", spdx, { status: "inferred", method: "licence-name pattern in body text", evidence: spdx });

    // Identifiers in text + links
    const linkHrefs = $("a[href]").map((_, el) => $(el).attr("href") ?? "").get();
    const ids = findIdentifiers(`${plain} ${linkHrefs.filter((h) => /doi\.org|orcid\.org|arxiv\.org/i.test(h)).join(" ")}`);
    ctx.add(C.identifiers, "doi", ids.doi, { method: "doi pattern (text/links)" });
    ctx.add(C.identifiers, "isbn", ids.isbn, { method: "isbn pattern + checksum" });
    ctx.add(C.identifiers, "orcid", ids.orcid, { method: "orcid pattern + mod11-2 checksum" });
    ctx.add(C.identifiers, "issn", ids.issn, { method: "issn pattern + checksum" });
    ctx.add(C.identifiers, "arxiv", ids.arxiv, { method: "arXiv id pattern" });
    for (const d of ids.doi.slice(0, 20)) ctx.relate("references", `https://doi.org/${d}`, `DOI ${d} in page`, "doi pattern");

    // Links: internal/external split, outbound domains
    let internal = 0;
    const external = new Map<string, number>();
    for (const href of linkHrefs) {
      const u = abs(base, href);
      if (!u) continue;
      const h = new URL(u).hostname;
      if (h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`)) internal++;
      else external.set(h, (external.get(h) ?? 0) + 1);
    }
    ctx.add(C.relational, "internalLinkCount", internal, { status: "observed", method: "a[href] same-site" });
    ctx.add(C.relational, "externalLinkCount", [...external.values()].reduce((a, b) => a + b, 0), { status: "observed", method: "a[href] cross-site" });
    ctx.add(C.relational, "outboundDomains", [...external.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([d, n]) => ({ domain: d, links: n })), { status: "observed", method: "a[href] cross-site" });
    const quotes = $("blockquote[cite], q[cite], cite a[href]").map((_, el) => abs(base, $(el).attr("cite") ?? $(el).attr("href"))).get().filter(Boolean) as string[];
    for (const q of quotes.slice(0, 20)) ctx.relate("cites", q, "blockquote/q cite attribute", "html[cite]");
    ctx.shared.set("internalLinks", linkHrefs.map((h) => abs(base, h)).filter((u): u is string => Boolean(u)));
    const refs: Array<{ url: string; text: string; rel: string; region: string; tag: string; type: string | null }> = [];
    $("a[href], link[href], img[src], video[src], audio[src], source[src], track[src], iframe[src], embed[src], object[data]").each((_, el) => {
      if (refs.length >= 1500) return;
      const e = $(el);
      const u = abs(base, e.attr("href") ?? e.attr("src") ?? e.attr("data"));
      if (!u) return;
      const region = e.closest("footer, [role=contentinfo]").length ? "footer" : e.closest("nav, [role=navigation]").length ? "nav" : e.closest("header, [role=banner]").length ? "header" : e.closest("main, article, [role=main]").length ? "main" : "body";
      refs.push({ url: u, text: clean(e.text() || e.attr("title") || e.attr("alt"), 120) ?? "", rel: (e.attr("rel") ?? "").toLowerCase(), region, tag: el.tagName, type: e.attr("type") ?? null });
    });
    ctx.shared.set("references", refs);

    // ------------------------------------------------------------ geo meta
    const geoPos = meta('meta[name="geo.position" i]') ?? meta('meta[name="ICBM" i]');
    if (geoPos) {
      const [lat, lon] = geoPos.split(/[;,]\s*/).map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ctx.add(C.spatial, "coordinates", { lat, lon }, { method: "meta[geo.position|ICBM]", evidence: geoPos });
    }
    ctx.add(C.spatial, "placename", meta('meta[name="geo.placename" i]'), { method: "meta[geo.placename]" });
    ctx.add(C.spatial, "region", meta('meta[name="geo.region" i]'), { method: "meta[geo.region]" });

    // ------------------------------------------------------------ accessibility
    const imgs = $("img");
    const withAlt = imgs.filter((_, el) => $(el).attr("alt") !== undefined).length;
    const decorative = imgs.filter((_, el) => $(el).attr("alt") === "").length;
    ctx.add(C.accessibility, "documentLanguage", lang, { method: "html[lang]" });
    ctx.add(C.accessibility, "imagesTotal", imgs.length, { status: "observed", method: "count(img)" });
    ctx.add(C.accessibility, "imagesWithAlt", withAlt, { status: "observed", method: "count(img[alt])", evidence: `${decorative} marked decorative (alt="")` });
    if (imgs.length) ctx.add(C.accessibility, "altCoverage", Number((withAlt / imgs.length).toFixed(3)), { status: "observed", method: "img[alt]/img" });
    const tracks = $("video track, audio track");
    ctx.add(C.accessibility, "captionTracks", tracks.filter((_, el) => /captions|subtitles/i.test($(el).attr("kind") ?? "subtitles")).length, { status: "observed", method: "track[kind=captions|subtitles]" });
    ctx.add(C.accessibility, "mediaElements", $("video, audio").length, { status: "observed", method: "count(video|audio)" });
    const inputs = $("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea");
    const labelled = inputs.filter((_, el) => {
      const id = $(el).attr("id");
      return Boolean($(el).attr("aria-label") || $(el).attr("aria-labelledby") || $(el).attr("title") || (id && $(`label[for="${id}"]`).length) || $(el).closest("label").length);
    }).length;
    ctx.add(C.accessibility, "formInputs", inputs.length, { status: "observed", method: "count(form controls)" });
    if (inputs.length) ctx.add(C.accessibility, "labelledInputs", labelled, { status: "observed", method: "label|aria-label|aria-labelledby" });
    ctx.add(C.accessibility, "landmarks", landmarks, { status: "observed", method: "html landmarks/roles" });
    ctx.add(C.accessibility, "skipLink", $('a[href^="#"]').filter((_, el) => /skip/i.test($(el).text())).length > 0, { status: "observed", method: "skip-link heuristic" });

    // ------------------------------------------------------------ forms → access + constraints
    const constraints: Array<Record<string, unknown>> = [];
    $("form").slice(0, 10).each((fi, form) => {
      $(form).find("input, select, textarea").slice(0, 40).each((_, el) => {
        const a = (n: string) => $(el).attr(n);
        const type = (a("type") ?? el.tagName).toLowerCase();
        if (["hidden", "submit", "button", "password"].includes(type)) return;
        const c: Record<string, unknown> = { form: fi, name: a("name") ?? a("id") ?? null, type };
        if (a("required") !== undefined) c.required = true;
        for (const k of ["min", "max", "minlength", "maxlength", "pattern", "step"]) if (a(k) !== undefined) c[k] = a(k);
        if (el.tagName === "select") c.enum = $(el).find("option").slice(0, 20).map((__, o) => $(o).attr("value") ?? $(o).text()).get();
        if (Object.keys(c).length > 3) constraints.push(c);
      });
    });
    ctx.add(C.constraints, "formConstraints", constraints.slice(0, 60), { method: "html form constraint attributes" });
    const hasPassword = $('input[type="password" i]').length > 0;
    ctx.add(C.access_security, "hasLoginForm", hasPassword, { status: "observed", method: "input[type=password]" });

    // ------------------------------------------------------------ integrity (SRI) + third parties
    const scripts = $("script[src]");
    const thirdParty = new Set<string>();
    let sri = 0;
    scripts.each((_, el) => {
      const src = abs(base, $(el).attr("src"));
      if ($(el).attr("integrity")) sri++;
      if (src) {
        const h = new URL(src).hostname;
        if (h !== host && !h.endsWith(`.${host}`)) thirdParty.add(h);
      }
    });
    ctx.add(C.integrity, "sriScripts", sri, { status: "observed", method: "script[integrity]", evidence: `${sri} of ${scripts.length} external scripts carry SRI hashes` });
    ctx.add(C.privacy, "thirdPartyScriptDomains", [...thirdParty].slice(0, 30), { status: "observed", method: "script[src] hosts" });

    // ------------------------------------------------------------ privacy & retention
    const privacyLink = $("a[href]").filter((_, el) => /privacy|datenschutz|confidentialit/i.test(`${$(el).text()} ${$(el).attr("href")}`)).first().attr("href");
    ctx.add(C.privacy, "privacyPolicyUrl", abs(base, privacyLink), { method: "a[href~=privacy]", scope: "site" });
    const cookieLink = $("a[href]").filter((_, el) => /cookie/i.test(`${$(el).text()} ${$(el).attr("href")}`)).first().attr("href");
    ctx.add(C.privacy, "cookiePolicyUrl", abs(base, cookieLink), { method: "a[href~=cookie]", scope: "site" });
    const termsLink = $("a[href]").filter((_, el) => /terms|conditions|tos\b/i.test(`${$(el).text()} ${$(el).attr("href")}`)).first().attr("href");
    ctx.add(C.rights, "termsUrl", abs(base, termsLink), { method: "a[href~=terms]", scope: "site" });
    const retention = [...plain.matchAll(RETENTION_RE)].map((m) => clean(m[0], 240)).filter(Boolean).slice(0, 8);
    const policyPage = /privacy|policy|retention|terms|gdpr|data-protection/i.test(new URL(ctx.response.finalUrl).pathname);
    ctx.add(C.retention, "retentionStatements", retention, { method: "retention phrase pattern", evidence: "quoted from page text", scope: policyPage ? "site" : "resource" });

    // ------------------------------------------------------------ directory listings (Apache/nginx autoindex)
    if (/^index of\s/i.test(title ?? "") || /^index of\s/i.test($("h1").first().text())) {
      const rows: Array<{ name: string; modified: string | null; size: string | null }> = [];
      $("pre a[href], table a[href]").each((_, el) => {
        const name = $(el).attr("href") ?? "";
        if (!name || name.startsWith("?") || name.startsWith("/") || name === "../") return;
        const line = ($(el).closest("tr").text() || String(($(el)[0].next as { data?: string } | null)?.data ?? "")).replace(/\s+/g, " ").trim();
        const date = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}/)?.[0] ?? null;
        const size = line.match(/\s(\d+(?:\.\d+)?[KMG]?)\s*$/)?.[1] ?? null;
        rows.push({ name: decodeURIComponent(name), modified: date, size });
      });
      ctx.add(C.discovery, "directoryListing", true, { status: "observed", method: "autoindex page" });
      ctx.add(C.structural, "entryCount", rows.length, { status: "observed", method: "autoindex rows" });
      ctx.add(C.file_system, "listing", rows.slice(0, 200), { method: "autoindex rows", evidence: "source-reported names, sizes and modification times" });
      const refs = (ctx.shared.get("references") as Array<{ url: string; tag: string }> | undefined) ?? [];
      for (const r of refs) if (r.tag === "a") r.tag = "listing";
    }

    // ------------------------------------------------------------ AI/ML page hints (model cards rendered as HTML)
    const hfModel = /huggingface\.co$/.test(host) && /^\/[^/]+\/[^/]+\/?$/.test(new URL(ctx.response.finalUrl).pathname);
    if (hfModel) ctx.shared.set("hfRepo", new URL(ctx.response.finalUrl).pathname.replace(/^\/|\/$/g, ""));
  },
};
