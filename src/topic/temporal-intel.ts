import type {
  DatedEvidence,
  DatedEventCategory,
  EmploymentTimelineEntry,
  PageRecord,
  PeopleIntelligenceMap,
  SocialTrailMap,
  TemporalIntelligenceMap,
  TopicPageIntel,
} from "../core/models.js";
import type { TopicProfile } from "./index.js";

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const DATE_PATTERNS: Array<{ re: RegExp; precision: DatedEvidence["datePrecision"] }> = [
  {
    re: /\b(January|February|March|April|May|June|July|August|September|Sept|Oct|November|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Nov|December)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
    precision: "day",
  },
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|Sept|Oct|November|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Nov|December)\.?,?\s+(\d{4})\b/gi,
    precision: "day",
  },
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    precision: "day",
  },
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    precision: "day",
  },
  {
    re: /\b(January|February|March|April|May|June|July|August|September|Sept|Oct|November|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Nov|December)\.?\s+(\d{4})\b/gi,
    precision: "month",
  },
  {
    re: /\b(\d{4})-(\d{2})\b/g,
    precision: "month",
  },
];

const EMPLOYMENT_START =
  /\b(?:started|start(?:ed)?|joined|join(?:ed)?|hired|began|begin(?:ning)?|new job|now at|currently at|works? at|working at|employed (?:by|at)|accepted (?:a )?(?:role|position) at|posted (?:about )?(?:a )?job at)\b/i;
const EMPLOYMENT_END =
  /\b(?:left|quit|resigned|departed|former(?:ly)?|ex-|used to work|until|through|ended|no longer at|past role at|retired from)\b/i;
const JOB_POST = /\b(?:job (?:post(?:ing)?|listing|opening)|hiring|we(?:'re| are) hiring|apply (?:now|here)|careers? at)\b/i;

const COMPANY_NEAR_DATE =
  /\b(?:at|@|with|for)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50}?)(?=\s+(?:as|until|through|in|on|from|where|\.|,|;|$|\s+(?:LLC|Inc|Corp)))/;

const COMPANY_PATTERNS: RegExp[] = [
  COMPANY_NEAR_DATE,
  /\b(?:works? at|working at|employed at|job at|worked at|new job at)\s+([A-Z][A-Za-z0-9\s&.'-]{2,50}?)(?=\s+(?:as|until|in|on|from|\.|,|;|$))/i,
  /\b([A-Z][A-Za-z0-9\s&.'-]{2,40})\s+(?:LLC|L\.L\.C\.|Inc\.|Corp\.|Corporation|Co\.)\b/,
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function normalizeMonth(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\./g, "")] ?? null;
}

export function parseDateFromMatch(m: RegExpMatchArray, precision: DatedEvidence["datePrecision"]): string | null {
  if (precision === "day") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(m[0])) return m[0];
    if (m.length >= 4 && /^\d{4}$/.test(m[3] ?? "") && /^\d{1,2}$/.test(m[2] ?? "")) {
      const mo = normalizeMonth(m[1] ?? "");
      if (mo) return `${m[3]}-${pad(mo)}-${pad(Number(m[2]))}`;
    }
    if (m.length >= 4 && /^\d{4}$/.test(m[3] ?? "") && /^\d{1,2}$/.test(m[1] ?? "")) {
      const mo = normalizeMonth(m[2] ?? "");
      if (mo) return `${m[3]}-${pad(mo)}-${pad(Number(m[1]))}`;
    }
    if (m.length >= 4 && /^\d{4}$/.test(m[3] ?? "")) {
      const mo = Number(m[1]);
      const day = Number(m[2]);
      if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
        return `${m[3]}-${pad(mo)}-${pad(day)}`;
      }
    }
  }
  if (precision === "month") {
    if (/^\d{4}-\d{2}$/.test(m[0])) return `${m[0]}-01`;
    const mo = normalizeMonth(m[1] ?? "");
    if (mo && m[2]) return `${m[2]}-${pad(mo)}-01`;
  }
  return null;
}

export function extractDatesFromText(text: string): Array<{ date: string; precision: DatedEvidence["datePrecision"]; match: string }> {
  const found: Array<{ date: string; precision: DatedEvidence["datePrecision"]; match: string }> = [];
  for (const { re, precision } of DATE_PATTERNS) {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(r)) {
      const date = parseDateFromMatch(m, precision);
      if (date) found.push({ date, precision, match: m[0] });
    }
  }
  const timeTags = text.match(/datetime="(\d{4}-\d{2}-\d{2})"/g) ?? [];
  for (const t of timeTags) {
    const d = t.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (d) found.push({ date: d, precision: "day", match: t });
  }
  return found;
}

