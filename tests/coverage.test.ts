import { describe, expect, it } from "vitest";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import { CATEGORIES } from "../src/metadata/categories.js";
import { fixtureCorpus } from "./fixtures/corpus.js";

describe("41-category coverage", () => {
  it("every category is extracted (state=found) from at least one real fixture, offline", async () => {
    const found = new Map<number, string[]>();
    for (const { name, res } of await fixtureCorpus()) {
      const r = await analyzeResponse(res, { sourceType: "url", enrich: false });
      expect(r.quality.extractorErrors, name).toEqual([]);
      for (const c of r.categories) if (c.state === "observed") found.set(c.id, [...(found.get(c.id) ?? []), name]);
    }
    const missing = CATEGORIES.filter((c) => !found.has(c.id)).map((c) => `${c.id} ${c.key}`);
    expect(missing).toEqual([]);
  });
});
