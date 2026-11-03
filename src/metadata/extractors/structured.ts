import yaml from "js-yaml";
import { C } from "../categories.js";
import type { ExtractionContext, Extractor } from "../extractor.js";
import { clean, maskEmail } from "../normalize.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const MAX_TEXT = 6 * 1024 * 1024;

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Bounded shape walk (node budget defeats alias/anchor fan-out). */
function shape(v: unknown, budget = { n: 20_000 }, depth = 0): { depth: number; nodes: number } {
  let max = depth;
  let nodes = 0;
  const visit = (x: unknown, d: number) => {
    if (budget.n-- <= 0) return;
    nodes++;
    max = Math.max(max, d);
    if (Array.isArray(x)) for (const y of x.slice(0, 1000)) visit(y, d + 1);
    else if (isObj(x)) for (const y of Object.values(x).slice(0, 1000)) visit(y, d + 1);
  };
  visit(v, depth);
  return { depth: max, nodes };
}

const maskPerson = (s: string) => s.replace(/<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/g, (_, e: string) => `<${maskEmail(e)}>`).trim();
const people = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .map((p) => (typeof p === "string" ? p : isObj(p) ? [str(p.name), p.email ? `<${String(p.email)}>` : null].filter(Boolean).join(" ") : ""))
    .filter(Boolean)
    .map(maskPerson)
    .slice(0, 30);

/** OpenAPI / Swagger described from a parsed object (YAML or JSON). */
export function describeOpenApi(ctx: ExtractionContext, d: Json, method: string) {
  const info = isObj(d.info) ? d.info : {};
  ctx.add(C.schema, "schemaType", d.openapi ? `OpenAPI ${String(d.openapi)}` : `Swagger ${String(d.swagger)}`, { method: `${method} openapi|swagger` });
  ctx.add(C.descriptive, "title", clean(info.title), { method: `${method} info.title` });
  ctx.add(C.descriptive, "description", clean(info.description, 1000), { method: `${method} info.description` });
  ctx.add(C.version, "version", str(info.version), { method: `${method} info.version` });
  const lic = isObj(info.license) ? info.license : null;
  if (lic) ctx.add(C.rights, "license", clean(lic.name ?? lic.identifier), { method: `${method} info.license`, evidence: str(lic.url) ?? undefined });
  const paths = isObj(d.paths) ? Object.keys(d.paths) : [];
  ctx.add(C.schema, "apiPaths", paths.length, { method: `${method} paths` });
  ctx.add(C.structural, "endpoints", paths.slice(0, 60), { method: `${method} paths` });
  const servers = Array.isArray(d.servers) ? d.servers.map((s) => (isObj(s) ? str(s.url) : null)).filter(Boolean) : d.host ? [`${Array.isArray(d.schemes) ? d.schemes[0] : "https"}://${String(d.host)}${str(d.basePath) ?? ""}`] : [];
  ctx.add(C.technical, "servers", servers, { method: `${method} servers|host` });
  const comps = isObj(d.components) ? d.components : d;
  const sec = isObj(comps.securitySchemes) ? comps.securitySchemes : isObj(d.securityDefinitions) ? (d.securityDefinitions as Json) : {};
  ctx.add(C.access_security, "securitySchemes", Object.entries(sec).map(([k, v]) => ({ name: k, type: isObj(v) ? v.type : null })), { method: `${method} securitySchemes` });
  const schemas = isObj(comps.schemas) ? comps.schemas : isObj(d.definitions) ? (d.definitions as Json) : {};
  ctx.add(C.schema, "models", Object.keys(schemas).slice(0, 100), { method: `${method} components.schemas` });
}

// ---------------------------------------------------------------- JSON Lines

