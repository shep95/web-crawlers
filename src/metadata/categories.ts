import type { ResourceKind, Sensitivity } from "./types.js";

export type FieldType = "string" | "number" | "boolean" | "date" | "url" | "array" | "object";

export interface CategoryDefinition {
  id: number;
  key: string;
  name: string;
  definition: string;
  /** Resource kinds where the category can meaningfully be evaluated. */
  appliesTo: ResourceKind[] | "all";
  /** Extraction methods implemented for this category (see extractors/). */
  methods: string[];
  sensitivity: Sensitivity;
  /** Normalised schema: declared field names → expected type (validated in pipeline). */
  fields: Record<string, FieldType>;
  /** Honest statement of what is NOT covered. */
  limitations: string;
}

const ALL: "all" = "all";
const DOCS: ResourceKind[] = ["webpage", "pdf", "office", "text", "xml", "json"];
const DATA: ResourceKind[] = ["webpage", "json", "csv", "xml"];
const MEDIA: ResourceKind[] = ["image", "audio", "video"];

export const CATEGORIES: CategoryDefinition[] = [
  {
    id: 1, key: "descriptive", name: "Descriptive",
    definition: "What a resource is: title, description, creators, subjects, keywords, language.",
    appliesTo: ALL, methods: ["html.meta", "json-ld", "dublin-core", "pdf.info", "ooxml.core", "id3/vorbis tags", "exif/iptc/xmp", "feed", "csv.header"],
    sensitivity: "public",
    fields: { title: "string", description: "string", author: "array", keywords: "array", language: "string", subject: "array", headline: "string", generator: "string" },
    limitations: "Summaries are source-declared descriptions only; no generative summarisation.",
  },
  {
    id: 2, key: "structural", name: "Structural",
    definition: "How a resource is organised: headings, sections, tables, pages, tracks, parts.",
    appliesTo: ALL, methods: ["html.dom", "pdf.pages", "ooxml.app", "media.tracks", "csv.shape", "json.shape", "feed.items"],
    sensitivity: "public",
    fields: { headingOutline: "array", headingCount: "number", tableCount: "number", listCount: "number", wordCount: "number", pageCount: "number", landmarks: "array", trackCount: "number", rowCount: "number", columnCount: "number", itemCount: "number" },
    limitations: "PDF outlines (bookmarks) are not parsed; DOCX heading structure not parsed.",
  },
  {
    id: 3, key: "administrative", name: "Administrative",
    definition: "Resource management: record identifiers, custodians, maintainers, administrative status.",
    appliesTo: DATA.concat(["pdf", "office"]), methods: ["json-ld Dataset", "datapackage.json", "ckan/dcat json", "ooxml.app"],
    sensitivity: "public",
    fields: { maintainer: "string", custodian: "string", recordIdentifier: "string", status: "string", company: "string" },
    limitations: "Only explicitly declared administrative fields.",
  },
  {
    id: 4, key: "technical", name: "Technical",
    definition: "Machine-readable properties: MIME type, encoding, format, codecs, resolution, compression.",
    appliesTo: ALL, methods: ["http.headers", "magic-bytes", "image-size", "music-metadata", "pdf.header"],
    sensitivity: "public",
    fields: { mimeType: "string", sniffedType: "string", charset: "string", contentLength: "number", contentEncoding: "string", compressionRatio: "number", server: "string", httpStatus: "number", width: "number", height: "number", format: "string", codec: "string", bitrate: "number", sampleRate: "number", pdfVersion: "string" },
    limitations: "No transcoding/probing beyond container headers.",
  },
  {
    id: 5, key: "preservation", name: "Preservation",
    definition: "Preservation history: archive captures, fixity values, preservation formats (e.g. PDF/A).",
    appliesTo: ALL, methods: ["wayback-cdx", "sha256", "pdf.xmp pdfaid", "memento headers"],
    sensitivity: "public",
    fields: { sha256: "string", archiveFirstCapture: "date", archiveLastCapture: "date", archiveCaptureSample: "number", pdfaConformance: "string", mementoDatetime: "date" },
    limitations: "Wayback lookups depend on archive.org availability; capture count is a capped sample.",
  },
  {
    id: 6, key: "rights", name: "Rights & licensing",
    definition: "Copyright notices, licences, attribution and reuse terms.",
    appliesTo: ALL, methods: ["rel=license", "json-ld license", "cc-url detection", "copyright notice", "iptc/xmp rights", "model-card license", "spdx"],
    sensitivity: "public",
    fields: { license: "string", licenseUrl: "url", copyright: "string", rightsStatement: "string", copyrightHolder: "string" },
    limitations: "Detected licences are source-declared; no legal interpretation.",
  },
  {
    id: 7, key: "access_security", name: "Access & security",
    definition: "Publicly disclosed access restrictions, authentication requirements, security headers.",
    appliesTo: ALL, methods: ["http.status", "www-authenticate", "security headers", "json-ld isAccessibleForFree", "login-form detection", "openapi securitySchemes"],
    sensitivity: "public",
    fields: { accessRequiresAuth: "boolean", isAccessibleForFree: "boolean", securityHeaders: "object", missingSecurityHeaders: "array", hasLoginForm: "boolean", cacheControl: "string", securitySchemes: "array" },
    limitations: "Never probes or bypasses access controls; only reports what responses disclose.",
  },
  {
    id: 8, key: "provenance", name: "Provenance",
    definition: "Where information originated: publisher, original URL, retrieval time, redirect chain.",
    appliesTo: ALL, methods: ["fetch trace", "json-ld publisher", "og:site_name", "pdf producer", "exif software"],
    sensitivity: "public",
    fields: { requestedUrl: "url", finalUrl: "url", retrievedAt: "date", redirectChain: "array", publisher: "string", siteName: "string", producer: "string", creatorTool: "string" },
    limitations: "Publisher values are source-declared and not independently authenticated.",
  },
  {
    id: 9, key: "lineage", name: "Lineage",
    definition: "Declared derivations: upstream sources, base models, isBasedOn, data sources.",
    appliesTo: DATA.concat(["text"]), methods: ["json-ld isBasedOn", "datapackage sources", "model-card base_model/datasets"],
    sensitivity: "public",
    fields: { derivedFrom: "array", sources: "array", baseModel: "array", processingSteps: "array" },
    limitations: "Only declared lineage; no inferred derivation.",
  },
  {
    id: 10, key: "audit", name: "Audit",
    definition: "Public change logs and activity history from systems we may inspect.",
    appliesTo: ["webpage", "json", "feed"], methods: ["github public commits API", "feed entries"],
    sensitivity: "public",
    fields: { recentCommits: "array", lastCommitAt: "date", changeEntries: "array" },
    limitations: "GitHub repositories only (public, unauthenticated, rate-limited).",
  },
  {
    id: 11, key: "version", name: "Version",
    definition: "Versions, revisions, releases and supersession.",
    appliesTo: ALL, methods: ["etag", "json-ld version", "openapi info.version", "ooxml revision", "package metadata"],
    sensitivity: "public",
    fields: { etag: "string", version: "string", revision: "string", softwareVersion: "string", latestRelease: "string" },
    limitations: "No cross-version diffing across stored history (service is stateless).",
  },
  {
    id: 12, key: "temporal", name: "Temporal",
    definition: "Creation, publication, modification, capture and expiry timestamps (normalised to UTC, original kept).",
    appliesTo: ALL, methods: ["http last-modified/date/expires", "article:* meta", "json-ld dates", "<time>", "pdf dates", "exif dates", "feed dates"],
    sensitivity: "public",
    fields: { published: "date", modified: "date", created: "date", lastModifiedHeader: "date", serverDate: "date", expires: "date", retrievedAt: "date", temporalCoverage: "string" },
    limitations: "Timestamps without a timezone are interpreted as UTC and marked in `original`.",
  },
  {
    id: 13, key: "spatial", name: "Spatial / geographic",
    definition: "Explicitly declared coordinates, places and coverage areas.",
    appliesTo: ALL, methods: ["geo.position/ICBM meta", "json-ld geo/spatialCoverage", "exif gps"],
    sensitivity: "personal",
    fields: { coordinates: "object", placename: "string", region: "string", spatialCoverage: "string", gps: "object" },
    limitations: "EXIF GPS is rounded to ~1 km; locations are never inferred from unrelated signals.",
  },
  {
    id: 14, key: "identifiers", name: "Identity & identifiers",
    definition: "DOIs, ISBNs, ORCIDs, ISSNs, ISRCs, UUIDs, canonical URLs and repository IDs.",
    appliesTo: ALL, methods: ["regex+checksum validation", "citation_* meta", "json-ld identifier", "id3 isrc"],
    sensitivity: "public",
    fields: { canonicalUrl: "url", doi: "array", isbn: "array", issn: "array", orcid: "array", arxiv: "array", isrc: "array", identifier: "array" },
    limitations: "ISBN/ISSN/ORCID are checksum-validated; alias resolution is not asserted.",
  },
  {
    id: 15, key: "relational", name: "Relational",
    definition: "Explicit connections: isPartOf, references, sameAs, cites, supersedes, prev/next.",
    appliesTo: ALL, methods: ["rel links", "json-ld relations", "citation_reference", "link headers"],
    sensitivity: "public",
    fields: { relationCount: "number", outboundDomains: "array", internalLinkCount: "number", externalLinkCount: "number" },
    limitations: "Relationships require explicit evidence; name similarity is never treated as identity.",
  },
  {
    id: 16, key: "semantic", name: "Semantic",
    definition: "Vocabularies, typed entities and ontology terms (schema.org, Dublin Core, RDFa, microdata).",
    appliesTo: ALL, methods: ["json-ld @type/@context", "microdata itemtype", "rdfa vocab/prefix", "xml namespaces"],
    sensitivity: "public",
    fields: { types: "array", vocabularies: "array", microdataTypes: "array", rdfaVocab: "array", xmlNamespaces: "array" },
    limitations: "No ontology reasoning; reports declared terms only.",
  },
  {
    id: 17, key: "schema", name: "Schema",
    definition: "Data structure definitions: JSON Schema, OpenAPI, XSD, table schemas, inferred column types.",
    appliesTo: DATA, methods: ["json-schema", "openapi", "xsd schemaLocation", "datapackage schema", "csv type inference"],
    sensitivity: "public",
    fields: { schemaType: "string", properties: "array", columns: "array", apiPaths: "number", xsd: "array" },
    limitations: "Inferred CSV/JSON types are labelled inferred.",
  },
  {
    id: 18, key: "constraints", name: "Validation & constraints",
    definition: "Declared restrictions: required fields, enums, ranges, patterns, max lengths.",
    appliesTo: DATA, methods: ["json-schema keywords", "html form constraints", "datapackage constraints"],
    sensitivity: "public",
    fields: { required: "array", enums: "array", ranges: "array", patterns: "array", formConstraints: "array" },
    limitations: "Constraints are reported, not enforced against data.",
  },
  {
    id: 19, key: "statistical", name: "Statistical",
    definition: "Statistical interpretation: variables, units, sample sizes, aggregation, measurement technique.",
    appliesTo: DATA, methods: ["json-ld variableMeasured/measurementTechnique", "csv column statistics"],
    sensitivity: "public",
    fields: { variables: "array", columnStats: "array", sampleSize: "number", measurementTechnique: "string" },
    limitations: "Column statistics are computed over the fetched sample (body cap) and labelled inferred.",
  },
  {
    id: 20, key: "quality", name: "Data quality",
    definition: "Evidence-based quality: completeness, contradictions, parse errors, null rates, truncation.",
    appliesTo: ALL, methods: ["pipeline quality checks", "csv null rate", "type-sniff mismatch"],
    sensitivity: "public",
    fields: { completeness: "number", contradictionCount: "number", extractorErrorCount: "number", nullRate: "number", truncated: "boolean" },
    limitations: "Scores are transparent ratios, not opaque confidence values.",
  },
  {
    id: 21, key: "business", name: "Business",
    definition: "Organisation-level meaning: organisation names, identifiers (LEI, DUNS), product classifications.",
    appliesTo: ["webpage", "json", "office", "pdf"], methods: ["json-ld Organization/Product", "ooxml company"],
    sensitivity: "public",
    fields: { organization: "string", legalName: "string", productIds: "array", industry: "string", lei: "string" },
    limitations: "Organisation data only (never private individuals' addresses or phone numbers).",
  },
  {
    id: 22, key: "operational", name: "Operational",
    definition: "Service/processing status: availability, latency, cache state, refresh intervals.",
    appliesTo: ALL, methods: ["fetch timings", "cache headers", "feed ttl/updatePeriod", "pipeline timings"],
    sensitivity: "public",
    fields: { available: "boolean", ttfbMs: "number", totalMs: "number", cacheStatus: "string", age: "number", refreshInterval: "string" },
    limitations: "Single observation at request time; no history (stateless service).",
  },
  {
    id: 23, key: "usage", name: "Usage & analytics",
    definition: "Publicly displayed usage counts (views, downloads, stars) — never private analytics.",
    appliesTo: ["webpage", "json"], methods: ["json-ld interactionStatistic", "github/hf public API counters"],
    sensitivity: "public",
    fields: { interactionCounts: "array", downloads: "number", stars: "number", forks: "number", likes: "number" },
    limitations: "Only public counters; values reflect the source's own reporting.",
  },
  {
    id: 24, key: "social_annotation", name: "Social & annotation",
    definition: "Public tags, ratings, reviews, comment counts and annotations.",
    appliesTo: ["webpage", "json", "image"], methods: ["json-ld aggregateRating/commentCount", "rel=tag", "github topics"],
    sensitivity: "public",
    fields: { tags: "array", rating: "object", commentCount: "number", reviewCount: "number" },
    limitations: "Individual comment authors/content are not collected.",
  },
  {
    id: 25, key: "discovery", name: "Discovery & indexing",
    definition: "Indexing directives and discovery aids: robots, sitemaps, feeds, alternates.",
    appliesTo: ALL, methods: ["robots.txt", "x-robots-tag", "meta robots", "link rel=alternate", "sitemap"],
    sensitivity: "public",
    fields: { robotsAllowed: "boolean", robotsDirectives: "array", xRobotsTag: "string", sitemaps: "array", feeds: "array", crawlDelay: "number" },
    limitations: "Only the site's robots.txt and declared links; no search-engine index queries.",
  },
  {
    id: 26, key: "web_seo", name: "Web & SEO",
    definition: "Page-level web metadata: title/description lengths, canonical, hreflang, viewport, headings.",
    appliesTo: ["webpage"], methods: ["html.head", "html.dom"],
    sensitivity: "public",
    fields: { titleLength: "number", descriptionLength: "number", canonical: "url", hreflang: "array", viewport: "string", h1Count: "number", structuredDataTypes: "array", charsetDeclared: "string" },
    limitations: "No ranking predictions.",
  },
  {
    id: 27, key: "social_sharing", name: "Social sharing",
    definition: "Link preview metadata: Open Graph, Twitter/X Cards.",
    appliesTo: ["webpage"], methods: ["og:*", "twitter:*"],
    sensitivity: "public",
    fields: { openGraph: "object", twitterCard: "object", previewImage: "url" },
    limitations: "Preview images are referenced, not downloaded.",
  },
  {
    id: 28, key: "file_system", name: "File system",
    definition: "File properties: filename, extension, size, server-declared modification time.",
    appliesTo: ALL, methods: ["content-disposition", "url path", "content-length"],
    sensitivity: "public",
    fields: { filename: "string", extension: "string", sizeBytes: "number", serverModified: "date" },
    limitations: "Remote file permissions are not observable over HTTP.",
  },
  {
    id: 29, key: "image", name: "Image",
    definition: "EXIF, IPTC, XMP, dimensions, orientation, colour profile, camera attributes.",
    appliesTo: ["image"], methods: ["image-size", "exifr (exif/iptc/xmp/icc)"],
    sensitivity: "public",
    fields: { width: "number", height: "number", format: "string", orientation: "number", colorSpace: "string", iccProfile: "string", make: "string", model: "string", exposure: "object", lens: "string" },
    limitations: "Body capped at the configured byte limit; camera serial numbers are masked.",
  },
  {
    id: 30, key: "audio", name: "Audio",
    definition: "Track tags and technical audio properties.",
    appliesTo: ["audio", "video"], methods: ["music-metadata"],
    sensitivity: "public",
    fields: { title: "string", artist: "array", album: "string", duration: "number", sampleRate: "number", bitrate: "number", channels: "number", codec: "string", lossless: "boolean" },
    limitations: "Files larger than the byte cap are parsed from a prefix; durations may be missing.",
  },
  {
    id: 31, key: "video", name: "Video",
    definition: "Container, resolution, codecs, duration, subtitle/text tracks.",
    appliesTo: ["video"], methods: ["music-metadata container parsing"],
    sensitivity: "public",
    fields: { container: "string", duration: "number", width: "number", height: "number", videoCodec: "string", audioCodec: "string", tracks: "array", subtitleTracks: "array" },
    limitations: "Frame rate is reported only when the container declares it.",
  },
  {
    id: 32, key: "document", name: "Document",
    definition: "Document properties: authors, subject, page counts, revisions, creation dates.",
    appliesTo: ["pdf", "office", "text"], methods: ["pdf-lib info dict", "ooxml/odf core props", "pdf xmp"],
    sensitivity: "public",
    fields: { title: "string", author: "string", subject: "string", keywords: "array", pageCount: "number", wordCount: "number", revision: "string", application: "string", encrypted: "boolean" },
    limitations: "No OCR; text extraction limited to metadata, not full content.",
  },
  {
    id: 33, key: "email", name: "Email",
    definition: "Headers of explicitly provided .eml messages: IDs, routing, reply chains, MIME, auth results.",
    appliesTo: ["email"], methods: ["rfc5322 header parser", "mime structure"],
    sensitivity: "personal",
    fields: { messageId: "string", from: "string", to: "array", subject: "string", date: "date", inReplyTo: "string", receivedHops: "number", mimeParts: "array", dkim: "boolean", authResults: "string" },
    limitations: "Only user-provided files/URLs; addresses are masked (local part).",
  },
  {
    id: 34, key: "network", name: "Network & communications",
    definition: "Public protocol information: resolved address, DNS records, TLS, HTTP version hints.",
    appliesTo: ALL, methods: ["dns resolve", "tls handshake", "alt-svc", "fetch trace"],
    sensitivity: "public",
    fields: { remoteAddress: "string", dns: "object", tls: "object", altSvc: "string", http3Advertised: "boolean", redirectCount: "number" },
    limitations: "Only our own connection metadata and public DNS; never third-party traffic. Unavailable behind an egress proxy.",
  },
  {
    id: 35, key: "device_sensor", name: "Device & sensor",
    definition: "Published equipment information: camera/recorder models, firmware, instruments.",
    appliesTo: ["image", "video", "audio", "webpage", "json"], methods: ["exif make/model/software", "json-ld measurementTechnique/instrument"],
    sensitivity: "public",
    fields: { deviceMake: "string", deviceModel: "string", firmware: "string", instrument: "string", serialNumber: "string" },
    limitations: "Serial numbers are masked.",
  },
  {
    id: 36, key: "scientific", name: "Scientific & experimental",
    definition: "Research context: citation metadata, journals, methods, instruments, citation files.",
    appliesTo: ["webpage", "pdf", "json", "xml", "text"], methods: ["highwire citation_* meta", "json-ld ScholarlyArticle/Dataset", "CITATION.cff", "crossref corroboration"],
    sensitivity: "public",
    fields: { journal: "string", publicationDate: "date", authors: "array", volume: "string", issue: "string", pages: "string", method: "string", citations: "number" },
    limitations: "Crossref corroboration requires a DOI and api.crossref.org availability.",
  },
  {
    id: 37, key: "ai_ml", name: "AI / machine learning",
    definition: "Model and dataset cards: architecture, base model, datasets, metrics, licence, limitations.",
    appliesTo: ["webpage", "json", "text"], methods: ["model-card yaml front matter", "hf config.json", "huggingface api"],
    sensitivity: "public",
    fields: { modelType: "string", architectures: "array", pipelineTag: "string", datasets: "array", metrics: "array", baseModel: "array", libraryName: "string", limitations: "string" },
    limitations: "Hugging Face and generic model-card formats only.",
  },
  {
    id: 38, key: "accessibility", name: "Accessibility",
    definition: "Declared accessibility features: language, alt text coverage, captions, landmarks, labels.",
    appliesTo: ["webpage", "video", "pdf"], methods: ["html audit", "track kind=captions", "json-ld accessibility*", "pdf tagged"],
    sensitivity: "public",
    fields: { documentLanguage: "string", imagesTotal: "number", imagesWithAlt: "number", altCoverage: "number", captionTracks: "number", formInputs: "number", labelledInputs: "number", landmarks: "array", accessibilityFeatures: "array" },
    limitations: "Signals, not a WCAG conformance claim — presence of a caption field does not prove accessibility.",
  },
  {
    id: 39, key: "privacy", name: "Privacy & sensitivity",
    definition: "Privacy statements and personal-data indicators (counted and masked, never harvested).",
    appliesTo: ALL, methods: ["privacy link detection", "pii pattern counts (masked)", "cookie headers", "exif gps presence"],
    sensitivity: "restricted",
    fields: { privacyPolicyUrl: "url", personalDataIndicators: "object", setsCookies: "boolean", thirdPartyScriptDomains: "array", containsGps: "boolean" },
    limitations: "PII values are never returned — only counts and masked forms.",
  },
  {
    id: 40, key: "retention", name: "Retention & disposition",
    definition: "Declared lifecycle rules: retention periods, expiry, deletion policies.",
    appliesTo: ["webpage", "text", "pdf", "json"], methods: ["retention phrase detection", "security.txt Expires", "http expires", "json-ld expires"],
    sensitivity: "public",
    fields: { retentionStatements: "array", expires: "date", deletionPolicy: "string" },
    limitations: "Phrase detection over page text; statements are quoted, not interpreted.",
  },
  {
    id: 41, key: "integrity", name: "Authenticity & integrity",
    definition: "Hashes, published checksum verification, signatures, SRI, TLS certificate evidence.",
    appliesTo: ALL, methods: ["sha256", "published .sha256 verification", "content-md5/digest headers", "sri integrity attributes", "pdf signature detection", "dkim presence", "tls certificate"],
    sensitivity: "public",
    fields: { sha256: "string", checksumVerification: "object", sriScripts: "number", signed: "boolean", headerDigestMatch: "boolean" },
    limitations: "A matching checksum proves consistency with the published digest, not that the source is trustworthy.",
  },
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
export const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function categoryApplies(id: number, kind: ResourceKind): boolean {
  const def = CATEGORY_BY_ID.get(id);
  if (!def) return false;
  return def.appliesTo === "all" || def.appliesTo.includes(kind);
}

/** Named category ids for readable extractor code. */
export const C = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.id])) as Record<string, number> & {
  descriptive: 1; structural: 2; administrative: 3; technical: 4; preservation: 5; rights: 6;
  access_security: 7; provenance: 8; lineage: 9; audit: 10; version: 11; temporal: 12; spatial: 13;
  identifiers: 14; relational: 15; semantic: 16; schema: 17; constraints: 18; statistical: 19;
  quality: 20; business: 21; operational: 22; usage: 23; social_annotation: 24; discovery: 25;
  web_seo: 26; social_sharing: 27; file_system: 28; image: 29; audio: 30; video: 31; document: 32;
  email: 33; network: 34; device_sensor: 35; scientific: 36; ai_ml: 37; accessibility: 38;
  privacy: 39; retention: 40; integrity: 41;
};
