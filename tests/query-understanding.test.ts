import { describe, expect, it, vi } from "vitest";
import { parseDates, understandQuery } from "../src/query/understand.js";

const now = new Date("2026-10-30T00:00:00Z");
const u = (q: string, previous?: ReturnType<typeof understandQuery>) => understandQuery(q, { now, previous });

describe("query understanding", () => {
  it("reads the whole question into action, topic, publisher, country, dates and type", () => {
    const p = u("find indian government documents about artificial intelligence created between 2020 and 2025.");
    expect(p.operations[0].intent).toBe("discover");
    expect(p.topic.phrase).toBe("artificial intelligence");
    expect(p.constraints.publisher).toMatchObject({ category: "government", country: "IN", strength: "hard", mode: "published_by", basis: "stated" });
    expect(p.constraints.publisher!.hostSuffixes).toEqual(["gov.in", "nic.in"]);
    expect(p.constraints.geography?.code).toBe("IN");
    expect(p.constraints.dates).toMatchObject({ from: 2020, to: 2025, strength: "hard" });
    expect(p.constraints.types?.label).toBe("documents");
    expect(p.entities.map((e) => e.type)).toEqual(expect.arrayContaining(["country", "organization_category", "topic", "date_range", "document_type"]));
    expect(p.relationships).toContainEqual(expect.objectContaining({ predicate: "published_by", basis: "stated" }));
  });

  it("expands abbreviations as hypotheses and keeps related concepts as candidates, not substitutes", () => {
    const p = u("find indian gov ai docs from 2020 to 2025.");
    expect(p.topic.phrase).toBe("artificial intelligence");
    expect(p.constraints.dates).toMatchObject({ from: 2020, to: 2025 });
    expect(p.expansions).toContainEqual(expect.objectContaining({ term: "ai", relation: "abbreviation", basis: "inferred" }));
    expect(p.expansions.map((e) => e.term)).toEqual(expect.arrayContaining(["machine learning", "national ai strategy"]));
    expect(p.searchTerms).toEqual(["artificial", "intelligence"]);
  });

  it("tells 'documents about the government' from 'documents published by the government'", () => {
    const about = u("find documents about indian government artificial intelligence.");
    const by = u("find artificial intelligence documents published by the indian government.");
    expect(about.constraints.publisher).toMatchObject({ mode: "associated_with", strength: "soft" });
    expect(by.constraints.publisher).toMatchObject({ mode: "published_by", strength: "hard" });
  });

  it("finds several operations, languages, exclusions and requested outputs in one sentence", () => {
    const p = u("find original ai research documents published by indian government agencies between 2020 and 2025, including hindi publications, exclude news articles and private companies, and show which agencies funded the research.");
    expect(p.operations.map((o) => o.intent)).toEqual(["discover", "relationships"]);
    expect(p.outputs).toContain("funders");
    expect(p.constraints.languages).toMatchObject({ codes: ["en", "hi"], strength: "soft" });
    expect(p.constraints.exclude.map((e) => e.what)).toEqual(["news", "private companies"]);
    expect(p.constraints.quality).toBe("original");
    expect(p.relationships).toContainEqual(expect.objectContaining({ subject: "agency", predicate: "funded_by", object: "research" }));
  });

  it("carries a conversation forward: narrowing, exclusions and corrections modify the earlier search", () => {
    const a = u("find indian government ai documents.");
    const b = u("only between 2020 and 2025.", a);
    expect(b.context).toMatchObject({ refines: true, kind: "narrow" });
    expect(b.topic.phrase).toBe("artificial intelligence");
    expect(b.constraints.publisher?.country).toBe("IN");
    expect(b.constraints.dates).toMatchObject({ from: 2020, to: 2025 });
    const c = u("now exclude reports from private companies.", b);
    expect(c.constraints.exclude.map((e) => e.what)).toEqual(["private companies"]);
    expect(c.constraints.publisher?.category).toBe("government");
    expect(c.constraints.dates).toMatchObject({ from: 2020, to: 2025 });
    const d = u("no, i meant 2022", c);
    expect(d.context.kind).toBe("correct");
    expect(d.constraints.dates).toMatchObject({ from: 2022, to: 2022 });
    expect(d.topic.phrase).toBe("artificial intelligence");
    expect(d.constraints.exclude.map((e) => e.what)).toEqual(["private companies"]);
  });

  it("recognises comparisons, counts, acronyms and relative dates, and says what it guessed", () => {
    const cmp = u("compare india and china's ai policies");
    expect(cmp.operations[0].intent).toBe("compare");
    expect(cmp.constraints.geography).toBeUndefined();
    expect(cmp.topic.phrase).toBe("artificial intelligence policies");
    const isro = u("how many reports were published by ISRO last year?");
    expect(isro.operations.map((o) => o.intent)).toContain("aggregate");
    expect(isro.constraints.publisher).toMatchObject({ organization: "Indian Space Research Organisation", hostSuffixes: ["isro.gov.in"] });
    expect(isro.constraints.dates).toMatchObject({ from: 2025, to: 2025, strength: "soft", basis: "inferred" });
    expect(isro.uncertain.join(" ")).toMatch(/last year/);
  });

  it("detects script and language, and keeps quoted phrases exact", () => {
    expect(u("भारत सरकार कृत्रिम बुद्धिमत्ता").language).toEqual({ code: "hi", script: "Devanagari" });
    expect(u('find "national strategy for artificial intelligence" pdf').exactPhrases).toEqual(["national strategy for artificial intelligence"]);
    expect(u("find reports pdf only").constraints.types).toMatchObject({ kinds: ["pdf"], strength: "hard" });
  });

  it("parses date expressions into year intervals", () => {
    expect(parseDates("between 2020 and 2025", now)).toMatchObject({ from: 2020, to: 2025 });
    expect(parseDates("since 2021", now)).toMatchObject({ from: 2021, to: 2026 });
    expect(parseDates("before 2019", now)).toMatchObject({ to: 2018 });
    expect(parseDates("in the past 5 years", now)).toMatchObject({ from: 2021, to: 2026, explicit: false });
    expect(parseDates("the 2010s", now)).toMatchObject({ from: 2010, to: 2019 });
    expect(parseDates("no dates here", now)).toBeNull();
  });
});

