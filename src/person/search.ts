/**
 * People search over the collected index: every indexed public page that names the person, read for dated
 * events, ordered as a timeline (by when each page was published, or by when the events it describes happened),
 * and grouped so namesakes with different stated birth years are told apart.
 */
import type { Corpus, SearchCandidate, StoredText } from "../corpus/types.js";
import { fold, parsePersonQuery, type PersonQuery } from "./parse.js";
import { birthAgreement, dateKey, isoOf, maskContacts, nameMatcher, readPage, type BirthFact, type PersonEvent } from "./extract.js";

export const PERSON_LIMITS = { candidatePages: 400, readBatch: 40, budgetMs: 20_000, maxResults: 200, maxEvents: 1000 };

export interface PersonResult {
  id: number;
  url: string;
  host: string;
  title: string;
  /** When the page was published (page metadata), else the server's Last-Modified date; null when neither is known. */
  pageDate: { iso: string; source: "published" | "last-modified" } | null;
  indexedAt: string | null;
  kind: string | null;
  mentions: number;
  inTitle: boolean;
  snippet: string;
  sentences: string[];
  events: PersonEvent[];
  roles: string[];
  match: { location: "match" | "partial" | "missing" | "not-given"; locationFound: string[]; birth: "match" | "conflict" | "unknown" | "not-given"; birthFacts: Array<Omit<BirthFact, "text">>; death: number | null };
  /** "match": consistent with everything given; "possible": nothing contradicts it; "other": a stated birth year disagrees. */
  verdict: "match" | "possible" | "other";
  score: number;
  person: string;
}

export interface PersonOptions {
  order?: "published" | "events" | "relevance";
  dir?: "asc" | "desc";
  limit?: number;
  verdicts?: Array<PersonResult["verdict"]>;
  now?: number;
}

const toIso = (s: string | null | undefined) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Publication dates outside printing-to-next-year (a "1025" typo for 2025, a far-future date) are not dates. */
const plausible = (iso: string | null) => {
  if (!iso) return null;
  const y = +iso.slice(0, 4);
  return y >= 1450 && y <= new Date().getUTCFullYear() + 1 ? iso : null;
};
function pageDate(r: SearchCandidate): PersonResult["pageDate"] {
  const p = plausible(toIso(r.published_at));
  if (p) return { iso: p, source: "published" };
  const lm = plausible(toIso(r.last_modified));
  return lm ? { iso: lm, source: "last-modified" } : null;
}

