import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { backends } from "./helpers/backends.js";
import type { Corpus } from "../src/corpus/types.js";
import type { ResourceRecord } from "../src/metadata/types.js";
import { parseBirthday, parsePersonQuery, splitLocation, fold } from "../src/person/parse.js";
import { birthAgreement, findDates, maskContacts, nameMatcher, readPage } from "../src/person/extract.js";
import { personSearch } from "../src/person/search.js";
import { registerPersonRoutes } from "../src/http/person-routes.js";
// @ts-expect-error plain ES module shared with the live runner
import { QUESTIONS, checkAnswer, urlFor } from "../scripts/person-questions.mjs";

describe("person query syntax", () => {
  it("reads @human Name (location) (birthday) in any order", () => {
    const a = parsePersonQuery("@human Maria Delgado (Austin, TX) (1984-06-12)");
    expect(a.name).toBe("Maria Delgado");
    expect(a.location).toBe("Austin, TX");
    expect(a.locationParts).toEqual(["austin", "texas"]);
    expect(a.born).toMatchObject({ y: 1984, m: 6, d: 12, precision: "day" });
    const b = parsePersonQuery("@human Maria Delgado (June 12, 1984) (Austin TX)");
    expect(b.born).toMatchObject({ y: 1984, m: 6, d: 12 });
    expect(b.locationParts).toEqual(["austin", "texas"]);
  });
  it("location and birthday are optional", () => {
    const q = parsePersonQuery("@human Maria Delgado");
    expect(q).toMatchObject({ name: "Maria Delgado", location: null, born: null });
    expect(parsePersonQuery("@human Maria Delgado (1984)").born).toMatchObject({ y: 1984, precision: "year" });
    expect(parsePersonQuery("@human Maria Delgado (Lisbon)").location).toBe("Lisbon");
  });
  it("accepts plain forms: commas, 'born', 'from'", () => {
    expect(parsePersonQuery("@human Maria Delgado, Austin, born 1984")).toMatchObject({ name: "Maria Delgado", location: "Austin", born: { y: 1984 } });
    expect(parsePersonQuery("@human Maria Delgado from Lisbon")).toMatchObject({ name: "Maria Delgado", location: "Lisbon" });
    expect(parsePersonQuery("@person Dr. Maria Delgado Jr.").name).toBe("Maria Delgado");
  });
  it("reads many birthday formats and rejects impossible dates", () => {
    expect(parseBirthday("12 June 1984")).toMatchObject({ y: 1984, m: 6, d: 12 });
    expect(parseBirthday("Jun 12th, 1984")).toMatchObject({ y: 1984, m: 6, d: 12 });
    expect(parseBirthday("25/12/1990")).toMatchObject({ y: 1990, m: 12, d: 25 });
    expect(parseBirthday("03/04/1990")).toMatchObject({ m: 3, d: 4, ambiguous: true });
    expect(parseBirthday("June 1984")).toMatchObject({ y: 1984, m: 6, precision: "month" });
    expect(parseBirthday("born 1984")).toMatchObject({ y: 1984 });
    expect(parseBirthday("1984-02-30")).toBeNull();
    expect(parseBirthday("3000")).toBeNull();
    expect(parseBirthday("Austin")).toBeNull();
  });
  it("warns about one-word names and unreadable birthdays", () => {
    expect(parsePersonQuery("@human Delgado").warnings.join(" ")).toMatch(/Only one name/);
    expect(parsePersonQuery("@human Maria Delgado", { born: "someday" }).warnings.join(" ")).toMatch(/not a date of birth/);
  });
  it("keeps names in any script and folds accents for matching", () => {
    expect(parsePersonQuery("@human José Núñez").tokens).toEqual(["José", "Núñez"]);
    expect(fold("José Núñez")).toBe("jose nunez");
    expect(parsePersonQuery("@human 山田 太郎").tokens).toEqual(["山田", "太郎"]);
    expect(splitLocation("São Paulo, Brazil")).toEqual(["sao paulo", "brazil"]);
  });
});