async function jsonl(ctx: ExtractionContext) {
  const text = (await ctx.text()).slice(0, MAX_TEXT);
  const lines = text.split(/\r?\n/);
  const keys = new Map<string, Set<string>>();
  const nulls = new Map<string, number>();
  let records = 0;
  let invalid = 0;
  let firstBad: number | null = null;
  const roots: Record<string, number> = {};
  const max = 50_000;
  for (let i = 0; i < lines.length && records + invalid < max; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      records++;
      roots[jsonType(v)] = (roots[jsonType(v)] ?? 0) + 1;
      if (isObj(v) && keys.size <= 300) for (const [k, x] of Object.entries(v)) {
        if (!keys.has(k) && keys.size >= 300) continue;
        const s = keys.get(k) ?? new Set<string>();
        s.add(jsonType(x));
        keys.set(k, s);
        if (x === null) nulls.set(k, (nulls.get(k) ?? 0) + 1);
      }
    } catch {
      invalid++;
      firstBad ??= i + 1;
    }
  }
  const o = { status: "observed" as const, method: "JSON Lines (one value per line)" };
  ctx.add(C.structural, "recordCount", records, { ...o, evidence: records + invalid >= max || ctx.response.truncated ? `counted first ${records + invalid} lines (limit or truncated body)` : undefined });
  ctx.add(C.structural, "rootTypes", roots, o);
  if (invalid) ctx.add(C.quality, "invalidLines", { count: invalid, firstLine: firstBad }, { ...o, evidence: "lines that are not valid JSON" });
  const props = [...keys].map(([path, types]) => ({ path, type: [...types].join("|"), nullRate: records ? Math.round(((nulls.get(path) ?? 0) / records) * 1000) / 1000 : 0 }));
  ctx.add(C.schema, "properties", props, { status: "inferred", method: "union of keys over all records" });
  const present = new Map<string, number>();
  for (const l of lines.slice(0, 5000)) {
    try {
      const v = JSON.parse(l);
      if (isObj(v)) for (const k of Object.keys(v)) present.set(k, (present.get(k) ?? 0) + 1);
    } catch {
      /* counted above */
    }
  }
  const sampled = Math.min(records, 5000);
  ctx.add(C.constraints, "alwaysPresentKeys", [...present].filter(([, n]) => sampled && n === sampled).map(([k]) => k), { status: "inferred", method: "keys present in every sampled record" });
}

// ---------------------------------------------------------------- YAML / TOML / robots.txt

async function config(ctx: ExtractionContext) {
  const text = (await ctx.text()).slice(0, MAX_TEXT);
  if (ctx.format === "robots_txt") return robots(ctx, text);
  if (ctx.format === "openapi" && ctx.kind === "json") return; // JSON OpenAPI is described by the json extractor
  let doc: unknown;
  let docs = 1;
  const isToml = ctx.format === "toml";
  try {
    if (isToml) doc = (await import("smol-toml")).parse(text);
    else {
      const all: unknown[] = [];
      // CORE_SCHEMA: no custom tags, no functions/regexps — data only.
      yaml.loadAll(text, (d) => {
        if (all.length < 50) all.push(d);
      }, { schema: yaml.CORE_SCHEMA, json: true });
      docs = all.length;
      doc = all[0];
    }
  } catch (err) {
    ctx.add(C.structural, "parseError", `${isToml ? "TOML" : "YAML"}: ${String((err as Error).message ?? err).split("\n")[0].slice(0, 160)}`, { status: "extraction_failed", method: isToml ? "smol-toml" : "js-yaml (core schema)", evidence: ctx.response.truncated ? "body truncated at byte cap" : undefined });
    return;
  }
  const method = isToml ? "TOML (smol-toml)" : "YAML (js-yaml core schema)";
  const o = { status: "observed" as const, method };
  ctx.add(C.structural, "rootType", jsonType(doc), o);
  if (!isToml) ctx.add(C.structural, "documentCount", docs, o);
  const sh = shape(doc);
  ctx.add(C.schema, "nesting", sh.depth, o);
  if (isObj(doc)) {
    ctx.add(C.structural, "topLevelKeys", Object.keys(doc).slice(0, 100), o);
    ctx.add(C.schema, "properties", Object.entries(doc).slice(0, 100).map(([k, v]) => ({ path: k, type: jsonType(v) })), { status: "inferred", method: `${method} top-level values` });
    if (ctx.format === "openapi" || typeof doc.openapi === "string" || typeof doc.swagger === "string") describeOpenApi(ctx, doc, method);
    else {
      if (typeof doc.title === "string") ctx.add(C.descriptive, "title", clean(doc.title), { method: `${method} title` });
      if (typeof doc.version === "string" || typeof doc.version === "number") ctx.add(C.version, "version", String(doc.version), { method: `${method} version` });
    }
  }
}

