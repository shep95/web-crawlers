// Omnispider UI — dependency-free. All remote data is rendered via textContent (never innerHTML).
const main = document.getElementById("main");
const qInput = document.getElementById("q");
let active = []; // EventSources / AbortControllers of the current view (closed on navigation)
let categories = null;

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
/** replaceChildren/append that skip null/false like h() does (DOM APIs would print "null"). */
const kids = (xs) => xs.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
function fill(el, ...children) {
  el.replaceChildren(...kids(children));
}
function add(el, ...children) {
  el.append(...kids(children));
}
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
};
const fmtVal = (v) => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join(", ");
  return JSON.stringify(v, null, 1);
};
const short = (s, n = 140) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());
function apiKey() {
  try { return localStorage.getItem("omnispider.key") || ""; } catch { return ""; }
}
function withKey(url) {
  const k = apiKey();
  if (!k) return url;
  return `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(k)}`;
}
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const k = apiKey();
  if (k) headers["x-api-key"] = k;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    const key = window.prompt("This deployment requires an API key:");
    if (key) {
      try { localStorage.setItem("omnispider.key", key); } catch {}
      return api(path, opts);
    }
  }
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((body && body.message) || (body && body.error) || `HTTP ${res.status}`);
    err.code = body && body.error;
    err.status = res.status;
    throw err;
  }
  return body;
}
function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => (btn.textContent = old), 1000);
  });
}
function cleanup() {
  for (const a of active) {
    try { a.close ? a.close() : a.abort(); } catch {}
  }
  active = [];
}
async function loadCategories() {
  if (!categories) categories = (await api("/api/v2/categories")).categories;
  return categories;
}
const STATUS_LABEL = {
  observed: "observed",
  source_declared: "declared",
  corroborated: "corroborated",
  inferred: "inferred",
  contradicted: "contradicted",
  extraction_failed: "failed",
};
const ERROR_TEXT = {
  ROBOTS_DISALLOWED: "The site's robots.txt does not allow automated fetching of this URL, so it was not retrieved.",
  EGRESS_BLOCKED: "This address is not a public internet resource (private, local or otherwise blocked) and cannot be fetched.",
  FETCH_FAILED: "The resource could not be retrieved (network error or timeout).",
  RATE_LIMITED: "Too many requests — please wait a moment and try again.",
  OVERLOADED: "The service is busy. Please retry in a few seconds.",
};

// ------------------------------------------------------------------ router
function navigate(path, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  route();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && a.origin === location.origin && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    navigate(a.getAttribute("href"));
  }
});
window.addEventListener("popstate", route);
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (!q) return;
  navigate(isUrl(q) ? `/resource?url=${encodeURIComponent(q)}` : `/search?q=${encodeURIComponent(q)}`);
});

function route() {
  cleanup();
  const { pathname, searchParams } = new URL(location.href);
  for (const a of document.querySelectorAll(".nav a")) a.toggleAttribute("aria-current", a.getAttribute("href") === pathname);
  for (const a of document.querySelectorAll(".nav a[aria-current]")) a.setAttribute("aria-current", "page");
  fill(main);
  window.scrollTo(0, 0);
  if (pathname === "/search" && searchParams.get("q")) return viewSearch(searchParams.get("q"));
  if (pathname === "/item" && searchParams.get("id")) return viewItem(searchParams.get("id"));
  if (pathname === "/resource" && searchParams.get("url")) return viewResource(searchParams.get("url"), searchParams.get("fresh") === "1");
  if (pathname === "/crawl") return viewCrawl(searchParams.get("url") || "");
  if (pathname === "/categories") return viewCategories();
  if (pathname === "/status") return viewStatus();
  if (pathname !== "/") return add(main, h("div", { class: "empty" }, h("h1", {}, "Page not found"), h("p", {}, h("a", { href: "/", "data-link": true }, "Back to search"))));
  return viewHome();
}

