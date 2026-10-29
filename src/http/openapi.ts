/** OpenAPI 3.1 description of the public API, served at /api/v2/openapi.json for frontend integration. */
const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "object", properties, ...extra });
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const err = { description: "Error", content: json(ref("Error")) };

export function openApiSpec(serverUrl?: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Omnispider metadata intelligence API",
      version: "2.0.0",
      description:
        "Ask questions of a corpus collected by autonomous crawlers. Every result carries field-level metadata across 41 categories with evidence (source, method, extractor, evidence type, scope, time). Read endpoints are public unless API_KEYS is set; send the key as `Authorization: Bearer <key>` or `X-API-Key`.",
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" }, apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
      schemas: {
        Error: obj({ error: str, message: str }),
        Fact: obj({ value: {}, field: str, method: str, evidenceType: { enum: ["direct_extraction", "source_claim", "system_measurement", "inferred"] }, scope: { enum: ["resource", "collection", "organization", "site"] }, via: str }),
        Observation: obj({
          category: int, field: str, value: {}, original: str,
          status: { enum: ["observed", "source_declared", "corroborated", "inferred", "contradicted", "extraction_failed"] },
          evidenceType: str, scope: str, method: str, extractor: str, evidence: str, sensitivity: str, masked: { type: "boolean" }, observedAt: str,
        }),
        CategoryState: obj({ id: int, key: str, name: str, state: { enum: ["observed", "not_found_after_inspection", "unavailable", "not_applicable", "extraction_failed"] }, fieldCount: int, note: str }),
        LinkedResource: obj({ type: str, purpose: str, scope: str, id: int, url: str, title: str, kind: str, state: str }),
        SearchResult: obj({
          resourceId: int, url: str, finalUrl: str, title: str, description: str, kind: str, host: str, score: { type: "number" }, snippet: str,
          retrievedAt: str, indexedAt: str, snapshots: int, changes: int, categoriesObserved: { type: "array", items: int },
          facts: obj(Object.fromEntries(["publisher", "creators", "spatialCoverage", "temporalCoverage", "dates", "formats", "structure", "methods", "license", "version", "identifiers", "access"].map((k) => [k, { type: "array", items: ref("Fact") }]))),
          evidence: { type: "array", items: ref("Observation") },
          gaps: { type: "array", items: obj({ category: int, name: str, state: str }) },
          supportingResources: { type: "array", items: ref("LinkedResource") },
          referencedBy: { type: "array", items: ref("LinkedResource") },
        }),
        SearchResponse: obj({
          query: str, terms: { type: "array", items: str }, intentCategories: { type: "array", items: obj({ id: int, name: str }) }, resourceTypes: { type: "array", items: str },
          total: int, results: { type: "array", items: ref("SearchResult") }, tookMs: int,
          discovery: obj({ queued: { type: "boolean" }, reason: str }), corpus: obj({ backend: str, indexed: int }), cache: obj({ hit: { type: "boolean" }, ageSeconds: int }),
        }),
        ResourceDetail: obj({
          resource: obj({}, { additionalProperties: true }),
          stages: obj({ discovered: str, retrieved: str, inspected: str, extracted: str, indexed: str, state: str, lastError: str }),
          categories: { type: "array", items: ref("CategoryState") },
          observations: { type: "array", items: ref("Observation") },
          relationships: obj({ outgoing: { type: "array" }, incoming: { type: "array" } }),
          snapshots: { type: "array" }, events: { type: "array" }, quality: obj({}, { additionalProperties: true }),
        }),
      },
    },
    paths: {
      "/api/v2/search": {
        get: {
          summary: "Ask a question of the collected corpus",
          parameters: [
            { name: "q", in: "query", required: true, schema: { ...str, maxLength: 500 }, example: "research datasets about snowfall in northern india" },
            { name: "limit", in: "query", schema: { ...int, minimum: 1, maximum: 50 } },
            { name: "offset", in: "query", schema: { ...int, minimum: 0, maximum: 1000 } },
            { name: "kind", in: "query", schema: { enum: ["webpage", "pdf", "office", "image", "audio", "video", "csv", "json", "xml", "feed", "text", "email", "archive"] } },
            { name: "category", in: "query", schema: { ...int, minimum: 1, maximum: 41 } },
            { name: "host", in: "query", schema: str },
          ],
          responses: { 200: { description: "Findings with fact sheets, evidence, supporting resources and gaps", content: json(ref("SearchResponse")) }, 400: err, 401: err, 429: err },
        },
      },
      "/api/v2/resources/{id}": { get: { summary: "Full evidence view of one collected resource", parameters: [{ name: "id", in: "path", required: true, schema: int }], responses: { 200: { description: "Resource", content: json(ref("ResourceDetail")) }, 404: err } } },
      "/api/v2/resources": { get: { summary: "Look up a collected resource by URL", parameters: [{ name: "url", in: "query", required: true, schema: str }], responses: { 200: { description: "Resource", content: json(ref("ResourceDetail")) }, 404: err } } },
      "/api/v2/resources/{id}/snapshots/{sid}": { get: { summary: "A historical snapshot and its observations", parameters: [{ name: "id", in: "path", required: true, schema: int }, { name: "sid", in: "path", required: true, schema: int }], responses: { 200: { description: "Snapshot" }, 404: err } } },
      "/api/v2/categories": { get: { summary: "The 41-category registry (applicability, methods, extended fields, discovery rules, validation)", responses: { 200: { description: "Registry" } } } },
      "/api/v2/crawler/status": { get: { summary: "Frontier, states, sources, recent crawler events", responses: { 200: { description: "Status" } } } },
      "/api/v2/crawler/capabilities": { get: { summary: "Extractor reliability and learned URL-pattern yields", responses: { 200: { description: "Capabilities" } } } },
      "/api/v2/analyze": { get: { summary: "Inspect one public URL now (optional; crawling does not require it)", parameters: [{ name: "url", in: "query", required: true, schema: str }], responses: { 200: { description: "Record" }, 403: err, 451: err } } },
      "/api/v2/analyze/upload": { post: { summary: "Inspect an uploaded file (raw body; X-Filename / X-Content-Type headers)", requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, responses: { 200: { description: "Record" }, 400: err } } },
      "/health": { get: { summary: "Liveness", responses: { 200: { description: "ok" } } } },
      "/ready": { get: { summary: "Readiness (503 while shutting down or overloaded)", responses: { 200: { description: "ready" }, 503: { description: "not ready" } } } },
    },
  };
}
