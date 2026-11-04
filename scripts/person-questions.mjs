#!/usr/bin/env node
// 100 people-search questions (tests/fixtures/person-questions.json) and the rules every answer must keep.
// Usage: node scripts/person-questions.mjs <base-url> [api-path]
//   base-url  e.g. https://omnispider-production.up.railway.app (api path /api/v2/person)
//             or https://asherinvoid.vercel.app with api path /api/person (through Void)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const QUESTIONS = JSON.parse(readFileSync(new URL("../tests/fixtures/person-questions.json", import.meta.url), "utf8"));

const fold = (s) => [...String(s ?? "")].map((c) => { const f = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(); return f.length === c.length ? f : c; }).join("").replace(/[’‘]/g, "'");
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(\d{3}\)[\s.-]?\d{3}[\s.-]\d{4}\b/;

/** Every rule an answer must keep. Returns the broken ones (empty = pass). */
export function checkAnswer(question, status, body) {
  const fail = [];
  const e = question.expect;
  if (status !== e.status) return [`status ${status}, expected ${e.status}${body?.message ? ` (${body.message})` : ""}`];
  if (status !== 200) return body?.error ? [] : ["error response without an error code"];
  const q = body.query ?? {};
  // 1. Parsing.
  // Answers are cached case-insensitively, so the echoed name may differ from the question only in case.
  if (e.name !== undefined && String(q.name).toLowerCase() !== e.name.toLowerCase()) fail.push(`name parsed as "${q.name}", expected "${e.name}"`);
  if (e.location !== undefined && q.location !== e.location) fail.push(`location parsed as "${q.location}", expected "${e.location}"`);
  if (e.location === undefined && e.status === 200 && q.location) fail.push(`unexpected location "${q.location}"`);
  if (e.bornYear !== undefined && q.born?.y !== e.bornYear) fail.push(`birth year parsed as ${q.born?.y}, expected ${e.bornYear}`);
  if (e.bornYear === undefined && q.born) fail.push(`unexpected birthday ${q.born.text}`);
  // 2. Shape.
  for (const k of ["summary", "people", "results", "timeline", "pagesTimeline", "coverage", "privacy"]) if (body[k] === undefined) fail.push(`missing ${k}`);
  if (fail.length) return fail;
  const order = question.order ?? "published", dir = question.dir ?? (order === "relevance" ? "desc" : "asc"), sign = dir === "asc" ? 1 : -1;
  if (body.order !== order || body.dir !== dir) fail.push(`answered in ${body.order}/${body.dir}, asked ${order}/${dir}`);
  // 3. Ordering.
  if (order === "published") {
    let seenNull = false, prev = null;
    for (const r of body.results) {
      if (!r.pageDate) { seenNull = true; continue; }
      if (seenNull) { fail.push("a dated page comes after an undated one"); break; }
      const t = Date.parse(r.pageDate.iso);
      if (prev !== null && sign * (t - prev) < 0) { fail.push(`pages out of ${dir} date order at ${r.pageDate.iso}`); break; }
      prev = t;
    }
  }
  if (order === "relevance") for (let i = 1; i < body.results.length; i++) if (sign * (body.results[i].score - body.results[i - 1].score) < 0) { fail.push("results out of relevance order"); break; }
  for (let i = 1; i < body.timeline.length; i++) if (sign * (body.timeline[i].sortKey - body.timeline[i - 1].sortKey) < 0) { fail.push(`timeline out of ${dir} order at ${body.timeline[i].date.iso}`); break; }
  for (let i = 1; i < body.pagesTimeline.length; i++) if (sign * (Date.parse(body.pagesTimeline[i].date) - Date.parse(body.pagesTimeline[i - 1].date)) < 0) { fail.push("pages timeline out of order"); break; }
  // 4. Filters and verdict logic.
  const show = question.show ? question.show.split(",") : null;
  if (show && body.results.some((r) => !show.includes(r.verdict))) fail.push(`a result outside the "${question.show}" filter`);
  for (const r of body.results) {
    if (r.verdict === "other" && r.match.birth !== "conflict") { fail.push(`"other" without a birth conflict: ${r.url}`); break; }
    if (r.match.birth === "conflict" && r.verdict !== "other") { fail.push(`birth conflict not marked other: ${r.url}`); break; }
    if (e.bornYear === undefined && r.match.birth !== "not-given") { fail.push("birth compared although none was given"); break; }
    if (e.location === undefined && r.match.location !== "not-given") { fail.push("location compared although none was given"); break; }
    if (!(r.mentions >= 1)) { fail.push(`result without a mention: ${r.url}`); break; }
  }
  if (!show && body.summary.pages !== body.summary.matching + body.summary.possible + body.summary.otherPeople) fail.push("summary counts do not add up");
  // 5. Every result names the person (surname, accent-folded) in what is shown.
  const last = fold(String(e.name ?? q.name).split(/\s+/).pop());
  for (const r of body.results) {
    const shown = fold([r.title, r.snippet, ...(r.sentences ?? [])].join(" "));
    if (!shown.includes(last)) { fail.push(`result does not show the name: ${r.url}`); break; }
  }
  // 6. Timeline events cite pages; groups cover results.
  if (body.timeline.some((t) => !t.sources?.length)) fail.push("an event without a source");
  const groupIds = new Set((body.people.groups ?? []).map((g) => g.id));
  if (body.results.some((r) => !groupIds.has(r.person))) fail.push("a result outside every person group");
  // 7. Privacy: no contact details anywhere in the answer.
  const all = JSON.stringify({ r: body.results, t: body.timeline });
  if (EMAIL.test(all)) fail.push("an email address in the answer");
  if (PHONE.test(all)) fail.push("a phone number in the answer");
  // 8. Speed.
  if (!(body.tookMs < 30_000)) fail.push(`took ${body.tookMs} ms`);
  return fail;
}

