/**
 * Search planning and checking: runs a QueryPlan against the index, checks every result against each requirement
 * (publisher, dates, type, language, exclusions, topic), revises the search when too few results qualify,
 * and reports what was satisfied, what is unknown and what was rejected — with the evidence for each check.
 */
import type { Corpus } from "../corpus/types.js";
import { searchCorpus, type CorpusSearchOptions } from "../corpus/search.js";
import type { QueryPlan } from "./understand.js";

type Verdict = "pass" | "fail" | "unknown";
export interface Check { requirement: string; strength: "hard" | "soft"; verdict: Verdict; evidence: string }
type Result = Awaited<ReturnType<typeof searchCorpus>>["results"][number];
export type CheckedResult = Result & { checks: Check[]; qualifies: boolean; planScore: number; foundBy: string };

const factText = (list: Array<{ value: unknown }> | undefined) => (list ?? []).map((f) => (typeof f.value === "string" ? f.value : JSON.stringify(f.value))).join(" ");
const hostMatches = (host: string, suffixes: string[]) => suffixes.some((s) => host === s || host.endsWith("." + s));
const GOVERNMENT_WORDS = /\b(?:government|ministry|department|agency|commission|council|authority|directorate|bureau|parliament|national|federal|state|public)\b/i;
const ACADEMIC_WORDS = /\b(?:university|college|institute|school|academy|faculty)\b/i;

function years(r: Result): Array<{ year: number; field: string }> {
  const out: Array<{ year: number; field: string }> = [];
  for (const f of r.facts?.dates ?? []) {
    const m = String(typeof f.value === "string" ? f.value : JSON.stringify(f.value)).match(/\b(19\d{2}|20\d{2})\b/);
    if (m) out.push({ year: Number(m[1]), field: f.field });
  }
  return out;
}