function extractCompanyFromContext(ctx: string): string | undefined {
  for (const re of COMPANY_PATTERNS) {
    const m = ctx.match(re);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
  }
  return undefined;
}

export function extractDatedEvidenceFromText(
  text: string,
  source: string,
  baseConfidence = 0.55,
): DatedEvidence[] {
  const events: DatedEvidence[] = [];
  const dates = extractDatesFromText(text);

  for (const { date, precision, match } of dates) {
    const idx = text.indexOf(match);
    const before = idx >= 0 ? text.slice(Math.max(0, idx - 140), idx) : "";
    const after = idx >= 0 ? text.slice(idx + match.length, idx + match.length + 140) : text.slice(0, 280);
    const ctx = `${before}${match}${after}`.replace(/\s+/g, " ").trim();

    const untilBeforeDate = /\buntil\s*$/i.test(before.trimEnd()) || /\buntil\s+$/i.test(before);
    const endInBefore = untilBeforeDate || EMPLOYMENT_END.test(before);
    const startInAfter = EMPLOYMENT_START.test(after) || JOB_POST.test(after);
    const endInAfter = EMPLOYMENT_END.test(after);
    const startInBefore = EMPLOYMENT_START.test(before);

    let category: DatedEventCategory = "general";
    let label = "Dated mention";
    if (untilBeforeDate || (endInBefore && !startInAfter)) {
      category = "employment_end";
      label = "Employment ended / former role";
    } else if (startInAfter || JOB_POST.test(after)) {
      category = JOB_POST.test(after) ? "job_post" : "employment_start";
      label = JOB_POST.test(after) ? "Job posting / hiring signal" : "Employment started / current role";
    } else if (startInBefore) {
      category = "employment_start";
      label = "Employment started / current role";
    } else if (endInBefore || endInAfter) {
      category = "employment_end";
      label = "Employment ended / former role";
    } else if (/\b(?:lives in|moved to|relocated|based in)\b/i.test(ctx)) {
      category = "location";
      label = "Location signal";
    } else if (/\b(?:founded|LLC|Inc|startup|business)\b/i.test(ctx)) {
      category = "business";
      label = "Business entity signal";
    }

    let entity: string | undefined;
    if (category === "employment_end") {
      entity = extractCompanyFromContext(before) ?? extractCompanyFromContext(ctx);
    } else if (category === "employment_start" || category === "job_post") {
      entity = extractCompanyFromContext(after) ?? extractCompanyFromContext(ctx);
    } else {
      entity =
        extractCompanyFromContext(after) ??
        extractCompanyFromContext(before) ??
        extractCompanyFromContext(ctx);
    }

    const roleCtx = category === "employment_end" ? before : after;
    const roleMatch = roleCtx.match(/\b(?:as|role[:\s]+|position[:\s]+)\s+(?:a\s+)?([a-z][a-z\s/-]{2,40})/i);

    events.push({
      date,
      datePrecision: precision,
      label,
      category,
      detail: ctx.slice(0, 220),
      entity,
      role: roleMatch?.[1]?.trim(),
      source,
      confidence: entity ? baseConfidence + 0.15 : baseConfidence,
    });
  }
  return events;
}