describe("person page reading", () => {
  const q = parsePersonQuery("@human Maria Delgado (Austin, TX) (1984)");
  const re = nameMatcher(q);
  const has = (s: string) => { re.lastIndex = 0; return re.test(fold(s)); };
  it("matches the name as a name, not scattered words", () => {
    expect(has("Maria Delgado spoke")).toBe(true);
    expect(has("Delgado, Maria")).toBe(true);
    expect(has("María Delgado")).toBe(true);
    expect(has("Maria E. Delgado")).toBe(true);
    expect(has("M. Delgado")).toBe(true);
    expect(has("Maria Delgadoson")).toBe(false);
    expect(has("Maria went to see Delgado")).toBe(false);
  });
  it("finds dates in many formats, not counts or prices", () => {
    const d = findDates("On March 3, 2015 she moved; in 2019 and on 2021-07-04, also 12 May 2010 and May 2008. It sold 2000 copies for $1999.");
    expect(d.map((x) => x.text)).toEqual(["March 3, 2015", "2019", "2021-07-04", "12 May 2010", "May 2008"]);
  });
  it("reads events, birth facts, location and masks contact details", () => {
    const body = "Maria Delgado (born June 12, 1984) is an engineer from Austin, Texas. In 2006 Maria Delgado graduated from the University of Texas. She joined Acme in March 2010. Call her at (512) 555-0199 or maria@example.com; she lives at 1200 Oak Hill Drive. Unrelated sentence from 1999.";
    const r = readPage({ title: "Profile", description: "", body }, q, re, 2024);
    expect(r.mentions).toBe(2);
    expect(r.birth[0]).toMatchObject({ y: 1984, m: 6, d: 12, how: "stated" });
    expect(r.location).toEqual({ matched: ["austin", "texas"], missing: [] });
    expect(r.events.map((e) => [e.date.iso, e.kind])).toEqual(expect.arrayContaining([["1984-06-12", "birth"], ["2006", "education"], ["2010-03", "career"]]));
    expect(r.events.some((e) => e.date.iso === "1999")).toBe(false);
    const all = JSON.stringify(r);
    expect(all).not.toMatch(/555-0199|maria@example\.com|1200 Oak Hill/);
    expect(r.roles).toContain("engineer");
  });
  it("derives a birth year from a stated age on a dated page", () => {
    const r = readPage({ title: "", description: "", body: "Maria Delgado, 39, of Austin was named director." }, q, re, 2023);
    expect(r.birth[0]).toMatchObject({ how: "age", yMin: 1983, yMax: 1984 });
    expect(birthAgreement(q.born, r.birth)).toBe("match");
    expect(birthAgreement(parsePersonQuery("@human Maria Delgado (1970)").born, r.birth)).toBe("unknown");
    expect(birthAgreement(parsePersonQuery("@human Maria Delgado (1970)").born, [{ y: 1984, how: "stated", yMin: 1984, yMax: 1984, text: "" }])).toBe("conflict");
  });
  it("reads a lifespan after the name as birth and death", () => {
    const r = readPage({ title: "", description: "", body: "Maria Delgado (1931–2010) taught music in Seville." }, q, re, 2010);
    expect(r.birth[0]).toMatchObject({ y: 1931, how: "stated" });
    expect(r.death).toMatchObject({ y: 2010 });
    expect(r.events.map((e) => [e.date.iso, e.kind])).toEqual([["1931", "birth"], ["2010", "death"]]);
  });
  it("follows surname-only sentences on pages that name the person in full, but not street names", () => {
    const r = readPage({ title: "", description: "", body: "Maria Delgado won in 2019. Delgado retired in 2022. Delgado Street was repaved in 2020. A delgado fish was caught in 2018." }, q, re, 2023);
    expect(r.events.map((e) => [e.date.iso, e.via])).toEqual([["2019", "name"], ["2022", "surname"]]);
    const none = readPage({ title: "", description: "", body: "Delgado retired in 2022." }, q, re, 2023);
    expect(none.events).toEqual([]);
  });
  it("shows long unpunctuated text as a window around the name and around each date", () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    const body = `${filler(150)} the 2011 report thanks Maria Delgado for her review of chapter four ${filler(55)} published in 1999 ${filler(40)}`;
    const r = readPage({ title: "", description: "", body }, q, re, 2012);
    expect(r.sentences[0]).toContain("Maria Delgado");
    expect(r.sentences[0].length).toBeLessThanOrEqual(422);
    expect(r.sentences[0].startsWith("…")).toBe(true);
    const e1999 = r.events.find((e) => e.date.iso === "1999")!;
    expect(e1999.text).toContain("1999");
    expect(r.events.find((e) => e.date.iso === "2011")!.text).toContain("Maria Delgado");
  });
  it("masks phone numbers but not year ranges", () => {
    expect(maskContacts("Call +1 512 555 0199 today").text).toBe("Call [phone hidden] today");
    expect(maskContacts("Served 1998-2004 as mayor").text).toBe("Served 1998-2004 as mayor");
    expect(maskContacts("SSN 123-45-6789").text).toBe("SSN [ID number hidden]");
  });
});