// ------------------------------------------------------------------ home
function viewHome() {
  document.title = "Omnispider — Metadata Intelligence";
  qInput.value = "";
  const examples = ["rainfall dataset methodology", "image license", "model card evaluation", "csv schema columns", "open data retention policy", "video subtitles"];
  const fileInput = h("input", { type: "file", class: "sr", id: "file" });
  const drop = h("label", { class: "drop", for: "file" }, h("strong", {}, "Analyze a file"), h("br"), "Drop a PDF, image, audio/video, DOCX, CSV, JSON or .eml here, or click to choose. Max 25 MB. Not stored.");
  const handleFile = (file) => {
    if (!file) return;
    navigateUpload(file);
  };
  fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handleFile(e.dataTransfer.files[0]); });
  add(main, 
    h("section", { class: "hero" },
      h("h1", {}, "Ask the collected corpus. See the evidence behind every answer."),
      h("p", {}, "An autonomous crawler continuously discovers public resources, retrieves the actual files, and extracts metadata across 41 categories — each value stored with its source, method, evidence type and time."),
    ),
    h("div", { class: "examples" }, examples.map((ex) => h("button", { class: "chip", type: "button", onclick: () => { qInput.value = ex; document.getElementById("search-form").requestSubmit(); } }, ex))),
    h("div", { class: "grid-3" },
      h("div", { class: "card stack" }, h("h3", {}, "Search"), h("p", { class: "muted" }, "Questions are answered from resources this system has already retrieved and inspected: contents and field-level observations are indexed together, with supporting documents and gaps.")),
      h("div", { class: "card stack" }, h("h3", {}, "Inspect any URL"), h("p", { class: "muted" }, "Paste a link to fetch it live (robots.txt respected) and extract HTML, JSON-LD, Open Graph, PDF, EXIF, media, dataset and API-schema metadata.")),
      h("div", { class: "card stack" }, fileInput, drop),
    ),
  );
}

