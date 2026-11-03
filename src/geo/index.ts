/** Public entry point for the geography registry (used by /api/v2/coverage). */
import { isoEntries } from "./registry.js";
export * from "./registry.js";

/** All 249 ISO 3166-1 entries as { code, name } for coverage reporting. */
export const countries: Array<{ code: string; name: string }> = isoEntries().map((e) => ({ code: e.alpha2, name: e.commonName }));