// ---------------------------------------------------------------- end to end over a real store

function record(url: string, title: string): ResourceRecord {
  return { url, finalUrl: url, title, description: null, kind: "webpage", mimeType: "text/html", httpStatus: 200, fetchedAt: new Date().toISOString(), contentHash: url, fields: [], relationships: [], categories: [], processing: { extractors: [], timings: { extractors: [], totalMs: 0 } }, quality: { extractorErrors: [] } } as unknown as ResourceRecord;
}

const PAGES: Array<{ url: string; title: string; body: string; published: string | null }> = [
  { url: "https://news.example.org/2010/delgado-joins", title: "Austin engineer joins Acme", published: "2010-03-15", body: "Maria Delgado, 25, of Austin joined Acme Robotics in March 2010 as an engineer. She graduated in 2006." },
  { url: "https://uni.example.edu/alumni/delgado", title: "Alumni profile: Maria Delgado", published: "2016-05-01", body: "Maria Delgado (born June 12, 1984) grew up in Austin, Texas. In 2006 Maria Delgado earned a degree in mechanical engineering. Contact: maria.d@example.edu" },
  { url: "https://awards.example.org/2019", title: "2019 innovation awards", published: "2019-11-20", body: "The 2019 award went to Maria Delgado of Austin for her robotics work. Maria Delgado said the team deserved it." },
  { url: "https://lisbon.example.pt/artes/delgado", title: "Pintora Maria Delgado", published: "2012-02-02", body: "Maria Delgado (born 1951) is a painter from Lisbon. In 1975 Maria Delgado held her first exhibition." },
  { url: "https://blog.example.net/undated", title: "Notes", published: null, body: "Yesterday I read about Maria Delgado and robotics." },
  { url: "https://noise.example.com/scatter", title: "Maria and friends", published: "2015-01-01", body: "Maria went to the market. Later, Delgado Street was closed." },
];

