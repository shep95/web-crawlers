import { describe, it, expect } from "vitest";
import {
  allowedDomainsFromSeeds,
  loadDomainSeeds,
  resolveDomainSeeds,
} from "../src/core/domain-seeds.js";
import { extractPlainText } from "../src/core/text-extract.js";

describe("domain-seeds", () => {
  it("loads physics and history whitelists", () => {
    const config = loadDomainSeeds(true);
    expect(config.physics?.seeds?.length).toBeGreaterThan(0);
    expect(config.history?.seeds?.some((s) => s.includes("britannica"))).toBe(true);
  });

  it("resolves dotted Aureon paths to subdomain seeds", () => {
    const seeds = resolveDomainSeeds("humanities.history.ancient_history");
    expect(seeds.some((s) => s.includes("worldhistory"))).toBe(true);
  });

  it("derives allowed domains from seeds", () => {
    const allowed = allowedDomainsFromSeeds(resolveDomainSeeds("artificial_intelligence"));
    expect(allowed).toContain("arxiv.org");
    expect(allowed).toContain("paperswithcode.com");
  });
});

describe("text-extract", () => {
  it("strips html to plain text", () => {
    const html = "<html><body><script>x</script><p>Hello   world</p></body></html>";
    expect(extractPlainText(html)).toBe("Hello world");
  });
});