/** Each requirement in the plan, checked against one result's own metadata. */
export function checkResult(r: Result, plan: QueryPlan): Check[] {
  const c = plan.constraints;
  const checks: Check[] = [];
  const host = r.host ?? "";
  const title = (r.title ?? "").toLowerCase();
  if (c.publisher) {
    const pub = factText(r.facts?.publisher);
    const words = c.publisher.category === "government" ? GOVERNMENT_WORDS : c.publisher.category === "academic" ? ACADEMIC_WORDS : null;
    const countryOk = !c.geography || new RegExp(`\\b${c.geography.country}\\b|\\b${c.geography.code}\\b`, "i").test(pub);
    const label = `${c.publisher.mode === "published_by" ? "Published by" : "Associated with"} ${c.publisher.organization ?? `${c.geography ? c.geography.country + " " : ""}${c.publisher.category}`}`;
    let verdict: Verdict, evidence: string;
    if (c.publisher.hostSuffixes.length && hostMatches(host, c.publisher.hostSuffixes)) (verdict = "pass"), (evidence = `served from ${host}`);
    else if (pub && words?.test(pub) && countryOk) (verdict = "pass"), (evidence = `page names its publisher: ${pub.slice(0, 120)}`);
    else if (c.publisher.hostSuffixes.length) (verdict = "fail"), (evidence = `served from ${host || "an unknown site"}${pub ? `; publisher stated as ${pub.slice(0, 80)}` : ""}`);
    else (verdict = "unknown"), (evidence = pub ? `publisher stated as ${pub.slice(0, 80)}` : "no publisher recorded");
    checks.push({ requirement: label, strength: c.publisher.strength, verdict, evidence });
  } else if (c.geography) {
    const place = `${factText(r.facts?.spatialCoverage)} ${factText(r.facts?.publisher)} ${title} ${r.snippet ?? ""}`;
    const country = COUNTRY_TLD[c.geography.code];
    const verdict: Verdict = new RegExp(`\\b${c.geography.country}\\b`, "i").test(place) || (country && host.endsWith(country)) ? "pass" : "unknown";
    checks.push({ requirement: `Related to ${c.geography.country}`, strength: "soft", verdict, evidence: verdict === "pass" ? "named on the page or served from the country's domain" : "no mention found in the recorded metadata" });
  }
  if (c.dates) {
    const ys = years(r);
    const inside = ys.find((y) => y.year >= c.dates!.from && y.year <= c.dates!.to);
    const range = c.dates.from === c.dates.to ? String(c.dates.from) : `${c.dates.from}–${c.dates.to}`;
    // A file's technical creation time is not its publication date: only a published date can rule a result out.
    const published = ys.find((y) => /published|datePublished/i.test(y.field));
    const verdict: Verdict = inside ? "pass" : published ? "fail" : ys.length ? "unknown" : "unknown";
    checks.push({ requirement: `Dated ${range}`, strength: c.dates.strength, verdict, evidence: inside ? `${inside.field.split(".").pop()} ${inside.year}` : ys.length ? `dates found: ${ys.map((y) => `${y.field.split(".").pop()} ${y.year}`).join(", ")}${published ? "" : " (no publication date)"}` : "no date recorded" });
  }
  if (c.types) {
    const ok = c.types.kinds.includes(r.kind ?? "");
    checks.push({ requirement: `Type: ${c.types.label}`, strength: c.types.strength, verdict: ok ? "pass" : "fail", evidence: `this is a ${r.kind ?? "file of unknown type"}` });
  }
  if (c.languages) {
    const langs = factText(r.facts?.languages).toLowerCase();
    const ok = c.languages.codes.some((code) => new RegExp(`\\b${code}(?:-|\\b)`).test(langs));
    checks.push({ requirement: `Language: ${c.languages.codes.join(" or ")}`, strength: c.languages.strength, verdict: langs ? (ok ? "pass" : "fail") : "unknown", evidence: langs ? `declared language ${langs.slice(0, 40)}` : "no language declared" });
  }
  for (const ex of c.exclude) {
    // Public-sector and academic domains are never "news" or "private companies", whatever their names contain.
    const publicSector = /(?:^|\.)(?:gov|govt|gob|gouv|go|nic|edu|ac|int|mil|europa)(?:\.|$)/.test(host);
    const hostHit = !publicSector && !!ex.hostPatterns?.some((p) => (p.startsWith(".") ? host.endsWith(p.replace(/\.$/, "")) || host.includes(p.endsWith(".") ? p : p + ".") : host.includes(p)));
    const hit = !!ex.kinds?.includes(r.kind ?? "") || hostHit || (!!ex.terms?.length && ex.terms.every((t) => title.includes(t)));
    checks.push({ requirement: `Not ${ex.what}`, strength: "hard", verdict: hit ? "fail" : "pass", evidence: hit ? `matches "${ex.what}" (${host})` : "no sign of it" });
  }
  if (plan.topic.terms.length) {
    const about = (r as { matchedIn?: string }).matchedIn === "title";
    checks.push({ requirement: `About ${plan.topic.phrase}`, strength: "soft", verdict: about ? "pass" : "unknown", evidence: about ? "named in the title" : "mentioned in the text" });
  }
  return checks;
}

const COUNTRY_TLD: Record<string, string> = { IN: ".in", GB: ".uk", CA: ".ca", AU: ".au", NZ: ".nz", IE: ".ie", SG: ".sg", CN: ".cn", JP: ".jp", KR: ".kr", DE: ".de", FR: ".fr", ES: ".es", IT: ".it", EU: ".eu", BR: ".br", MX: ".mx", ZA: ".za", NG: ".ng", KE: ".ke", PK: ".pk", BD: ".bd", ID: ".id", MY: ".my", PH: ".ph", IL: ".il", AE: ".ae", SA: ".sa" };

function score(r: Result, checks: Check[]): number {
  let s = Math.log1p(Math.max(0, (r as { score?: number }).score ?? 0)) + 1;
  for (const c of checks) s *= c.verdict === "pass" ? (c.strength === "hard" ? 1.6 : 1.25) : c.verdict === "unknown" ? (c.strength === "hard" ? 0.75 : 0.95) : 0.4;
  return s;
}

export interface AskOptions { limit?: number; offset?: number; kind?: string; host?: string }