function normalizeCompany(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compareDates(a: string, b: string): number {
  return b.localeCompare(a);
}

export function buildEmploymentTimeline(
  events: DatedEvidence[],
  employmentEntities: PeopleIntelligenceMap["employment"],
): EmploymentTimelineEntry[] {
  const empEvents = events.filter(
    (e) =>
      e.entity &&
      ["employment_start", "employment_end", "employment_current", "job_post", "general"].includes(e.category),
  );

  for (const e of employmentEntities.current) {
    const company = e.value.split("@").pop()?.trim() ?? e.value;
    const role = e.context ?? e.value.split("@")[0]?.trim();
    empEvents.push({
      date: "9999-12-31",
      datePrecision: "day",
      label: "Current employment (undated)",
      category: "employment_current",
      detail: e.value,
      entity: company,
      role,
      source: e.sources[0] ?? "",
      confidence: e.confidence * 0.85,
    });
  }
  for (const e of employmentEntities.past) {
    const company = e.value.split("@").pop()?.trim() ?? e.value;
    const role = e.context ?? e.value.split("@")[0]?.trim();
    empEvents.push({
      date: "0001-01-01",
      datePrecision: "day",
      label: "Past employment (undated)",
      category: "employment_end",
      detail: e.value,
      entity: company,
      role,
      source: e.sources[0] ?? "",
      confidence: e.confidence * 0.8,
    });
  }

  const byCompany = new Map<string, DatedEvidence[]>();
  for (const ev of empEvents) {
    if (!ev.entity) continue;
    const key = normalizeCompany(ev.entity);
    const list = byCompany.get(key) ?? [];
    list.push(ev);
    byCompany.set(key, list);
  }

  const timeline: EmploymentTimelineEntry[] = [];

  for (const [, companyEvents] of byCompany) {
    const company = companyEvents[0].entity!;
    const role = companyEvents.find((e) => e.role)?.role;
    const sorted = [...companyEvents].sort((a, b) => compareDates(a.date, b.date));

    const starts = sorted.filter((e) => e.category === "employment_start" || e.category === "job_post");
    const ends = sorted.filter((e) => e.category === "employment_end");
    const currentSignals = sorted.filter((e) => e.category === "employment_current");

    let startDate = starts.length ? starts[starts.length - 1].date : undefined;
    let endDate = ends.length ? ends[0].date : undefined;

    if (!startDate) {
      const dated = sorted.filter((e) => e.date !== "9999-12-31" && e.date !== "0001-01-01");
      if (dated.length) startDate = dated[dated.length - 1].date;
    }

    let status: EmploymentTimelineEntry["status"] = "inferred_past";
    if (currentSignals.length || (!endDate && starts.length)) status = "current";
    else if (endDate && startDate && endDate >= startDate) status = "past";
    else if (starts.length && !endDate) status = "inferred_current";

    timeline.push({
      company,
      role,
      startDate: startDate && startDate !== "9999-12-31" ? startDate : undefined,
      endDate: endDate && endDate !== "0001-01-01" ? endDate : undefined,
      status,
      evidence: sorted.filter((e) => e.date !== "9999-12-31" && e.date !== "0001-01-01"),
      transitions: [],
    });
  }

  timeline.sort((a, b) => {
    const ad = a.startDate ?? a.endDate ?? "0000";
    const bd = b.startDate ?? b.endDate ?? "0000";
    return bd.localeCompare(ad);
  });

  return inferJobTransitions(timeline);
}

export function inferJobTransitions(timeline: EmploymentTimelineEntry[]): EmploymentTimelineEntry[] {
  const inferences: string[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const current = timeline[i];
    for (let j = i + 1; j < timeline.length; j++) {
      const prior = timeline[j];
      if (prior.company.toLowerCase() === current.company.toLowerCase()) continue;

      const currentStart = current.startDate ?? current.evidence[0]?.date;
      const priorEnd = prior.endDate ?? prior.evidence[0]?.date;

      if (currentStart && priorEnd) {
        if (currentStart >= priorEnd) {
          const msg = `Job transition: left ${prior.company} (last signal ${priorEnd}) → joined ${current.company} (${currentStart})`;
          current.transitions.push(msg);
          inferences.push(msg);
        } else if (currentStart < priorEnd) {
          const msg = `Overlap or role change: ${current.company} signal (${currentStart}) while ${prior.company} active until ${priorEnd}`;
          current.transitions.push(msg);
        }
      } else if (currentStart && !priorEnd && prior.status !== "current") {
        const jobPost = current.evidence.find((e) => e.category === "job_post");
        if (jobPost) {
          const msg = `New job inferred: ${current.company} (${jobPost.date} job post/connection) — likely replaced ${prior.company}`;
          current.transitions.push(msg);
          inferences.push(msg);
          if (prior.status === "inferred_past") prior.endDate = jobPost.date;
        }
      }
    }
  }

  const currentJobs = timeline.filter((t) => t.status === "current" || t.status === "inferred_current");
  if (currentJobs.length === 1 && timeline.length > 1) {
    const cur = currentJobs[0];
    for (const past of timeline) {
      if (past.company === cur.company) continue;
      if (past.status === "past" || past.status === "inferred_past") {
        const msg = `Current employer inferred as ${cur.company}; ${past.company} appears to be prior employment`;
        if (!cur.transitions.includes(msg)) cur.transitions.push(msg);
      }
    }
  }

  return timeline;
}

export function emptyTemporalMap(): TemporalIntelligenceMap {
  return {
    datedEvents: [],
    employmentTimeline: [],
    chronology: [],
    inferences: [],
  };
}

export function buildTemporalIntelligence(
  intelPages: TopicPageIntel[],
  peopleMap: PeopleIntelligenceMap,
  socialTrail: SocialTrailMap,
  profile: TopicProfile,
  allPages: PageRecord[],
  loadBody: (page: PageRecord) => string,
): TemporalIntelligenceMap {
  const events: DatedEvidence[] = [];

  for (const intel of intelPages) {
    const conf = Math.min(0.9, 0.4 + intel.relevance);
    const blob = [
      intel.title,
      intel.githubBio,
      intel.metaDescription,
      ...intel.headings,
      ...intel.profileItems,
      ...intel.snippets,
    ].join("\n");
    events.push(...extractDatedEvidenceFromText(blob, intel.url, conf));

    for (const j of intel.employment ?? []) {
      const line = `Works at ${j.company} as ${j.role}`;
      events.push(...extractDatedEvidenceFromText(line, intel.url, conf * 0.9));
    }
    for (const j of intel.pastEmployment ?? []) {
      const line = `Formerly at ${j.company} as ${j.role}`;
      events.push(...extractDatedEvidenceFromText(line, intel.url, conf * 0.85));
    }
  }

  for (const post of socialTrail.posts.filter((p) => !p.isRepost)) {
    if (post.publishedAt) {
      const iso = post.publishedAt.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        events.push(...extractDatedEvidenceFromText(post.text, post.postUrl, 0.7).map((e) => ({
          ...e,
          date: iso,
          source: post.postUrl,
          category: e.category === "general" ? "social" as const : e.category,
          label: `Social post: ${e.label}`,
        })));
      }
    } else {
      events.push(...extractDatedEvidenceFromText(post.text, post.postUrl, 0.65).map((e) => ({
        ...e,
        category: e.category === "general" ? "social" as const : e.category,
      })));
    }
  }

  for (const page of allPages.slice(0, 80)) {
    const body = loadBody(page);
    if (!body || body.length < 100) continue;
    for (const term of profile.terms) {
      if (term.length < 4) continue;
      if (!body.toLowerCase().includes(term)) continue;
      events.push(...extractDatedEvidenceFromText(body.slice(0, 80000), page.url, 0.5));
      break;
    }
  }

  const deduped = dedupeEvents(events);
  const employmentTimeline = buildEmploymentTimeline(deduped, peopleMap.employment);
  const inferences = employmentTimeline.flatMap((t) => t.transitions);
  const chronology = [...deduped].sort((a, b) => compareDates(a.date, b.date));

  return {
    datedEvents: deduped,
    employmentTimeline,
    chronology,
    inferences: [...new Set(inferences)],
  };
}