function robots(ctx: ExtractionContext, text: string) {
  const groups: Array<{ agents: string[]; allow: number; disallow: number; crawlDelay: number | null }> = [];
  const sitemaps: string[] = [];
  const other: Record<string, number> = {};
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  let invalid = 0;
  for (const raw of text.split(/\r?\n/).slice(0, 20_000)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      invalid++;
      continue;
    }
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], allow: 0, disallow: 0, crawlDelay: null }));
      cur.agents.push(v);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (k === "sitemap") {
      if (sitemaps.length < 50) sitemaps.push(v);
    } else if (cur && k === "allow") cur.allow++;
    else if (cur && k === "disallow") {
      if (v) cur.disallow++;
    } else if (cur && k === "crawl-delay") cur.crawlDelay = Number(v) || null;
    else other[k] = (other[k] ?? 0) + 1;
  }
  const o = { status: "observed" as const, method: "robots.txt parser (RFC 9309)" };
  ctx.add(C.discovery, "robotsGroups", groups.slice(0, 100), o);
  ctx.add(C.structural, "userAgentGroupCount", groups.length, o);
  ctx.add(C.discovery, "sitemaps", sitemaps, { method: "robots.txt Sitemap:", scope: "site" });
  const star = groups.find((g) => g.agents.includes("*"));
  if (star) ctx.add(C.access_security, "wildcardDisallowRules", star.disallow, { ...o, evidence: "rules for User-agent: *" });
  const ai = groups.filter((g) => g.agents.some((a) => /gptbot|ccbot|claudebot|anthropic|google-extended|perplexity|bytespider|cohere|applebot-extended/i.test(a)) && g.disallow > 0).flatMap((g) => g.agents);
  if (ai.length) ctx.add(C.access_security, "aiCrawlerRestrictions", ai, { ...o, evidence: "user agents of AI/data crawlers with Disallow rules" });
  if (Object.keys(other).length) ctx.add(C.discovery, "nonStandardDirectives", other, o);
  if (invalid) ctx.add(C.quality, "invalidLines", invalid, o);
  ctx.shared.set("references", sitemaps.map((s) => ({ url: s, text: "robots.txt Sitemap", rel: "sitemap", region: "main", tag: "sitemap", type: "sitemap" })));
}

/** JSON Lines, YAML, TOML, OpenAPI-in-YAML, robots.txt: parsed as data with bounded, non-executing parsers. */
export const dataLinesExtractor: Extractor = {
  id: "data-lines",
  version: "1.0.0",
  description: "JSON Lines / NDJSON: record count, invalid lines, key union with types and null rates.",
  kinds: ["text"],
  formats: ["jsonl"],
  categories: [C.structural, C.schema, C.constraints, C.quality],
  timeoutMs: 3000,
  run: jsonl,
};

export const configExtractor: Extractor = {
  id: "config",
  version: "1.0.0",
  description: "YAML (safe core schema, multi-document) / TOML / OpenAPI-in-YAML / robots.txt (groups, sitemaps, AI-crawler rules).",
  kinds: ["text", "json"],
  formats: ["yaml", "toml", "openapi", "robots_txt"],
  categories: [C.structural, C.schema, C.descriptive, C.version, C.discovery, C.access_security, C.rights, C.technical],
  timeoutMs: 3000,
  run: config,
};

// ---------------------------------------------------------------- package manifests

function spdxish(v: unknown): string | null {
  if (typeof v === "string") return clean(v, 120);
  if (isObj(v)) return clean(v.type ?? v.text ?? v.file, 120);
  return null;
}