export function urlFor(base, path, question) {
  const u = new URL(path, base);
  u.searchParams.set("q", question.q);
  if (question.order) u.searchParams.set("order", question.order);
  if (question.dir) u.searchParams.set("dir", question.dir);
  if (question.show) u.searchParams.set("show", question.show);
  u.searchParams.set("limit", "100");
  return u;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  const path = process.argv[3] ?? "/api/v2/person";
  if (!base) { console.error("usage: node scripts/person-questions.mjs <base-url> [api-path]"); process.exit(2); }
  let passed = 0, withPages = 0, pages = 0, events = 0;
  for (const question of QUESTIONS) {
    const t0 = Date.now();
    let status = 0, body = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(urlFor(base, path, question), { headers: { accept: "application/json", origin: new URL(base).origin } }).catch((err) => ({ status: 0, json: async () => ({ error: String(err) }) }));
      status = res.status;
      body = await res.json().catch(() => null);
      if (status !== 503 && status !== 429) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    const fail = checkAnswer(question, status, body);
    if (!fail.length) passed++;
    if (status === 200) { pages += body.summary.pages; events += body.summary.events; if (body.summary.pages) withPages++; }
    console.log(`${fail.length ? "FAIL" : "ok  "} #${String(question.id).padStart(3)} ${question.q.padEnd(58).slice(0, 58)} ${status === 200 ? `${String(body.summary.pages).padStart(3)} pages ${String(body.summary.events).padStart(4)} events ${String(body.summary.matching).padStart(3)} match` : `status ${status}`.padEnd(30)} ${Date.now() - t0} ms${fail.length ? "\n       " + fail.join("\n       ") : ""}`);
  }
  console.log(`\n${passed}/${QUESTIONS.length} answers keep every rule. ${withPages} questions found pages (${pages} pages, ${events} dated events in total).`);
  process.exit(passed === QUESTIONS.length ? 0 : 1);
}