/** Index terms for a name: the folded words (the full-text index matches words, not phrases). */
const terms = (words: string[]) => [...new Set(words.map((w) => fold(w).replace(/['’]/g, "")).flatMap((w) => w.split(/[-\s]+/)).filter((w) => w.length >= 1))].slice(0, 8);

export async function personSearch(store: Corpus, query: string | PersonQuery, opts: PersonOptions = {}) {
  const t0 = Date.now();
  const q = typeof query === "string" ? parsePersonQuery(query) : query;
  if (!q.tokens.length) throw Object.assign(new Error("Give a name after @human, for example @human Ada Lovelace (London) (1815-12-10)."), { code: "NAME_REQUIRED" });
  const re = nameMatcher(q);
  const nameTerms = terms(q.tokens);
  const timings: Record<string, number> = {};

  // Candidates: pages with every word of the name; then the same with the location words, merged.
  const cand = new Map<number, SearchCandidate>();
  let indexTotal = 0, lowerBound = false;
  const errors: string[] = [];
  const pull = async (words: string[], pages: number) => {
    for (let p = 0; p < pages && cand.size < PERSON_LIMITS.candidatePages; p++) {
      const r = await store.searchResources({ terms: words, limit: 100, offset: p * 100 }).catch((e: Error) => {
        errors.push(`index search (${words.join(" ")}, page ${p + 1}): ${String(e?.message ?? e).slice(0, 160)}`);
        return { rows: [] as SearchCandidate[], total: 0, totalIsLowerBound: false };
      });
      if (words === nameTerms && p === 0) { indexTotal = r.total; lowerBound = !!r.totalIsLowerBound; }
      for (const row of r.rows) if (!row.duplicate_of && !cand.has(row.id)) cand.set(row.id, row);
      if (r.rows.length < 100 || Date.now() - t0 > PERSON_LIMITS.budgetMs / 2) break;
    }
  };
  if (q.locationParts.length) await pull(terms([...q.tokens, ...q.locationParts.flatMap((p) => p.split(/\s+/))]), 1);
  await pull(nameTerms, 4);
  timings.candidates = Date.now() - t0;

  // Read each candidate's stored text; keep pages where the name itself (not just its words) appears.
  const results: PersonResult[] = [];
  const ids = [...cand.keys()];
  let read = 0, truncated = false;
  for (let i = 0; i < ids.length; i += PERSON_LIMITS.readBatch) {
    if (Date.now() - t0 > PERSON_LIMITS.budgetMs) { truncated = true; break; }
    const texts = await store.documentTexts(ids.slice(i, i + PERSON_LIMITS.readBatch)).catch((e: Error) => {
      errors.push(`stored text (${ids.length} pages from ${i}): ${String(e?.message ?? e).slice(0, 160)}`);
      return new Map<number, StoredText>();
    });
    for (const [id, doc] of texts) {
      read++;
      const row = cand.get(id)!;
      const pd = pageDate(row);
      const reading = readPage(doc, q, re, pd ? new Date(pd.iso).getUTCFullYear() : null);
      if (!reading.mentions) continue;
      const birth = q.born ? birthAgreement(q.born, reading.birth) : "not-given";
      // The most specific place given (the first part: "Austin" in "Austin, TX") is what identifies; broader
      // parts alone (only "Texas") are a partial match.
      const location = !q.locationParts.length ? "not-given" : !reading.location.missing.length || reading.location.matched.includes(q.locationParts[0]) ? "match" : reading.location.matched.length ? "partial" : "missing";
      // A stated birth date that disagrees means a namesake; otherwise a page matches when the birthday or the
      // whole location agrees (pages rarely state both), and is only "possible" when neither can be confirmed.
      const given = Boolean(q.born || q.locationParts.length);
      const verdict: PersonResult["verdict"] = birth === "conflict" ? "other" : !given || birth === "match" || location === "match" ? "match" : "possible";
      const score = Math.log2(1 + reading.mentions) * 2 + (reading.inTitle ? 3 : 0) + (location === "match" ? 3 : location === "partial" ? 1 : 0) + (birth === "match" ? 5 : birth === "conflict" ? -12 : 0) + Math.min(2, reading.events.length / 4) + (row.rank ?? 0);
      const title = maskContacts(doc.title || row.title || row.url).text;
      results.push({
        id, url: row.url, host: row.host, title, pageDate: pd, indexedAt: toIso(row.indexed_at), kind: row.kind,
        mentions: reading.mentions, inTitle: reading.inTitle, snippet: reading.sentences[0] ?? maskContacts(row.snippet ?? doc.description ?? "").text,
        sentences: reading.sentences, events: reading.events, roles: reading.roles,
        match: { location, locationFound: reading.location.matched, birth, birthFacts: reading.birth.map(({ text: _t, ...f }) => f), death: reading.death?.y ?? null },
        verdict, score: Number(score.toFixed(3)), person: "",
      });
    }
  }
  timings.read = Date.now() - t0 - timings.candidates;

  // Namesakes: pages that state a birth year are clustered by it (±1 for ages); the rest join the cluster
  // their location agrees with, else stay "unattributed".
  const people = clusterPeople(results, q);

  const verdictFilter = opts.verdicts?.length ? new Set(opts.verdicts) : null;
  const kept = verdictFilter ? results.filter((r) => verdictFilter.has(r.verdict)) : results;
  const order = opts.order ?? "published";
  const dir = opts.dir ?? (order === "relevance" ? "desc" : "asc");
  const sign = dir === "asc" ? 1 : -1;
  const pageKey = (r: PersonResult) => (r.pageDate ? Date.parse(r.pageDate.iso) : null);
  const sorted = [...kept].sort((a, b) => {
    if (order === "relevance") return sign * (a.score - b.score) || a.id - b.id;
    if (order === "events") {
      const ea = a.events.length ? (dir === "asc" ? Math.min(...a.events.map((e) => e.sortKey)) : Math.max(...a.events.map((e) => e.sortKey))) : null;
      const eb = b.events.length ? (dir === "asc" ? Math.min(...b.events.map((e) => e.sortKey)) : Math.max(...b.events.map((e) => e.sortKey))) : null;
      if (ea === null || eb === null) return ea === eb ? b.score - a.score : ea === null ? 1 : -1;
      return sign * (ea - eb) || b.score - a.score;
    }
    const pa = pageKey(a), pb = pageKey(b);
    if (pa === null || pb === null) return pa === pb ? b.score - a.score : pa === null ? 1 : -1; // undated pages last
    return sign * (pa - pb) || b.score - a.score;
  });
  const limit = Math.min(opts.limit ?? 50, PERSON_LIMITS.maxResults);
  const page = sorted.slice(0, limit);

  // The timeline of events across every kept page (not only the returned page of results), deduplicated by
  // date and wording, with each event citing the pages that state it.
  const byKey = new Map<string, { date: PersonEvent["date"]; kind: string; text: string; sortKey: number; sources: Array<{ id: number; url: string; host: string; title: string; verdict: PersonResult["verdict"]; person: string }> }>();
  for (const r of kept) for (const e of r.events) {
    const k = `${e.date.iso}|${e.text.toLowerCase().replace(/\W+/g, " ").slice(0, 100)}`;
    const src = { id: r.id, url: r.url, host: r.host, title: r.title, verdict: r.verdict, person: r.person };
    const cur = byKey.get(k);
    if (cur) { if (!cur.sources.some((s) => s.id === r.id)) cur.sources.push(src); }
    else byKey.set(k, { date: e.date, kind: e.kind, text: e.text, sortKey: e.sortKey, sources: [src] });
  }
  const timeline = [...byKey.values()].sort((a, b) => sign * (a.sortKey - b.sortKey) || b.sources.length - a.sources.length).slice(0, PERSON_LIMITS.maxEvents);
  const pagesTimeline = kept.filter((r) => r.pageDate).sort((a, b) => sign * (Date.parse(a.pageDate!.iso) - Date.parse(b.pageDate!.iso)))
    .map((r) => ({ date: r.pageDate!.iso.slice(0, 10), source: r.pageDate!.source, id: r.id, url: r.url, host: r.host, title: r.title, verdict: r.verdict, person: r.person }));

  const years = timeline.map((e) => e.date.y);
  const kinds: Record<string, number> = {};
  for (const e of timeline) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const hosts: Record<string, number> = {};
  for (const r of kept) hosts[r.host] = (hosts[r.host] ?? 0) + 1;
  return {
    query: { raw: q.raw, name: q.name, location: q.location, locationParts: q.locationParts, born: q.born ? { ...q.born, iso: isoOf(q.born) } : null, warnings: q.warnings },
    syntax: "@human Name (location) (birthday) — location and birthday are optional; dates such as 1985-03-02, March 2 1985 or 1985.",
    order, dir,
    summary: {
      pages: kept.length,
      matching: results.filter((r) => r.verdict === "match").length,
      possible: results.filter((r) => r.verdict === "possible").length,
      otherPeople: results.filter((r) => r.verdict === "other").length,
      events: timeline.length,
      span: years.length ? { from: Math.min(...years), to: Math.max(...years) } : null,
      kinds,
      hosts: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([host, n]) => ({ host, pages: n })),
      undatedPages: kept.filter((r) => !r.pageDate).length,
    },
    people,
    results: page,
    timeline,
    pagesTimeline,
    coverage: {
      indexPagesWithNameWords: indexTotal, indexTotalIsLowerBound: lowerBound, candidatesRead: read, candidates: cand.size, truncated, errors,
      note: "Searches the pages Void's crawlers have collected. Pages are matched on the whole name as written (first and last name, with a middle name or initial allowed), not on scattered words.",
    },
    privacy: "Only public pages already in the index. Email addresses, phone numbers, street addresses and ID numbers are hidden in everything shown.",
    tookMs: Date.now() - t0,
    ms: timings,
  };
}

function clusterPeople(results: PersonResult[], q: PersonQuery) {
  type Group = { id: string; label: string; birthYear: number | null; pages: number; ids: number[]; locations: Set<string>; roles: Set<string>; matchesQuery: boolean };
  const groups: Group[] = [];
  // Stated birth dates found the groups; birth years worked out from an age (±1) then join the nearest one.
  const statedFirst = (r: PersonResult) => (r.match.birthFacts.some((f) => f.how === "stated") ? 0 : 1);
  const stated = results.filter((r) => r.match.birthFacts.length).sort((a, b) => statedFirst(a) - statedFirst(b));
  for (const r of stated) {
    const f = r.match.birthFacts.find((x) => x.how === "stated") ?? r.match.birthFacts[0];
    let g = groups.find((x) => x.birthYear !== null && f.yMin <= x.birthYear + 1 && f.yMax >= x.birthYear - 1);
    if (!g) {
      g = { id: `born-${f.y}`, label: `${q.name}, born ${f.y}${f.how === "age" ? " (from a stated age)" : ""}`, birthYear: f.y, pages: 0, ids: [], locations: new Set(), roles: new Set(), matchesQuery: q.born ? Math.abs(q.born.y - f.y) <= (f.how === "age" ? 1 : 0) : false };
      groups.push(g);
    }
    g.pages++;
    g.ids.push(r.id);
    r.match.locationFound.forEach((l) => g!.locations.add(l));
    r.roles.forEach((x) => g!.roles.add(x));
    r.person = g.id;
  }
  const rest: Group = { id: "unattributed", label: `${q.name} — pages that do not say which ${q.name} they mean`, birthYear: null, pages: 0, ids: [], locations: new Set(), roles: new Set(), matchesQuery: false };
  for (const r of results) {
    if (r.person) continue;
    // A page with no birth facts goes with the searched person's group when the given location agrees.
    const target = r.match.location === "match" ? groups.find((g) => g.matchesQuery) : undefined;
    const g = target ?? rest;
    g.pages++;
    g.ids.push(r.id);
    r.roles.forEach((x) => g.roles.add(x));
    r.person = g.id;
  }
  if (rest.pages) groups.push(rest);
  return {
    distinctBirthYears: groups.filter((g) => g.birthYear !== null).length,
    note: groups.filter((g) => g.birthYear !== null).length > 1 ? `Pages give ${groups.filter((g) => g.birthYear !== null).length} different birth years: at least that many people share this name.` : null,
    groups: groups.map((g) => ({ id: g.id, label: g.label, birthYear: g.birthYear, pages: g.pages, matchesQuery: g.matchesQuery, locations: [...g.locations].slice(0, 6), roles: [...g.roles].slice(0, 6), resultIds: g.ids.slice(0, 200) })),
  };
}

export { dateKey };