async function manifest(ctx: ExtractionContext) {
  const text = (await ctx.text()).slice(0, 2 * 1024 * 1024);
  const add = (cat: number, field: string, value: unknown, method: string) => ctx.add(cat, field, value, { method });
  const deps = (o: unknown, scope: string) => (isObj(o) ? Object.entries(o).slice(0, 300).map(([name, v]) => ({ name, spec: typeof v === "string" ? v : isObj(v) ? str(v.version) ?? (v.git ? `git:${String(v.git)}` : v.path ? "path" : "table") : null, scope })) : []);
  let kind = ctx.format;
  try {
    if (ctx.format === "package_json") {
      const p = JSON.parse(text.replace(/^﻿/, "")) as Json;
      add(C.descriptive, "title", clean(p.name), "package.json name");
      add(C.descriptive, "description", clean(p.description, 1000), "package.json description");
      add(C.descriptive, "keywords", Array.isArray(p.keywords) ? p.keywords.map(String).slice(0, 40) : [], "package.json keywords");
      add(C.version, "version", str(p.version), "package.json version");
      add(C.rights, "license", spdxish(p.license), "package.json license (SPDX expression)");
      add(C.provenance, "authors", people([p.author, ...(Array.isArray(p.contributors) ? p.contributors : [])].filter(Boolean)), "package.json author|contributors (emails masked)");
      const all = [...deps(p.dependencies, "runtime"), ...deps(p.devDependencies, "dev"), ...deps(p.peerDependencies, "peer"), ...deps(p.optionalDependencies, "optional")];
      add(C.lineage, "dependencies", all, "package.json *dependencies");
      add(C.technical, "engines", isObj(p.engines) ? p.engines : null, "package.json engines");
      add(C.technical, "moduleType", str(p.type), "package.json type");
      const repo = typeof p.repository === "string" ? p.repository : isObj(p.repository) ? str(p.repository.url) : null;
      if (repo) {
        add(C.relational, "repository", repo, "package.json repository");
        const url = repo.replace(/^git\+/, "").replace(/^git:\/\//, "https://");
        if (/^https?:\/\//.test(url)) ctx.relate("references", url, "package.json repository", "package.json repository");
      }
      if (isObj(p.scripts)) ctx.add(C.technical, "scriptNames", Object.keys(p.scripts).slice(0, 40), { method: "package.json scripts (names only; never executed)", status: "observed" });
    } else if (ctx.format === "requirements_txt") {
      const reqs: Array<Record<string, unknown>> = [];
      const includes: string[] = [];
      for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
        const l = raw.replace(/\s+#.*$/, "").trim();
        if (!l || l.startsWith("#")) continue;
        if (/^-(r|c)\s+/.test(l) || /^--(requirement|constraint)[ =]/.test(l)) includes.push(l.split(/[ =]/).pop()!);
        else if (l.startsWith("-")) continue; // pip options (index urls etc.)
        else {
          const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([<>=!~^][^;]*)?(;.*)?$/.exec(l);
          reqs.push(m ? { name: m[1], extras: m[2] ?? null, spec: m[3]?.trim() ?? null, marker: m[4]?.slice(1).trim() ?? null, scope: "runtime" } : { name: l.slice(0, 120), spec: "url/vcs reference", scope: "runtime" });
        }
      }
      add(C.lineage, "dependencies", reqs, "requirements.txt lines");
      ctx.add(C.structural, "dependencyCount", reqs.length, { method: "requirements.txt lines", status: "observed" });
      if (includes.length) add(C.relational, "includes", includes, "requirements.txt -r/-c");
    } else {
      const t = (await import("smol-toml")).parse(text) as Json;
      if (ctx.format === "pyproject") {
        const proj = isObj(t.project) ? t.project : isObj(t.tool) && isObj((t.tool as Json).poetry) ? ((t.tool as Json).poetry as Json) : {};
        kind = isObj(t.project) ? "pyproject (PEP 621)" : "pyproject (poetry)";
        add(C.descriptive, "title", clean(proj.name), `${kind} name`);
        add(C.descriptive, "description", clean(proj.description, 1000), `${kind} description`);
        add(C.version, "version", str(proj.version), `${kind} version`);
        add(C.rights, "license", spdxish(proj.license), `${kind} license`);
        add(C.provenance, "authors", people(proj.authors), `${kind} authors (emails masked)`);
        const depList = Array.isArray(proj.dependencies) ? proj.dependencies.map((d) => ({ name: String(d).split(/[<>=!~;\s[]/)[0], spec: String(d), scope: "runtime" })) : deps(proj.dependencies, "runtime");
        add(C.lineage, "dependencies", depList, `${kind} dependencies`);
        add(C.technical, "requiresPython", str(proj["requires-python"]), `${kind} requires-python`);
        const bs = isObj(t["build-system"]) ? (t["build-system"] as Json) : null;
        if (bs) add(C.technical, "buildBackend", str(bs["build-backend"]), "pyproject build-system.build-backend");
      } else {
        const pkg = isObj(t.package) ? t.package : {};
        add(C.descriptive, "title", clean(pkg.name), "Cargo.toml package.name");
        add(C.descriptive, "description", clean(pkg.description, 1000), "Cargo.toml package.description");
        add(C.version, "version", str(pkg.version), "Cargo.toml package.version");
        add(C.rights, "license", spdxish(pkg.license), "Cargo.toml package.license");
        add(C.provenance, "authors", people(pkg.authors), "Cargo.toml package.authors (emails masked)");
        add(C.technical, "rustEdition", str(pkg.edition), "Cargo.toml package.edition");
        add(C.lineage, "dependencies", [...deps(t.dependencies, "runtime"), ...deps(t["dev-dependencies"], "dev"), ...deps(t["build-dependencies"], "build")], "Cargo.toml [*dependencies]");
        const repo = str(pkg.repository);
        if (repo && /^https?:\/\//.test(repo)) ctx.relate("references", repo, "Cargo.toml repository", "Cargo.toml package.repository");
      }
    }
  } catch (err) {
    ctx.add(C.lineage, "dependencies", `${ctx.format}: ${String((err as Error).message ?? err).split("\n")[0].slice(0, 160)}`, { status: "extraction_failed", method: `${ctx.format} parser` });
    return;
  }
  ctx.add(C.technical, "packageManifest", kind, { status: "observed", method: "file name + structure" });
}

export const packageManifestExtractor: Extractor = {
  id: "package-manifest",
  version: "1.0.0",
  description: "Package manifests parsed as data (never installed or executed): package.json, requirements.txt, pyproject.toml (PEP 621/poetry), Cargo.toml — name, version, license, authors (masked), dependencies.",
  kinds: ["json", "text"],
  formats: ["package_json", "requirements_txt", "pyproject", "cargo_toml"],
  categories: [C.descriptive, C.version, C.rights, C.lineage, C.provenance, C.relational, C.technical, C.structural],
  timeoutMs: 2000,
  run: manifest,
};

// ---------------------------------------------------------------- source code

const COMMENT: Record<string, { line?: RegExp; block?: [string, string] }> = {
  hash: { line: /^\s*#/ },
  slash: { line: /^\s*\/\//, block: ["/*", "*/"] },
  dash: { line: /^\s*--/ },
  percent: { line: /^\s*%/ },
  semi: { line: /^\s*;/ },
};
const STYLE: Record<string, keyof typeof COMMENT> = { Python: "hash", Shell: "hash", Ruby: "hash", Perl: "hash", R: "hash", Julia: "hash", PowerShell: "hash", Elixir: "hash", SQL: "dash", Lua: "dash", Haskell: "dash", "MATLAB/Objective-C": "percent", Erlang: "percent", Clojure: "semi" };

const LICENSE_HEADERS: Array<[RegExp, string]> = [
  [/Licensed under the Apache License,?\s+Version 2\.0/i, "Apache-2.0"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/GNU (Affero )?General Public License[\s\S]{0,200}?version 3/i, "GPL-3.0 (or AGPL-3.0)"],
  [/GNU General Public License[\s\S]{0,200}?version 2/i, "GPL-2.0"],
  [/GNU Lesser General Public License/i, "LGPL"],
  [/Mozilla Public License,?\s+v?\.?\s*2\.0/i, "MPL-2.0"],
  [/Redistribution and use in source and binary forms/i, "BSD-style"],
  [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
];

async function sourceCode(ctx: ExtractionContext) {
  const text = (await ctx.text()).slice(0, 4 * 1024 * 1024);
  const lang = String(ctx.detection.detail?.language ?? "unknown");
  const lines = text.split(/\r?\n/);
  const style = COMMENT[STYLE[lang] ?? "slash"];
  let blank = 0;
  let comment = 0;
  let inBlock = false;
  for (const l of lines.slice(0, 200_000)) {
    const t = l.trim();
    if (!t) {
      blank++;
      continue;
    }
    if (inBlock) {
      comment++;
      if (style.block && t.includes(style.block[1])) inBlock = false;
      continue;
    }
    if (style.line?.test(l)) comment++;
    else if (style.block && t.startsWith(style.block[0])) {
      comment++;
      if (!t.includes(style.block[1], style.block[0].length)) inBlock = true;
    }
  }
  const o = { status: "observed" as const, method: "line classification (never executed)" };
  ctx.add(C.technical, "programmingLanguage", lang, { status: "observed", method: ctx.detection.signature === "#! shebang" ? "shebang interpreter" : "file extension", evidence: ctx.detection.signature ?? undefined });
  ctx.add(C.structural, "lineCount", lines.length, o);
  ctx.add(C.structural, "codeLines", lines.length - blank - comment, { ...o, evidence: "approximate: comment syntax heuristics per language" });
  ctx.add(C.structural, "commentLines", comment, o);
  ctx.add(C.structural, "blankLines", blank, o);
  const head = lines.slice(0, 40).join("\n");
  const spdx = /SPDX-License-Identifier:\s*([A-Za-z0-9.+\-() ]+?)\s*(?:\*\/|-->|$)/m.exec(head)?.[1]?.trim();
  if (spdx) ctx.add(C.rights, "license", spdx, { method: "SPDX-License-Identifier header" });
  else {
    const hit = LICENSE_HEADERS.find(([re]) => re.test(head));
    if (hit) ctx.add(C.rights, "license", hit[1], { method: "license header text", status: "inferred", evidence: "matched standard licence boilerplate in the first 40 lines" });
  }
  const copyright = /(?:Copyright|\(c\)|©)\s*(?:\(c\)\s*)?(\d{4}(?:\s*[-–,]\s*\d{4})*)?\s*([^\n*]{0,120})/i.exec(head);
  if (copyright) ctx.add(C.rights, "copyright", clean(copyright[0].replace(/^[#/*\s-]+/, ""), 200), { method: "copyright header line" });
  if (lang === "Jupyter notebook") {
    try {
      const nb = JSON.parse(text) as { cells?: Array<{ cell_type?: string }>; metadata?: { kernelspec?: { language?: string; display_name?: string } } };
      const cells = nb.cells ?? [];
      ctx.add(C.structural, "notebookCells", { code: cells.filter((c) => c.cell_type === "code").length, markdown: cells.filter((c) => c.cell_type === "markdown").length }, o);
      ctx.add(C.technical, "kernel", nb.metadata?.kernelspec?.display_name ?? nb.metadata?.kernelspec?.language ?? null, { method: "notebook metadata.kernelspec" });
    } catch {
      ctx.add(C.structural, "notebookCells", "invalid notebook JSON", { status: "extraction_failed", method: "JSON.parse" });
    }
  }
}

export const sourceCodeExtractor: Extractor = {
  id: "source-code",
  version: "1.0.0",
  description: "Source code (language by extension + shebang): line/code/comment/blank counts, SPDX or licence-boilerplate header, copyright line. Never executed.",
  kinds: ["text"],
  formats: ["source_code"],
  categories: [C.technical, C.structural, C.rights],
  timeoutMs: 2000,
  run: sourceCode,
};