function dedupeEvents(events: DatedEvidence[]): DatedEvidence[] {
  const map = new Map<string, DatedEvidence>();
  for (const e of events) {
    const key = `${e.date}:${e.category}:${e.entity ?? ""}:${e.detail.slice(0, 60)}`;
    const existing = map.get(key);
    if (!existing || e.confidence > existing.confidence) map.set(key, e);
  }
  return [...map.values()];
}

export function formatTemporalMarkdown(temporal: TemporalIntelligenceMap): string {
  const lines: string[] = ["## Temporal Intelligence (Dated Timeline)", ""];

  lines.push("### Employment Timeline", "");
  if (!temporal.employmentTimeline.length) {
    lines.push("_No dated employment timeline reconstructed — add pages/posts with explicit dates._", "");
  } else {
    for (const job of temporal.employmentTimeline) {
      const range = [
        job.startDate ? `from ${job.startDate}` : null,
        job.endDate ? `until ${job.endDate}` : null,
      ].filter(Boolean).join(" ");
      lines.push(`- **${job.company}**${job.role ? ` (${job.role})` : ""} — _${job.status}_ ${range ? `— ${range}` : ""}`);
      for (const ev of job.evidence.slice(0, 3)) {
        lines.push(`  - **${ev.date}** — ${ev.label}${ev.entity ? `: ${ev.entity}` : ""} — [source](${ev.source})`);
        lines.push(`    - ${ev.detail.slice(0, 140)}`);
      }
      for (const t of job.transitions) lines.push(`  - → _${t}_`);
    }
    lines.push("");
  }

  if (temporal.inferences.length) {
    lines.push("### Inferred Job Changes", "");
    for (const inf of temporal.inferences) lines.push(`- ${inf}`);
    lines.push("");
  }

  lines.push("### Full Chronology (newest → oldest)", "");
  if (!temporal.chronology.length) {
    lines.push("_No dated events extracted._", "");
  } else {
    for (const ev of temporal.chronology.slice(0, 30)) {
      lines.push(
        `- **${ev.date}** — ${ev.label}${ev.entity ? ` · ${ev.entity}` : ""} — [${ev.source}](${ev.source})`,
      );
      lines.push(`  - ${ev.detail.slice(0, 160)}`);
    }
  }

  return lines.join("\n");
}