async function navigateUpload(file) {
  cleanup();
  history.pushState(null, "", "/resource?upload=1");
  fill(main, h("div", { class: "card" }, h("p", { class: "progress" }, `Analyzing ${file.name} (${Math.round(file.size / 1024)} KB)…`), h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  try {
    const rec = await api("/api/v2/analyze/upload", { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(file.name), "x-content-type": file.type || "" }, body: file });
    renderRecord(rec, { upload: true });
  } catch (err) {
    fill(main, h("div", { class: "error" }, ERROR_TEXT[err.code] || err.message));
  }
}

// ------------------------------------------------------------------ search (collected corpus)
async function viewSearch(q) {
  document.title = `${q} — Omnispider`;
  qInput.value = q;
  const info = h("p", { class: "muted" }, "Searching the collected corpus…");
  const list = h("div", { class: "results" }, h("div", { class: "card" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  add(main, h("h1", {}, `Findings for “${q}”`), info, list);
  try {
    const res = await api(`/api/v2/search?q=${encodeURIComponent(q)}&limit=20`);
    const intent = res.intentCategories.length ? ` · about: ${res.intentCategories.map((c) => c.name).join(", ")}` : "";
    info.textContent = `${res.total} collected resource(s) match · ${res.corpus.indexed} resources indexed${intent} · ${res.tookMs} ms${res.discovery.queued ? " · " + res.discovery.reason : ""}`;
    if (!res.results.length) return fill(list, h("div", { class: "empty" }, res.discovery.queued ? "Nothing collected matches yet. Background discovery has been queued for this topic — retrieved resources become searchable as they are indexed." : "No collected resources match."));
    fill(list, res.results.map((r) => h("article", { class: "card result" },
      h("div", { class: "row" }, h("span", { class: "badge type" }, r.kind || "resource"), h("span", { class: "muted" }, r.host), h("span", { class: "spacer" }), h("span", { class: "muted" }, `retrieved ${fmtDate(r.retrievedAt)} · ${r.snapshots} snapshot(s)${r.changes ? ` · ${r.changes} change(s)` : ""}`)),
      h("h3", {}, h("a", { href: `/item?id=${r.resourceId}`, "data-link": true }, r.title || r.url)),
      h("div", { class: "url" }, short(r.finalUrl || r.url, 110)),
      r.snippet ? h("p", { class: "snippet" }, short(r.snippet.replace(/[«»]/g, ""), 300)) : null,
      r.evidence.length ? h("table", { class: "fields" }, h("tbody", {}, r.evidence.slice(0, 8).map((e) => h("tr", {},
        h("td", { class: "f" }, `${e.categoryName}: ${e.field}`),
        h("td", { class: "v" }, short(fmtVal(e.value), 240)),
        h("td", {}, h("span", { class: `status ${e.status}` }, STATUS_LABEL[e.status] || e.status), h("div", { class: "meta" }, `${e.evidenceType.replace("_", " ")} · ${e.scope} scope · ${e.method}`)))))) : null,
      r.gaps.length ? h("p", { class: "muted mt-10" }, "Gaps: ", r.gaps.map((g) => `${g.name} — ${g.state.replace(/_/g, " ")}`).join("; ")) : null,
      r.supportingResources.length ? h("p", { class: "muted mt-10" }, "Supporting: ", r.supportingResources.map((s, i) => [i ? ", " : "", h("a", { href: `/item?id=${s.id}`, "data-link": true }, `${s.purpose.replace("supporting:", "")} (${s.kind || s.state})`)])) : null,
      r.referencedBy.length ? h("p", { class: "muted" }, "Referenced by: ", r.referencedBy.map((s, i) => [i ? ", " : "", h("a", { href: `/item?id=${s.id}`, "data-link": true }, short(s.title || s.url, 60))])) : null,
    )));
  } catch (err) {
    fill(list, h("div", { class: "error" }, ERROR_TEXT[err.code] || err.message));
  }
}

async function viewItem(id) {
  fill(main, h("div", { class: "card" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  try {
    const d = await api(`/api/v2/resources/${encodeURIComponent(id)}`);
    const r = d.resource;
    const rec = {
      resourceId: String(r.id), requestedUrl: r.url, finalUrl: r.final_url || r.url, canonicalUrl: r.final_url || r.url, kind: r.kind || "unknown", httpStatus: r.http_status, mimeType: r.kind,
      title: r.title, description: r.description, fetchedAt: r.retrieved_at || r.discovered_at, contentHash: r.content_hash, fields: d.observations, categories: d.categories,
      relationships: d.relationships.outgoing.map((x) => ({ type: x.type, target: x.target_url, evidence: `${x.purpose ? x.purpose + " · " : ""}${x.scope || ""} ${x.target_state ? "· " + x.target_state : ""}` })),
      quality: d.quality || { completeness: 0, contradictions: [], notes: [], extractorErrors: [], coreFieldsMissing: [] },
      processing: { ...(d.processing || { extractors: [], totalMs: 0 }), cache: "hit", cachedAgeSeconds: Math.round((Date.now() - Date.parse(r.retrieved_at || r.discovered_at)) / 1000) },
    };
    await renderRecord(rec, { upload: false });
    add(main, h("h2", {}, "Processing stages"), h("div", { class: "card rels" }, Object.entries(d.stages).map(([k, v]) => h("div", { class: "rel" }, h("span", { class: "muted" }, k), h("span", {}, v ? String(v) : "—")))),
      h("h2", {}, `Snapshots (${d.snapshots.length})`), h("div", { class: "card rels" }, d.snapshots.map((s) => h("div", { class: "rel" }, h("span", { class: "mono" }, fmtDate(s.fetched_at)), h("span", {}, `HTTP ${s.http_status} · ${s.bytes} bytes · ${s.content_hash ? s.content_hash.slice(0, 12) : ""}${s.changed_fields ? ` · changed: ${s.changed_fields}` : ""}`)))),
      h("h2", {}, "Crawler events (this system's own audit trail)"), h("div", { class: "card rels" }, d.events.map((e) => h("div", { class: "rel" }, h("span", { class: "mono" }, e.ts.replace("T", " ").slice(0, 19)), h("span", {}, `${e.type}${e.detail ? " — " + short(e.detail, 200) : ""}`)))));
  } catch (err) {
    fill(main, h("div", { class: "error" }, err.status === 404 ? "This resource is not in the collected corpus." : err.message));
  }
}

// ------------------------------------------------------------------ resource
async function viewResource(url, fresh) {
  document.title = `Inspect — Omnispider`;
  qInput.value = url;
  fill(main, h("div", { class: "card" }, h("p", { class: "progress" }, `Fetching ${url} and running extractors…`), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
  const ctrl = new AbortController();
  active.push(ctrl);
  try {
    const rec = await api(`/api/v2/analyze?url=${encodeURIComponent(url)}${fresh ? "&fresh=1" : ""}`, { signal: ctrl.signal });
    renderRecord(rec, {});
  } catch (err) {
    if (err.name === "AbortError") return;
    fill(main, h("div", { class: "error" }, h("strong", {}, err.code || "Error"), h("p", {}, ERROR_TEXT[err.code] || err.message)), h("p", { class: "mt-12" }, h("a", { href: url, target: "_blank", rel: "noopener" }, "Open the original source ↗")));
  }
}

async function renderRecord(rec, { upload }) {
  const cats = await loadCategories();
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  document.title = `${rec.title || rec.finalUrl} — Omnispider`;
  let selected = null;
  const filterInput = h("input", { class: "filter", type: "search", placeholder: "Filter fields, values, methods…", "aria-label": "Filter fields" });
  const statusSel = h("select", { class: "filter narrow", "aria-label": "Filter by status" }, h("option", { value: "" }, "All statuses"), Object.entries(STATUS_LABEL).map(([v, l]) => h("option", { value: v }, l)));
  const fieldsWrap = h("div");
  const coverageEl = h("div", { class: "coverage", role: "group", "aria-label": "Category coverage" });

  const renderFields = () => {
    const term = filterInput.value.trim().toLowerCase();
    const st = statusSel.value;
    const groups = new Map();
    for (const f of rec.fields) {
      if (selected && f.category !== selected) continue;
      if (st && f.status !== st) continue;
      if (term && !`${f.field} ${fmtVal(f.value)} ${f.method} ${catName.get(f.category)}`.toLowerCase().includes(term)) continue;
      if (!groups.has(f.category)) groups.set(f.category, []);
      groups.get(f.category).push(f);
    }
    const out = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([cat, fs]) => h("section", { class: "group card" },
      h("h3", {}, `${cat}. ${catName.get(cat)}`, h("span", { class: "muted" }, ` ${fs.length} field${fs.length > 1 ? "s" : ""}`)),
      h("table", { class: "fields" },
        h("colgroup", {}, h("col", { class: "c-field" }), h("col", { class: "c-value" }), h("col", { class: "c-evidence" })),
        h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Value"), h("th", {}, "Evidence"))),
        h("tbody", {}, fs.map((f) => {
          const val = fmtVal(f.value);
          return h("tr", {},
            h("td", { class: "f" }, f.field, f.masked ? h("span", { class: "muted", title: "Redacted for privacy" }, " 🔒") : null),
            h("td", { class: "v" }, short(val, 1200), " ", h("button", { class: "copy", type: "button", "aria-label": `Copy ${f.field}`, onclick: (e) => copy(typeof f.value === "string" ? f.value : JSON.stringify(f.value), e.currentTarget) }, "copy")),
            h("td", {},
              h("span", { class: `status ${f.status}` }, STATUS_LABEL[f.status] || f.status),
              h("div", { class: "meta" }, f.method),
              f.evidence ? h("div", { class: "meta" }, short(f.evidence, 200)) : null,
              h("div", { class: "meta" }, `${f.extractor} · ${fmtDate(f.observedAt)}`),
            ),
          );
        })),
      ),
    ));
    fill(fieldsWrap, ...(out.length ? out : [h("div", { class: "empty" }, selected ? "No fields in this category for this resource." : "No fields match the filter.")]));
  };
  const renderCoverage = () => {
    fill(coverageEl, ...rec.categories.map((c) => h("button", {
      type: "button", class: `cat ${c.state}`, "aria-pressed": String(selected === c.id),
      title: `${c.name}: ${c.state.replace(/_/g, " ")}${c.note ? ` (${c.note})` : ""}`,
      onclick: () => { selected = selected === c.id ? null : c.id; renderCoverage(); renderFields(); },
    }, `${c.id}. ${c.name}`, h("span", { class: "n" }, c.state === "observed" ? `${c.fieldCount} field${c.fieldCount > 1 ? "s" : ""}` : c.state.replace(/_/g, " ")))));
  };
  filterInput.addEventListener("input", renderFields);
  statusSel.addEventListener("change", renderFields);

  const found = rec.categories.filter((c) => c.state === "observed").length;
  const applicable = rec.categories.filter((c) => c.state !== "not_applicable").length;
  const exportBase = `/api/v2/export?url=${encodeURIComponent(rec.requestedUrl)}`;
  const changesOut = h("div");
  const actions = upload
    ? [h("button", { class: "small ghost", type: "button", onclick: () => download(JSON.stringify(rec, null, 2), `metadata-${rec.resourceId}.json`, "application/json") }, "Export JSON")]
    : [
        h("a", { class: "btn small ghost", href: rec.finalUrl, target: "_blank", rel: "noopener" }, "Open source ↗"),
        h("a", { class: "btn small ghost", href: withKey(`${exportBase}&format=json`) }, "Export JSON"),
        h("a", { class: "btn small ghost", href: withKey(`${exportBase}&format=csv`) }, "Export CSV"),
        h("button", { class: "small ghost", type: "button", onclick: () => navigate(`/resource?url=${encodeURIComponent(rec.requestedUrl)}&fresh=1`) }, "Re-fetch now"),
        h("button", { class: "small ghost", type: "button", onclick: (e) => runChanges(rec.finalUrl, changesOut, e.currentTarget) }, "Compare with archive"),
        h("a", { class: "btn small ghost", href: `/crawl?url=${encodeURIComponent(rec.finalUrl)}`, "data-link": true }, "Crawl this site"),
      ];
  fill(main, 
    h("div", { class: "row" }, h("span", { class: "badge type" }, rec.kind), rec.httpStatus ? h("span", { class: "badge" }, `HTTP ${rec.httpStatus}`) : null, h("span", { class: "badge" }, rec.mimeType || "unknown type"),
      rec.processing.cache === "hit" ? h("span", { class: "badge", title: "Served from the in-memory cache" }, `cached · fetched ${rec.processing.cachedAgeSeconds}s ago`) : h("span", { class: "badge" }, "fetched live")),
    h("h1", {}, rec.title || rec.finalUrl),
    rec.description ? h("p", { class: "muted" }, short(rec.description, 400)) : null,
    h("div", { class: "mono muted" }, rec.finalUrl, rec.canonicalUrl !== rec.finalUrl ? ` → canonical ${rec.canonicalUrl}` : ""),
    h("div", { class: "toolbar" }, actions),
    changesOut,
    h("div", { class: "summary" },
      metric("Categories found", `${found} / ${applicable} applicable`),
      metric("Fields", rec.fields.length),
      metric("Completeness", `${Math.round(rec.quality.completeness * 100)}%`),
      metric("Contradictions", rec.quality.contradictions.length),
      metric("Relationships", rec.relationships.length),
      metric("Processing", `${rec.processing.totalMs} ms`),
      metric("Retrieved", rec.fetchedAt.replace("T", " ").slice(0, 19) + "Z"),
      metric("SHA-256", rec.contentHash ? rec.contentHash.slice(0, 16) + "…" : "—"),
    ),
    h("h2", {}, "41-category coverage"),
    coverageEl,
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "dot observed" }), "observed"), h("span", {}, h("i", { class: "dot missing" }), "applicable, not present"), h("span", {}, h("i", { class: "dot failed" }), "failed / not accessible"), h("span", {}, h("i", { class: "dot na" }), "not applicable to this resource type")),
    rec.quality.notes.length || rec.quality.contradictions.length || rec.quality.extractorErrors.length ? h("section", { class: "card mt-16" },
      h("h3", {}, "Quality & limitations"),
      h("ul", { class: "notes" },
        rec.quality.coreFieldsMissing.length ? h("li", {}, `Missing core fields: ${rec.quality.coreFieldsMissing.join(", ")}`) : null,
        rec.quality.notes.map((n) => h("li", {}, n)),
        rec.quality.contradictions.map((c) => h("li", {}, `Contradiction in ${c.field}: ${c.values.map((v) => `${short(fmtVal(v.value), 60)} (${v.method})`).join(" vs ")}`)),
        rec.quality.extractorErrors.map((e) => h("li", {}, `Extractor ${e.extractor} failed: ${e.error}`)),
      )) : null,
    h("h2", {}, "Metadata"),
    h("div", { class: "toolbar" }, filterInput, statusSel, h("button", { class: "small ghost", type: "button", onclick: () => { selected = null; filterInput.value = ""; statusSel.value = ""; renderCoverage(); renderFields(); } }, "Reset")),
    fieldsWrap,
    rec.relationships.length ? h("section", {}, h("h2", {}, `Relationships (${rec.relationships.length})`), h("div", { class: "card rels" }, rec.relationships.slice(0, 200).map((r) => h("div", { class: "rel" }, h("span", { class: "muted" }, r.type.replace(/_/g, " ")), h("span", {}, /^https?:/.test(r.target) ? h("a", { href: r.target, target: "_blank", rel: "noopener" }, short(r.target, 120)) : r.target, h("span", { class: "muted" }, ` — ${r.evidence}`)))))) : null,
    h("section", {}, h("h2", {}, "Processing"), h("div", { class: "card rels" }, rec.processing.extractors.map((x) => h("div", { class: "rel" }, h("span", { class: "mono" }, x.id), h("span", { class: x.error ? "" : "muted" }, `${x.ms} ms · ${x.fields} fields${x.error ? ` · error: ${x.error}` : ""}`))))),
  );
  renderCoverage();
  renderFields();
}

function metric(label, value) {
  return h("div", { class: "metric" }, h("div", { class: "label" }, label), h("div", { class: "value" }, String(value)));
}
function download(text, name, type) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
async function runChanges(url, out, btn) {
  btn.disabled = true;
  fill(out, h("div", { class: "card progress" }, "Comparing with the latest Internet Archive capture…"));
  try {
    const r = await api(`/api/v2/changes?url=${encodeURIComponent(url)}`);
    fill(out, h("div", { class: "card stack" },
      h("h3", {}, "Change detection"),
      r.previous ? h("p", {}, `Compared live (${fmtDate(r.current.fetchedAt)}) with capture of ${fmtDate(r.previous.capturedAt)} — `, h("a", { href: r.previous.archiveUrl, target: "_blank", rel: "noopener" }, "view capture ↗")) : h("p", { class: "muted" }, r.note),
      r.previous ? h("p", {}, `Bytes identical: ${r.contentChanged ? "no" : "yes"} · visible text changed: ${r.textChanged ? "yes" : "no"} · links +${r.linksAdded} / −${r.linksRemoved}`) : null,
      r.changes.length ? h("table", { class: "fields" }, h("tbody", {}, r.changes.map((c) => h("tr", {}, h("td", { class: "f" }, c.field), h("td", { class: "v" }, `before: ${short(fmtVal(c.before), 300)}`), h("td", { class: "v" }, `after: ${short(fmtVal(c.after), 300)}`))))) : r.previous ? h("p", { class: "muted" }, "No meaningful metadata changes.") : null,
    ));
  } catch (err) {
    fill(out, h("div", { class: "error" }, ERROR_TEXT[err.code] || err.message));
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ crawl
function viewCrawl(url) {
  document.title = "Crawl — Omnispider";
  const urlIn = h("input", { type: "url", required: true, placeholder: "https://example.org", value: url, name: "url" });
  const pagesIn = h("input", { type: "number", min: 1, max: 100, value: 20, name: "maxPages" });
  const depthIn = h("input", { type: "number", min: 0, max: 4, value: 2, name: "maxDepth" });
  const runBtn = h("button", { type: "submit" }, "Start crawl");
  const status = h("p", { class: "progress", "aria-live": "polite" });
  const tbody = h("tbody");
  const table = h("div", { class: "table-wrap card", hidden: true }, h("table", { class: "pages" }, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Page"), h("th", {}, "Status"), h("th", {}, "Categories"), h("th", {}, "Complete"), h("th", {}, "Language / dates / licence"), h("th", {}, ""))), tbody));
  let es = null;
  const stop = () => { if (es) { es.close(); es = null; } runBtn.textContent = "Start crawl"; };
  const form = h("form", { class: "crawl-form card", onsubmit: (e) => {
    e.preventDefault();
    if (es) { stop(); status.textContent += " · stopped by you"; return; }
    fill(tbody);
    table.hidden = false;
    runBtn.textContent = "Stop";
    history.replaceState(null, "", `/crawl?url=${encodeURIComponent(urlIn.value)}`);
    es = new EventSource(withKey(`/api/v2/crawl/stream?url=${encodeURIComponent(urlIn.value)}&maxPages=${pagesIn.value}&maxDepth=${depthIn.value}`));
    active.push(es);
    let n = 0;
    es.addEventListener("start", (ev) => { const d = JSON.parse(ev.data); status.textContent = `Crawling ${d.seed} · up to ${d.maxPages} pages, depth ${d.maxDepth} · ${d.crawlDelayMs} ms between requests (robots.txt aware)`; });
    es.addEventListener("page", (ev) => {
      const p = JSON.parse(ev.data);
      n++;
      const hl = p.highlights;
      tbody.append(h("tr", {},
        h("td", {}, n),
        h("td", {}, h("a", { href: `/resource?url=${encodeURIComponent(p.finalUrl)}`, "data-link": true }, short(p.title || p.finalUrl, 80)), h("div", { class: "muted mono" }, short(p.finalUrl, 90)), p.duplicateOf ? h("div", { class: "muted" }, `identical content to ${short(p.duplicateOf, 60)}`) : null),
        h("td", {}, String(p.status)),
        h("td", {}, `${p.categoriesFound.length}`),
        h("td", {}, `${Math.round(p.completeness * 100)}%`),
        h("td", { class: "muted" }, [hl.language, hl.published ? `pub ${fmtDate(hl.published)}` : null, hl.modified ? `mod ${fmtDate(hl.modified)}` : null, hl.license].filter(Boolean).join(" · ") || "—"),
        h("td", {}, h("a", { href: p.finalUrl, target: "_blank", rel: "noopener", "aria-label": "Open source" }, "↗")),
      ));
    });
    es.addEventListener("done", (ev) => { const d = JSON.parse(ev.data); status.textContent = `Done: ${d.pages} pages, ${d.skipped} skipped, ${d.errors} errors, ${d.duplicates} duplicates in ${(d.ms / 1000).toFixed(1)} s (${d.stoppedBy.replace("_", " ")}).`; stop(); });
    es.addEventListener("error", (ev) => { if (ev.data) { const d = JSON.parse(ev.data); tbody.append(h("tr", {}, h("td", {}, "!"), h("td", { colspan: 6, class: "muted" }, `${short(d.url, 90)} — ${d.error}`))); } else { stop(); } });
    es.addEventListener("skip", (ev) => { const d = JSON.parse(ev.data); tbody.append(h("tr", {}, h("td", {}, "–"), h("td", { colspan: 6, class: "muted" }, `skipped ${short(d.url, 90)} — ${d.reason}`))); });
  } },
    h("label", {}, "Site URL", urlIn), h("label", {}, "Max pages", pagesIn), h("label", {}, "Max depth", depthIn), runBtn);
  add(main, h("h1", {}, "Crawl a site"), h("p", { class: "muted" }, "Same-site, breadth-first, robots.txt and crawl-delay respected. Each page is analyzed and streamed here; nothing is stored. Closing this page cancels the crawl."), form, status, table);
}

// ------------------------------------------------------------------ categories & status
async function viewCategories() {
  document.title = "41 metadata categories — Omnispider";
  add(main, h("h1", {}, "41 metadata categories"), h("p", { class: "muted" }, "The registry the extractors report against. Each category lists where it applies, how it is extracted and its known limits."));
  const cats = await loadCategories();
  add(main, h("div", { class: "catlist" }, cats.map((c) => h("div", { class: "card" },
    h("h3", {}, `${c.id}. ${c.name} `, h("span", {}, `· ${c.sensitivity}`)),
    h("p", {}, c.definition),
    h("p", {}, h("b", {}, "Applies to: "), c.appliesTo === "all" ? "all resource types" : c.appliesTo.join(", ")),
    h("p", {}, h("b", {}, "Methods: "), c.methods.join(", ")),
    h("p", {}, h("b", {}, "Limits: "), c.limitations),
  ))));
}
function latencyTable(latency) {
  const head = h("thead", {}, h("tr", {}, ["Route", "Requests", "Errors", "p50 ms", "p95 ms", "p99 ms"].map((t) => h("th", {}, t))));
  const rows = Object.entries(latency).map(([r, s]) =>
    h("tr", {}, h("td", { class: "mono" }, r), h("td", {}, s.count), h("td", {}, s.errors), h("td", {}, Math.round(s.p50)), h("td", {}, Math.round(s.p95)), h("td", {}, Math.round(s.p99))),
  );
  const body = h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 6, class: "muted" }, "No API requests recorded yet.")));
  return h("div", { class: "table-wrap card" }, h("table", { class: "pages" }, head, body));
}

async function viewStatus() {
  document.title = "Status — Omnispider";
  add(main, h("h1", {}, "Service status"));
  try {
    const [info, stats] = await Promise.all([api("/api/v2/info"), api("/api/v2/stats")]);
    add(main, 
      h("div", { class: "summary" }, metric("Pipeline", info.pipelineVersion), metric("Uptime", `${Math.round(stats.uptimeSeconds / 60)} min`), metric("Memory (RSS)", `${Math.round(stats.memory.rss / 1048576)} MB`), metric("Analyses running", `${stats.analysisSlots.active} / ${stats.analysisSlots.limit}`), metric("Egress", info.egress), metric("Storage", "none")),
      h("h2", {}, "Search sources"),
      h("div", { class: "providers" }, stats.providers.map((p) => h("span", { class: `pstat ${p.circuitOpen ? "err" : "ok"}` }, `${p.name}${p.circuitOpen ? " (paused)" : ""}`))),
      h("h2", {}, "Latency since start"),
      latencyTable(stats.latency),
    );
  } catch (err) {
    add(main, h("div", { class: "error" }, err.message));
  }
}

route();