for (const make of backends()) {
  const b = make();
  describe(`person search end to end [${b.name}]`, () => {
    let store: Corpus;
    beforeAll(async () => {
      store = await b.open();
      const now = Date.now();
      for (const p of PAGES) {
        await store.enqueue([{ url: p.url, priority: 50, depth: 0, via: "test", purpose: "discovery" as const }], now);
        const row = (await store.lease(1, 60_000, now, "generalist"))[0];
        if (!row) continue;
        await store.saveSnapshot(row.id, record(p.url, p.title), { text: p.body, changedFields: null, index: true });
        await store.finish(row.id, "indexed", now + 86_400_000, { indexed_at: new Date(now).toISOString(), title: p.title, published_at: p.published } as never);
      }
    }, 60_000);
    afterAll(async () => {
      await store?.close();
      await b.dispose();
    });

    it("finds only pages that name the person, ordered by page date with undated last", async () => {
      const r = await personSearch(store, "@human Maria Delgado");
      expect(r.results.map((x) => x.url)).not.toContain("https://noise.example.com/scatter");
      expect(r.summary.pages).toBe(5);
      const dates = r.results.map((x) => x.pageDate?.iso.slice(0, 10) ?? null);
      expect(dates).toEqual(["2010-03-15", "2012-02-02", "2016-05-01", "2019-11-20", null]);
      const desc = await personSearch(store, "@human Maria Delgado", { dir: "desc" });
      expect(desc.results[0].pageDate?.iso.slice(0, 10)).toBe("2019-11-20");
    });

    it("tells namesakes apart by stated birth years", async () => {
      const r = await personSearch(store, "@human Maria Delgado");
      expect(r.people.distinctBirthYears).toBe(2);
      expect(r.people.note).toMatch(/2 different birth years/);
      const years = r.people.groups.map((g) => g.birthYear).filter(Boolean).sort();
      expect(years).toEqual([1951, 1984]);
    });

    it("uses location and birthday to separate the right person from others", async () => {
      const r = await personSearch(store, "@human Maria Delgado (Austin, TX) (1984-06-12)");
      const byUrl = Object.fromEntries(r.results.map((x) => [x.url, x.verdict]));
      expect(byUrl["https://uni.example.edu/alumni/delgado"]).toBe("match");
      expect(byUrl["https://news.example.org/2010/delgado-joins"]).toBe("match");
      expect(byUrl["https://awards.example.org/2019"]).toBe("match");
      expect(byUrl["https://lisbon.example.pt/artes/delgado"]).toBe("other");
      expect(byUrl["https://blog.example.net/undated"]).toBe("possible");
      const only = await personSearch(store, "@human Maria Delgado (Austin, TX) (1984-06-12)", { verdicts: ["match"] });
      expect(only.results.every((x) => x.verdict === "match")).toBe(true);
    });

    it("orders the events of the person's life as a timeline, citing sources", async () => {
      const r = await personSearch(store, "@human Maria Delgado (Austin) (1984)", { order: "events", verdicts: ["match"] });
      const t = r.timeline.map((e) => [e.date.iso, e.kind]);
      expect(t[0]).toEqual(["1984-06-12", "birth"]);
      const keys = r.timeline.map((e) => e.sortKey);
      expect([...keys].sort((a, b) => a - b)).toEqual(keys);
      expect(t).toEqual(expect.arrayContaining([["2006", "education"], ["2010-03", "career"], ["2019", "award"]]));
      expect(r.timeline.every((e) => e.sources.length >= 1 && e.sources.every((s) => s.verdict === "match"))).toBe(true);
      expect(r.timeline.some((e) => e.date.y === 1975)).toBe(false);
      expect(r.summary.span).toEqual({ from: 1984, to: 2019 });
    });

    it("never returns contact details", async () => {
      const r = await personSearch(store, "@human Maria Delgado");
      expect(JSON.stringify(r)).not.toMatch(/maria\.d@example\.edu/);
    });

    it("answers all 100 test questions within every rule", async () => {
      process.env.PERSON_SEARCH_PER_HOUR = "1000";
      const app = Fastify();
      registerPersonRoutes(app, { store, topicalDiscovery: false });
      delete process.env.PERSON_SEARCH_PER_HOUR;
      const failures: string[] = [];
      for (const question of QUESTIONS as Array<{ id: number; q: string }>) {
        const u = urlFor("http://local", "/api/v2/person", question);
        const res = await app.inject({ url: u.pathname + u.search });
        const fail = checkAnswer(question, res.statusCode, res.json()) as string[];
        if (fail.length) failures.push(`#${question.id} ${question.q}: ${fail.join("; ")}`);
      }
      expect(QUESTIONS).toHaveLength(100);
      expect(failures).toEqual([]);
      await app.close();
    }, 120_000);

    it("serves the HTTP route with validation, parsing and caching", async () => {
      const app = Fastify();
      registerPersonRoutes(app, { store, topicalDiscovery: false });
      const ok = await app.inject({ url: "/api/v2/person?q=" + encodeURIComponent("@human Maria Delgado (Lisbon) (1951)") + "&order=events" });
      expect(ok.statusCode).toBe(200);
      const j = ok.json();
      expect(j.query).toMatchObject({ name: "Maria Delgado", location: "Lisbon", born: { y: 1951 } });
      expect(j.results.find((x: { url: string }) => x.url.includes("lisbon")).verdict).toBe("match");
      expect(j.timeline[0].date.iso).toBe("1951");
      const again = await app.inject({ url: "/api/v2/person?q=" + encodeURIComponent("@human Maria Delgado (Lisbon) (1951)") + "&order=events" });
      expect(again.headers["x-person-cache"]).toBe("hit");
      expect((await app.inject({ url: "/api/v2/person?q=%40human" })).statusCode).toBe(400);
      expect((await app.inject({ url: "/api/v2/person?name=Maria%20Delgado&born=1951&order=sideways" })).statusCode).toBe(400);
      const fields = await app.inject({ url: "/api/v2/person?name=Maria%20Delgado&location=Lisbon&born=1951" });
      expect(fields.json().query).toMatchObject({ name: "Maria Delgado", location: "Lisbon" });
      await app.close();
    });
  });
}