/** Runs the plan: search → check → revise if too few qualify → rank → report. */
export async function askCorpus(store: Corpus, plan: QueryPlan, opts: AskOptions = {}) {
  const started = Date.now();
  const limit = Math.min(plan.constraints.quantity ?? opts.limit ?? 20, 50);
  const c = plan.constraints;
  const hardKinds = c.types?.strength === "hard" ? c.types.kinds.join(",") : undefined;
  const base: CorpusSearchOptions = { limit: Math.min(limit * 2, 50), offset: opts.offset ?? 0, kind: opts.kind ?? hardKinds, host: opts.host };
  const hosts = c.publisher?.strength === "hard" && c.publisher.mode === "published_by" && c.publisher.hostSuffixes.length && !opts.host ? c.publisher.hostSuffixes : undefined;
  const revisions: string[] = [];
  const seen = new Map<number, CheckedResult>();
  const take = (rows: Result[], foundBy: string) => {
    for (const r of rows) {
      if (seen.has(r.resourceId)) continue;
      const checks = checkResult(r, plan);
      seen.set(r.resourceId, { ...r, checks, qualifies: !checks.some((k) => k.strength === "hard" && k.verdict === "fail"), planScore: score(r, checks), foundBy });
    }
  };
  const qualifying = () => [...seen.values()].filter((r) => r.qualifies);
  const text = plan.searchTerms.join(" ");
  let total = 0, matchQuality = "none";
  if (text) {
    // 1. The topic, restricted to the publisher's own sites when the question names one.
    const first = await searchCorpus(store, text, { ...base, hosts });
    total = first.total; matchQuality = (first as { matchQuality?: string }).matchQuality ?? "none";
    take(first.results, hosts ? `topic on ${hosts.join(" / ")}` : "topic");
    // 2. Too few: related terms (candidates, never substitutes — results still have to pass the checks).
    if (qualifying().length < 5 && plan.expansions.length) {
      const related = [...new Set(plan.expansions.filter((e) => e.relation !== "spelling").map((e) => e.term))].slice(0, 3);
      for (const term of related) {
        const more = await searchCorpus(store, term, { ...base, hosts, limit: 20 });
        take(more.results, `related term "${term}"`);
      }
      if (related.length) revisions.push(`also searched related terms: ${related.join(", ")}`);
    }
    // 3. Still too few on the publisher's sites: search everywhere and keep pages whose own metadata names the publisher.
    if (qualifying().length < 5 && hosts) {
      const wide = await searchCorpus(store, text, { ...base });
      take(wide.results, "topic anywhere, publisher checked from page metadata");
      revisions.push("searched beyond the publisher's sites and checked each page's stated publisher");
    }
  }
  const all = [...seen.values()];
  const ranked = all.filter((r) => r.qualifies).sort((a, b) => b.planScore - a.planScore);
  if (c.order) {
    const year = (r: CheckedResult) => Math.max(0, ...years(r).map((y) => y.year));
    ranked.sort((a, b) => (c.order === "newest" ? year(b) - year(a) : year(a) - year(b)) || b.planScore - a.planScore);
  }
  const results = ranked.slice(0, limit);
  const verified = results.filter((r) => r.checks.every((k) => k.strength !== "hard" || k.verdict === "pass")).length;
  const rejected = all.length - ranked.length;
  // Requested outputs beyond the documents themselves.
  const outputs: Record<string, unknown> = {};
  if (plan.outputs.includes("funders")) {
    const map = new Map<string, Array<{ resourceId: number; title: string | null; evidence: string }>>();
    for (const r of results) for (const f of r.facts?.funders ?? []) {
      if (f.field.endsWith("fundingStatement")) continue;
      const name = String(typeof f.value === "string" ? f.value : Array.isArray(f.value) ? f.value[0] : JSON.stringify(f.value)).slice(0, 160);
      const list = map.get(name) ?? [];
      list.push({ resourceId: r.resourceId, title: r.title, evidence: f.method ?? "" });
      map.set(name, list);
    }
    outputs.funders = { found: [...map].map(([funder, documents]) => ({ funder, relationship: "funds", documents })), withoutFundingInformation: results.filter((r) => !(r.facts?.funders ?? []).length).length };
  }
  const satisfied = verified >= Math.min(5, limit) || (verified > 0 && verified === results.length);
  return {
    plan,
    total,
    matchQuality,
    results,
    outputs,
    evaluation: {
      satisfied,
      verified,
      partlyVerified: results.length - verified,
      rejected,
      revisions,
      note: !results.length ? "Nothing in the index meets these requirements yet." : satisfied ? `${verified} result${verified === 1 ? "" : "s"} meet every requirement.` : `${verified} result${verified === 1 ? "" : "s"} meet every requirement; the others could not be confirmed on at least one (shown as unknown).`,
    },
    tookMs: Date.now() - started,
  };
}