// The executor, with the index search replaced by recorded-shape results.
const rows = (list: Array<Record<string, unknown>>) => ({ total: list.length, matchQuality: "strong", results: list, tookMs: 1 });
const base = (id: number, host: string, extra: Record<string, unknown> = {}) => ({ resourceId: id, url: `https://${host}/r${id}`, host, title: `Artificial intelligence report ${id}`, kind: "pdf", score: 1, matchedIn: "title", facts: { publisher: [], dates: [], languages: [], funders: [] }, ...extra });
const searchMock = vi.fn();
vi.mock("../src/corpus/search.js", () => ({ searchCorpus: (...a: unknown[]) => searchMock(...a) }));
const { askCorpus, checkResult } = await import("../src/query/execute.js");

describe("search planning and checking", () => {
  const plan = u("find indian government ai documents published between 2020 and 2025 and show which agencies funded them, exclude news");

  it("checks each requirement against the result's own metadata, with evidence", () => {
    const ok = checkResult(base(1, "meity.gov.in", { facts: { publisher: [], dates: [{ field: "temporal.published", value: "2023-05-01" }], languages: [], funders: [] } }) as never, plan);
    expect(ok.find((c) => c.requirement.startsWith("Published by"))).toMatchObject({ verdict: "pass", evidence: "served from meity.gov.in" });
    expect(ok.find((c) => c.requirement.startsWith("Dated"))).toMatchObject({ verdict: "pass" });
    const pdfDate = checkResult(base(2, "niti.gov.in", { facts: { publisher: [], dates: [{ field: "document.created", value: "2015-01-01" }], languages: [], funders: [] } }) as never, plan);
    expect(pdfDate.find((c) => c.requirement.startsWith("Dated"))!.verdict).toBe("unknown");
    const outside = checkResult(base(3, "niti.gov.in", { facts: { publisher: [], dates: [{ field: "temporal.published", value: "2015-01-01" }], languages: [], funders: [] } }) as never, plan);
    expect(outside.find((c) => c.requirement.startsWith("Dated"))!.verdict).toBe("fail");
    const byPage = checkResult(base(4, "example.org", { facts: { publisher: [{ field: "provenance.publisher", value: "Ministry of Electronics, Government of India" }], dates: [], languages: [], funders: [] } }) as never, plan);
    expect(byPage.find((c) => c.requirement.startsWith("Published by"))!.verdict).toBe("pass");
    const news = checkResult(base(5, "timesofindia.indiatimes.com") as never, plan);
    expect(news.find((c) => c.requirement === "Not news")!.verdict).toBe("fail");
    const post = checkResult(base(6, "indiapost.gov.in") as never, plan);
    expect(post.find((c) => c.requirement === "Not news")!.verdict).toBe("pass");
  });

  it("searches the publisher's sites first, widens when too few qualify, drops hard failures and maps funders", async () => {
    searchMock.mockReset();
    searchMock
      .mockResolvedValueOnce(rows([base(1, "meity.gov.in", { facts: { publisher: [], dates: [{ field: "temporal.published", value: "2022" }], languages: [], funders: [{ field: "business.funder", value: "Department of Science and Technology", method: "funding sentence" }] } })]))
      .mockResolvedValue(rows([base(7, "example.com"), base(8, "news.example.com"), base(9, "data.gov.in", { facts: { publisher: [], dates: [{ field: "temporal.published", value: "2019" }], languages: [], funders: [] } })]));
    const res = await askCorpus({} as never, plan, { limit: 10 });
    expect(searchMock.mock.calls[0][2]).toMatchObject({ hosts: ["gov.in", "nic.in"] });
    expect(res.evaluation.revisions.join(" ")).toMatch(/related terms/);
    expect(res.evaluation.revisions.join(" ")).toMatch(/beyond the publisher's sites/);
    expect(res.results.map((r) => r.resourceId)).toEqual([1]);
    expect(res.evaluation).toMatchObject({ verified: 1, rejected: 3 });
    expect(res.outputs.funders).toMatchObject({ found: [{ funder: "Department of Science and Technology", relationship: "funds", documents: [{ resourceId: 1 }] }] });
  });
});

describe("live-run corrections", () => {
  it("does not list country abbreviations as topic terms, and flags ambiguous acronyms", () => {
    expect(u("find climate change reports published by the uk government").expansions.map((e) => e.term)).not.toContain("uk");
    const who = u("find who reports about public health since 2021");
    expect(who.constraints.publisher?.organization).toBe("World Health Organization");
    expect(who.uncertain.join(" ")).toMatch(/Read "who" as World Health Organization/);
    expect(u("who wrote the national ai strategy").constraints.publisher).toBeUndefined();
  });

  it("counts a result as verified only when it is about the topic, and ranks those first", async () => {
    searchMock.mockReset();
    const plan = u("find indian government documents about artificial intelligence");
    searchMock.mockResolvedValue(rows([
      base(1, "ipindia.gov.in", { title: "Annual Report 2022", matchedIn: "text" }),
      base(2, "meity.gov.in", { title: "National Strategy for Artificial Intelligence", matchedIn: "title" }),
    ]));
    const res = await askCorpus({} as never, plan, { limit: 10 });
    expect(res.results.map((r) => r.resourceId)).toEqual([2, 1]);
    expect(res.evaluation).toMatchObject({ verified: 1, partlyVerified: 1 });
  });
});

describe("simple searches", () => {
  it("always searches something: one-word queries that are also structure words keep the typed words", () => {
    for (const q of ["data", "images", "papers", "report", "documents", "china", "india", "nasa", "who", "hello", "news", "the beatles"]) {
      expect(u(q).searchTerms.length, q).toBeGreaterThan(0);
    }
    expect(u("india").searchTerms).toEqual(["india"]);
    expect(u("the beatles").searchTerms).toEqual(["beatles"]);
  });

  it("runs the index search for a one-word query and returns its results", async () => {
    searchMock.mockReset();
    searchMock.mockResolvedValue(rows([base(3, "isro.gov.in", { title: "India space programme", matchedIn: "title" })]));
    const res = await askCorpus({} as never, u("india"), { limit: 10 });
    expect(searchMock).toHaveBeenCalled();
    expect(searchMock.mock.calls[0][1]).toBe("india");
    expect(res.results.length).toBe(1);
  });
});
