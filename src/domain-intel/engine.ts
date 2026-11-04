import { createHmac } from "node:crypto";
import { domainToASCII } from "node:url";
import { getDomain, getPublicSuffix } from "tldts";
import { attributeProvider, collectDomain, collectHost, registrable, sameSite, type DomainFacts, type HostFacts } from "./collect.js";
import type { IntelNet } from "./net.js";
import { FAMILIES, RULES } from "./rules.js";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
/** Evidence states from the map: observed, hypothesized, validated (plus remediated, set by a retest in the client). */
export type FindingState = "observed" | "hypothesized" | "validated";
export interface Finding {
  id: string; rule: string; title: string; severity: Severity; state: FindingState; asset: string;
  evidence: string[]; why: string; next: string; fix: string; chain: Array<{ step: string; state: "observed" | "hypothesized" | "validated" | "not-tested" | "next" }>;
}
export type RuleStatus = "triggered" | "clear" | "not-observed" | "not-tested";
export interface RuleDisposition { id: string; family: string; status: RuleStatus; note: string; assets: string[]; findings: string[] }
export interface IntelNode { id: string; type: "domain" | "host" | "ip" | "provider" | "mail" | "reference"; label: string; inScope: boolean; detail?: string }
export interface IntelEdge { from: string; to: string; kind: string }
export interface WorkflowStep { id: string; label: string; family: string; ms: number; status: "done" | "partial" | "skipped"; detail: string }
export interface IntelReport {
  input: string; host: string; domain: string; generatedAt: string; tookMs: number;
  scope: { mode: "passive" | "authorized"; reason: string; ownedRoots: string[]; verification: { record: string; value: string }; root: string; registrableDomain: string; platform: string | null };
  decision: Record<string, boolean>;
  nodes: IntelNode[]; edges: IntelEdge[]; hosts: HostFacts[]; domainFacts: DomainFacts;
  findings: Finding[]; rules: RuleDisposition[];
  coverage: { families: Array<{ id: string; name: string; triggered: number; clear: number; notObserved: number; notTested: number; total: number }>; totals: Record<RuleStatus, number>; dispositioned: number; total: number };
  workflow: WorkflowStep[]; unknowns: string[]; limits: string[];
}

const DAY = 86_400_000;
const LIMITS = { budgetMs: 45_000, hostBudgetMs: 30_000, domainBudgetMs: 25_000 };

export function normalizeTarget(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  } catch {
    return null;
  }
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  try {
    if (/[^\x00-\x7f]/.test(s)) s = domainToASCII(s);
    if (!s) return null;
  } catch {
    return null;
  }
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(s)) return null;
  if (/\.(local|localhost|internal|lan|home|corp|intranet|test|invalid|example)$/.test(s) || s === "localhost") return null;
  if (!getDomain(s, { allowPrivateDomains: true })) return null;
  return s;
}

/** Ownership token: the owner publishes TXT `_void-verify.<registrable domain>` = this value to unlock authorized checks. */
export function verificationValue(domain: string, secret: string): string {
  return "void-domain-verify=" + createHmac("sha256", secret).update(scopeRootOf(domain)).digest("hex").slice(0, 32);
}

/**
 * The unit of scope. Normally the registrable domain; but a tenant name on a shared platform whose
 * suffix is not on the public-suffix list (x.up.railway.app) is scoped to the host itself, so the
 * platform's other customers are never treated as part of the target (00-02).
 */
export function scopeRootOf(host: string): string {
  const reg = registrable(host);
  const p = attributeProvider(host);
  return p && host !== reg && ["platform", "cdn", "cloud", "saas"].includes(p.kind) ? host : reg;
}

export interface RunOptions { net: IntelNet; ownedRoots: string[]; secret: string; now?: () => number; budgetMs?: number }

/** Common subdomain labels resolved through public DNS (wave 1). DNS answers only: nothing on the target is contacted for this. */
const COMMON_LABELS = ["www", "mail", "webmail", "smtp", "imap", "pop", "mx", "ns1", "ns2", "api", "app", "apps", "dev", "staging", "stage", "test", "qa", "uat", "beta", "demo", "admin", "portal", "dashboard", "console", "vpn", "remote", "sso", "auth", "login", "id", "accounts", "cdn", "static", "assets", "img", "images", "media", "files", "docs", "help", "support", "status", "blog", "shop", "store", "pay", "billing", "git", "gitlab", "jenkins", "ci", "grafana", "kibana", "monitor", "intranet", "internal", "m", "mobile", "old", "legacy", "new", "v2", "beta2", "assets2", "autodiscover", "owa", "exchange"];

type Q = { host: string; depth: number; parent: string | null; via: string; reference: boolean };

/**
 * One domain-intelligence run. Every new observation becomes a node; every node can branch into more
 * nodes (rule 6 of the map). A run proceeds in waves until nothing new remains: `wave()` collects the
 * next part of the frontier within a time budget, and `report()` re-analyses everything found so far.
 * There is no host, depth or reference cap; references (other parties' hosts) are recorded with DNS
 * only and never expanded or tested (00-02).
 */
export class DomainRun {
  readonly id = createHmac("sha256", String(Math.random())).update(String(Date.now())).digest("hex").slice(0, 24);
  readonly input: string; readonly host: string; domain: string; readonly registrableDomain: string;
  private now: () => number; private t0: number;
  scope!: IntelReport["scope"]; authorized = false; private ownedRoots: string[] = [];
  domainFacts!: DomainFacts;
  hosts = new Map<string, HostFacts>(); edges: IntelEdge[] = []; private edgeKeys = new Set<string>();
  private queued = new Set<string>(); private queue: Q[] = []; private probedIps = new Set<string>();
  workflow: WorkflowStep[] = []; waves = 0; lastUsed = Date.now();

  constructor(input: string, private opts: RunOptions) {
    this.now = opts.now ?? Date.now;
    this.t0 = this.now();
    const host = normalizeTarget(input);
    if (!host) throw new Error("INVALID_DOMAIN");
    this.input = input; this.host = host;
    this.registrableDomain = registrable(host);
    this.domain = scopeRootOf(host);
  }
  inScope = (h: string) => h === this.domain || h.endsWith("." + this.domain);
  private inOwned = (h: string) => this.ownedRoots.some((r) => h === r || h.endsWith("." + r));
  get frontier() { return this.queue.length; }

  private edge(from: string, to: string, kind: string) {
    const k = `${from}>${to}>${kind}`;
    if (!this.edgeKeys.has(k)) { this.edgeKeys.add(k); this.edges.push({ from, to, kind }); }
  }
  /** Add a node to explore. Already-known nodes only gain the edge (00-08). */
  enqueue(h: string, parent: string, via: string, depth: number) {
    h = h.toLowerCase().replace(/\.$/, "").replace(/^\*\./, "");
    if (!h || h === parent || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(h) || h.length > 253) return;
    this.edge(parent, h, via);
    if (this.queued.has(h)) return;
    this.queued.add(h);
    this.queue.push({ host: h, depth, parent, via, reference: !this.inScope(h) });
  }

  async init(budgetMs = LIMITS.budgetMs) {
    const { net, secret } = this.opts;
    // Domain-level collection is done once and completely; it is not cut short by a small wave budget.
    const deadline = this.now() + Math.max(budgetMs, LIMITS.domainBudgetMs);
    const budget = () => this.now() < deadline;
    const host = this.host;
    // 00-01 scope: operator-declared roots, or proof of control via a DNS TXT record on the scope root.
    const verification = { record: `_void-verify.${this.domain}`, value: verificationValue(this.domain, secret) };
    const owned = this.opts.ownedRoots.map((r) => r.trim().toLowerCase()).filter(Boolean);
    const declared = owned.some((r) => host === r || host.endsWith("." + r));
    const proof = declared ? null : await net.dns(verification.record, "TXT");
    const proven = !!proof?.answers.some((a) => a.data.replace(/"/g, "") === verification.value);
    this.authorized = declared || proven;
    this.ownedRoots = this.authorized ? (declared ? owned.filter((r) => host === r || host.endsWith("." + r)) : [this.domain]) : [];
    if (declared && this.ownedRoots[0] && this.ownedRoots[0].length > this.domain.length && this.ownedRoots[0].endsWith("." + this.domain)) this.domain = this.ownedRoots[0];
    const platform = this.domain !== this.registrableDomain ? attributeProvider(host) : null;
    this.scope = {
      mode: this.authorized ? "authorized" : "passive",
      reason: declared ? `${host} is listed by this service's operator as an owned asset (DOMAIN_INTEL_OWNED)` : proven ? `ownership proven by ${verification.record} TXT` : "No ownership proof: passive public observation only — DNS, registration, certificate logs, archives, TLS handshakes and the public pages a browser would load. No port probes, path guessing, login attempts or injected input.",
      ownedRoots: this.ownedRoots, verification, root: this.domain, registrableDomain: this.registrableDomain,
      platform: platform ? `${platform.name} hosts ${host}; scope is this host only. ${this.registrableDomain} and the platform’s other customers are dependencies, never targets (00-02).` : null,
    };
    this.workflow.push({ id: "scope", label: "Authorization and scope", family: "00", ms: 0, status: "done", detail: this.scope.reason });

    let s = this.now();
    this.domainFacts = await collectDomain(net, this.domain, { authorized: this.authorized, budget });
    const d = this.domainFacts;
    this.workflow.push({ id: "registration", label: "Registration, mail, DNSSEC, certificate logs, archives, lookalikes", family: "01", ms: this.now() - s, status: "done", detail: `${d.rdap ? `registrar ${d.rdap.registrar ?? "unknown"}` : "no RDAP"}; ${d.ct.names.length} names in CT; ${d.wayback.urls.length} archived URLs; ${d.lookalikes.filter((l) => l.resolves).length} lookalikes resolve` });

    // Seeds: the input, www, every certificate-log name, archived hostnames, SPF includes and resolvable common labels.
    this.queued.add(host);
    this.queue.push({ host, depth: 0, parent: null, via: "input", reference: false });
    const platformName = getPublicSuffix(this.domain, { allowPrivateDomains: true }) !== getPublicSuffix(this.domain);
    if (host === this.domain && this.domain === this.registrableDomain && !platformName) this.enqueue("www." + this.domain, host, "conventional www", 1);
    for (const n of d.ct.names.filter((n) => this.inScope(n)).sort((a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b))) this.enqueue(n, host, "certificate log", 1);
    for (const u of d.wayback.urls) { try { const h = new URL(u).hostname; if (this.inScope(h)) this.enqueue(h, host, "archived URL", 1); } catch { /* ignore */ } }
    for (const inc of d.mail.spfLookupHosts) this.enqueue(inc, host, "SPF include", 1);
    if (!platformName && this.domain === this.registrableDomain) {
      s = this.now();
      const probes = COMMON_LABELS.map((l) => `${l}.${this.domain}`).filter((n) => !this.queued.has(n));
      const res = await Promise.all(probes.map((n) => net.dns(n, "A")));
      const wild = new Set(d.wildcard?.a ?? []);
      let found = 0;
      probes.forEach((n, i) => {
        const a = res[i].answers.filter((x) => x.type === 1 || x.type === 5);
        // Under wildcard DNS every label resolves; only names that differ from the wildcard answer are real branches.
        if (a.length && !a.every((x) => wild.has(x.data))) { found++; this.enqueue(n, host, "DNS name", 1); }
      });
      this.workflow.push({ id: "labels", label: "Common subdomain names via public DNS", family: "02", ms: this.now() - s, status: "done", detail: `${probes.length} names asked, ${found} resolve${d.wildcard ? " (wildcard answers excluded)" : ""}` });
    }
  }

  /** Collect the next part of the frontier: breadth-first, in-scope before references, within the time budget. */
  async wave(budgetMs = LIMITS.budgetMs) {
    const { net } = this.opts;
    const deadline = this.now() + budgetMs;
    const budget = () => this.now() < deadline;
    const s = this.now();
    this.waves++;
    let collected = 0, rounds = 0;
    while (this.queue.length && budget()) {
      rounds++;
      this.queue.sort((a, b) => Number(a.reference) - Number(b.reference) || a.depth - b.depth);
      const batch = this.queue.splice(0, 8);
      // Each host gets its own collection budget: the wave budget only decides whether to start more hosts,
      // so a host started late in a wave is still collected completely.
      const done = await Promise.all(batch.map((q) => { const until = this.now() + LIMITS.hostBudgetMs; return collectHost(net, q.host, { depth: q.depth, parent: q.parent, via: q.via, inScope: this.inScope(q.host), reference: q.reference, authorized: this.authorized && this.inOwned(q.host), budget: () => this.now() < until, probedIps: this.probedIps }); }));
      for (const f of done) { this.hosts.set(f.host, f); collected++; this.branch(f); }
    }
    this.workflow.push({ id: "wave-" + this.waves, label: `Wave ${this.waves}: collect and branch (DNS → network → TLS → HTTP → pages)`, family: "02–05", ms: this.now() - s, status: this.queue.length ? "partial" : "done", detail: `${collected} nodes collected in ${rounds} rounds; ${this.hosts.size} known; ${this.queue.length} still in the frontier` });
  }

  /** Every observation that names another host becomes a branch. */
  private branch(f: HostFacts) {
    const at = f.depth + 1;
    for (const c of f.cnameChain) this.enqueue(c, f.host, "CNAME", at);
    if (f.reference) return; // other parties' hosts: recorded, never expanded (00-02)
    for (const r of f.https?.redirects ?? []) { try { this.enqueue(new URL(r.location).hostname, f.host, `redirect ${r.status}`, at); } catch { /* relative */ } }
    for (const ns of (f.dns.NS?.answers ?? []).filter((a) => a.type === 2)) this.enqueue(ns.data, f.host, "NS", at);
    for (const mx of (f.dns.MX?.answers ?? []).filter((a) => a.type === 15)) { const h = mx.data.split(/\s+/)[1]; if (h && h !== ".") this.enqueue(h, f.host, "MX", at); }
    for (const san of f.tls?.cert?.san ?? []) this.enqueue(san, f.host, "certificate SAN", at);
    for (const ip of f.ips) for (const p of ip.ptr) this.enqueue(p, f.host, "reverse DNS", at);
    const csp = f.https?.headers["content-security-policy"] ?? "";
    for (const m of csp.matchAll(/https?:\/\/([a-z0-9*.-]+\.[a-z]{2,})/gi)) this.enqueue(m[1], f.host, "CSP source", at);
    const p = f.page;
    if (p) {
      for (const l of p.links) { try { this.enqueue(new URL(l).hostname, f.host, "page link", at); } catch { /* ignore */ } }
      for (const x of p.externalHosts) this.enqueue(x, f.host, "external link", at);
      for (const sc of p.scripts) this.enqueue(sc.host, f.host, sc.firstParty ? "script" : "third-party script", at);
      for (const fr of p.iframes) { try { this.enqueue(new URL(fr).hostname, f.host, "iframe", at); } catch { /* ignore */ } }
      for (const w of p.signals.websocket) { try { this.enqueue(new URL(w).hostname, f.host, "websocket", at); } catch { /* ignore */ } }
    }
    for (const u of f.sitemap?.sample ?? []) { try { this.enqueue(new URL(u).hostname, f.host, "sitemap", at); } catch { /* ignore */ } }
    if (f.oidc?.issuer) { try { this.enqueue(new URL(f.oidc.issuer).hostname, f.host, "OIDC issuer", at); } catch { /* ignore */ } }
  }

  report(): IntelReport & { runId: string; frontier: number; waves: number; complete: boolean } {
    const { domain, host, authorized } = this;
    const domainFacts = this.domainFacts;
    const hostList = [...this.hosts.values()];
    const edges = this.edges;
    const skipped = this.queue.length;
    const findings = analyze(domainFacts, hostList, { authorized, host, domain, now: this.now() });
    const workflow = [...this.workflow, { id: "analyze", label: "Findings, causal chains and evidence states", family: "18", ms: 0, status: "done" as const, detail: `${findings.length} findings: ${(["critical", "high", "medium", "low", "info"] as Severity[]).map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(", ")}` }];
    const rules = disposition(domainFacts, hostList, findings, { authorized, host, domain, skipped });
    const totals = { triggered: 0, clear: 0, "not-observed": 0, "not-tested": 0 } as Record<RuleStatus, number>;
    for (const r of rules) totals[r.status]++;
    const coverage = {
      families: FAMILIES.map((f) => {
        const rs = rules.filter((r) => r.family === f.id);
        return { id: f.id, name: f.name, triggered: rs.filter((r) => r.status === "triggered").length, clear: rs.filter((r) => r.status === "clear").length, notObserved: rs.filter((r) => r.status === "not-observed").length, notTested: rs.filter((r) => r.status === "not-tested").length, total: rs.length };
      }),
      totals, dispositioned: rules.length, total: RULES.length,
    };
    const nodes: IntelNode[] = [{ id: domain, type: "domain", label: domain, inScope: true, detail: domainFacts.rdap?.registrar ?? undefined }];
    const extraEdges: IntelEdge[] = [];
    const nodeIds = new Set([domain]);
    for (const h of hostList) {
      if (!nodeIds.has(h.host)) { nodeIds.add(h.host); nodes.push({ id: h.host, type: h.reference ? "reference" : "host", label: h.host, inScope: !h.reference, detail: h.provider ? `${h.provider.name} (${h.provider.kind})` : h.addresses.length ? `${h.addresses.length} address(es)` : "no address" }); }
      if (h.host !== domain && this.inScope(h.host) && !edges.some((e) => e.to === h.host)) extraEdges.push({ from: domain, to: h.host, kind: "subdomain" });
      for (const ip of h.ips) {
        if (!nodeIds.has(ip.ip)) { nodeIds.add(ip.ip); nodes.push({ id: ip.ip, type: "ip", label: ip.ip, inScope: !ip.provider && authorized, detail: [ip.network, ip.org, ip.country].filter(Boolean).join(" · ") }); }
        extraEdges.push({ from: h.host, to: ip.ip, kind: "resolves" });
      }
      if (h.provider) {
        const pid = "provider:" + h.provider.name;
        if (!nodeIds.has(pid)) { nodeIds.add(pid); nodes.push({ id: pid, type: "provider", label: h.provider.name, inScope: false, detail: h.provider.kind }); }
        extraEdges.push({ from: h.host, to: pid, kind: "operated by" });
      }
    }
    const blindRun = hostList.filter((h) => !h.reference).length > 0 && hostList.filter((h) => !h.reference).every((h) => h.dnsFailed.length > 0 && !h.https?.status && !h.addresses.length);
    const unknowns = [
      ...(blindRun ? [`The target could not be observed: ${hostList[0]?.errors[0] ?? "DNS and HTTP lookups failed"}. Nothing in this report means the domain is safe or unsafe.`] : []),
      ...(skipped ? [`${skipped} discovered nodes are still in the frontier: continue the run to explore them.`] : []),
      "Server-side code, internal networks, cloud accounts, CI/CD and logs were not visible: absence of a finding is not evidence of safety.",
      ...(authorized ? [] : ["Authorized-only checks (exposed files, legacy TLS, CORS origin test, open-redirect test, port reachability) were not run: publish the ownership TXT record to enable them."]),
      ...(domainFacts.ct.error ? [domainFacts.ct.error] : []), ...(domainFacts.wayback.error ? [domainFacts.wayback.error] : []), ...(domainFacts.rdapError ? [domainFacts.rdapError] : []),
      "DKIM selectors cannot be listed; only common selector names were queried.",
      "Version banners were not matched against a vulnerability database; any version shown is a lead, not a confirmed CVE (18-02).",
    ];
    this.lastUsed = Date.now();
    return {
      runId: this.id, frontier: skipped, waves: this.waves, complete: skipped === 0,
      input: this.input, host, domain, generatedAt: new Date(this.t0).toISOString(), tookMs: this.now() - this.t0, scope: this.scope,
      decision: {
        domain: true, authorized, passive: !authorized, registration: true, newHost: hostList.filter((h) => !h.reference).length > 1, network: hostList.some((h) => h.addresses.length > 0),
        coverageOnly: hostList.filter((h) => !h.reference).length <= 1, web: hostList.some((h) => !!h.page), protocol: hostList.some((h) => !h.page && h.addresses.length > 0),
        pages: hostList.some((h) => !!h.page), auth: hostList.some((h) => !!h.page && (h.page.authLinks.login.length > 0 || h.page.forms.some((f) => f.password) || !!h.oidc)),
        identity: hostList.some((h) => !!h.page && (h.page.authLinks.login.length > 0 || h.page.forms.some((f) => f.password))),
        publicIO: hostList.some((h) => !!h.page), dataEndpoints: hostList.some((h) => !!h.page && (h.page.forms.length > 0 || h.page.signals.apiCalls.length > 0 || h.page.fileRoutes.length > 0)),
        inputs: hostList.some((h) => !!h.page && (h.page.forms.length > 0 || h.page.paramLinks.length > 0)), hypotheses: findings.length > 0, childNode: hostList.length > 1 || skipped > 0, report: true,
      },
      nodes, edges: [...edges, ...extraEdges], hosts: hostList, domainFacts, findings, rules, coverage, workflow, unknowns,
      limits: [`no host, depth or reference limit: the run continues in waves of about ${Math.round((this.opts.budgetMs ?? LIMITS.budgetMs) / 1000)} s until the frontier is empty`, "references (other parties' hosts) are resolved and recorded, never expanded or tested", "pages: 768 KiB, first-party scripts: 4 × 1.5 MiB per page"],
    };
  }
}

/** One call: scope, registration and the first wave. Use DomainRun directly to keep exploring. */
export async function runDomainIntel(input: string, opts: RunOptions) {
  const run = new DomainRun(input, opts);
  const total = opts.budgetMs ?? LIMITS.budgetMs, now = opts.now ?? Date.now, t0 = now();
  await run.init(Math.round(total * 0.5));
  await run.wave(Math.max(1000, total - (now() - t0)));
  return run.report();
}

// ---------------------------------------------------------------------------------------------
type Ctx = { authorized: boolean; host: string; domain: string; now: number };
const A = (h: HostFacts, t: number, type: string) => (h.dns[type]?.answers ?? []).filter((a) => a.type === t).map((a) => a.data);

function cookiesOf(h: HostFacts): Array<{ name: string; secure: boolean; httpOnly: boolean; sameSite: string | null; raw: string }> {
  const raw = h.https?.headers["set-cookie"];
  if (!raw) return [];
  return raw.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/).map((c) => c.trim()).filter(Boolean).map((c) => ({
    name: c.split("=")[0], secure: /;\s*secure/i.test(c), httpOnly: /;\s*httponly/i.test(c), sameSite: /;\s*samesite=(\w+)/i.exec(c)?.[1] ?? null, raw: c.replace(/=([^;]*)/, "=…"),
  }));
}

export function analyze(d: DomainFacts, hosts: HostFacts[], c: Ctx): Finding[] {
  const out: Finding[] = [];
  let n = 0;
  const add = (f: Omit<Finding, "id" | "chain"> & { chain?: Finding["chain"] }) => {
    const id = `F${String(++n).padStart(3, "0")}`;
    out.push({ id, ...f, chain: f.chain ?? [{ step: f.evidence[0] ?? f.title, state: "observed" }, { step: f.title, state: f.state }, { step: f.next, state: "next" }, { step: f.fix, state: "next" }] });
  };
  // 01 registration
  if (d.rdap?.expires) {
    const days = Math.round((Date.parse(d.rdap.expires) - c.now) / DAY);
    if (days < 60) add({ rule: "01-01", title: `Domain registration expires in ${days} days`, severity: days < 30 ? "high" : "medium", state: "observed", asset: d.domain, evidence: [`RDAP expiration ${d.rdap.expires}`], why: "An expired registration takes down the site, mail and every hostname under it, and the name can be re-registered by someone else.", next: "Confirm auto-renew and payment method with the registrar.", fix: "Renew and enable auto-renew; add a calendar alert 90 days before expiry." });
  }
  if (d.rdap && !d.rdap.status.some((s) => /transfer ?prohibited/.test(s))) add({ rule: "01-02", title: "No registrar transfer lock", severity: "low", state: "observed", asset: d.domain, evidence: [`RDAP status: ${d.rdap.status.join(", ") || "(none)"}`], why: "Without clientTransferProhibited, a compromised registrar account or social-engineered request can move the domain away more easily.", next: "Check the registrar account's lock and MFA settings.", fix: "Enable registrar lock (clientTransferProhibited) and MFA on the registrar account." });
  for (const l of d.lookalikes.filter((x) => x.resolves).slice(0, 8)) add({ rule: "01-04", title: `Lookalike domain ${l.name} is registered and resolves`, severity: "info", state: "observed", asset: l.name, evidence: [`${l.kind} of ${d.domain}`, `A ${l.a.join(", ")}`], why: "Confusable names can be used for phishing; ownership of this name is unknown and it may be legitimate or defensive.", next: "Check who owns it (RDAP) before drawing any conclusion; do not test it.", fix: "Consider defensive registration or monitoring; report confirmed abuse to the registrar." });
  if (d.idn.mixedScript) add({ rule: "01-04", title: "Domain mixes writing systems", severity: "medium", state: "observed", asset: d.domain, evidence: [`${d.domain} → ${d.idn.unicode}`], why: "Mixed-script names are the classic homograph pattern.", next: "Confirm the name is intentional.", fix: "Prefer single-script names; register the ASCII equivalent." });
  // 02 DNS / mail
  const root = hosts.find((h) => h.host === c.host) ?? hosts[0];
  const ns = root ? A(root, 2, "NS") : [];
  if (root && ns.length === 1) add({ rule: "02-01", title: "Only one nameserver", severity: "medium", state: "observed", asset: root.host, evidence: [`NS ${ns[0]}`], why: "A single nameserver is a single point of failure for every service under the name.", next: "Check whether the provider anycasts it.", fix: "Publish at least two nameservers on separate networks." });
  const mxs = root ? A(root, 15, "MX") : [];
  const sendsMail = mxs.length > 0 || d.mail.spf.length > 0;
  const known = (k: string) => !d.unavailable.includes(k);
  if (sendsMail && !d.mail.nullMx && known("txt") && known("dmarc")) {
    if (!d.mail.spf.length) add({ rule: "02-06", title: "No SPF record", severity: "medium", state: "observed", asset: d.domain, evidence: [`MX ${mxs.slice(0, 2).join(", ")}`, "no v=spf1 TXT"], why: "Receivers cannot tell which servers may send for this domain, so forged mail is easier to deliver.", next: "List every service that legitimately sends mail for the domain.", fix: "Publish `v=spf1 include:<providers> -all` (or ~all while testing)." });
    if (d.mail.spf.length > 1) add({ rule: "02-06", title: "Multiple SPF records (SPF permerror)", severity: "medium", state: "validated", asset: d.domain, evidence: d.mail.spf.map((s) => s.slice(0, 160)), why: "RFC 7208 makes two v=spf1 records a permanent error: SPF then fails for all mail.", next: "Merge the records.", fix: "Keep exactly one v=spf1 TXT record." });
    if (d.mail.spfAll && /^\+?all$/i.test(d.mail.spfAll)) add({ rule: "02-06", title: "SPF allows every sender (+all)", severity: "high", state: "validated", asset: d.domain, evidence: [d.mail.spf[0].slice(0, 200)], why: "+all authorizes the whole internet to send as this domain.", next: "Replace +all.", fix: "End the record with -all or ~all." });
    else if (d.mail.spfAll === "?all") add({ rule: "02-06", title: "SPF ends with ?all (neutral)", severity: "medium", state: "observed", asset: d.domain, evidence: [d.mail.spf[0].slice(0, 200)], why: "Neutral gives receivers no instruction about unauthorized senders.", next: "Confirm all senders are listed.", fix: "Move to ~all, then -all." });
    if (d.mail.spfLookups > 10) add({ rule: "02-06", title: `SPF needs ${d.mail.spfLookups} DNS lookups (limit 10)`, severity: "medium", state: "validated", asset: d.domain, evidence: [`includes walked: ${d.mail.spfLookupHosts.join(", ")}`], why: "Above 10 lookups SPF evaluation ends in permerror, so SPF fails.", next: "Count lookups per include.", fix: "Remove unused includes or flatten them." });
    if (d.mail.spfPtr) add({ rule: "02-06", title: "SPF uses the deprecated ptr mechanism", severity: "low", state: "observed", asset: d.domain, evidence: [d.mail.spf[0].slice(0, 200)], why: "ptr is slow, unreliable and discouraged by RFC 7208.", next: "Identify which senders rely on it.", fix: "Replace ptr with ip4/ip6/include." });
    if (!d.mail.dmarc.length) add({ rule: "02-07", title: "No DMARC policy", severity: "medium", state: "observed", asset: d.domain, evidence: [`_dmarc.${d.domain} has no v=DMARC1 record`], why: "Without DMARC, receivers have no owner instruction for mail that fails SPF/DKIM alignment, and the owner gets no reports of spoofing.", next: "Publish p=none with rua reporting to learn who sends as the domain.", fix: "Publish `v=DMARC1; p=none; rua=mailto:…`, review reports, then move to quarantine/reject.", chain: [{ step: `MX/SPF show the domain handles mail`, state: "observed" }, { step: "DMARC record missing", state: "observed" }, { step: "Spoofed mail may be delivered (receiver-dependent)", state: "hypothesized" }, { step: "Publish p=none + rua and read aggregate reports", state: "next" }, { step: "Move to p=quarantine, then p=reject", state: "next" }, { step: "Retest: DMARC record and alignment of legitimate senders", state: "next" }] });
    else if (/^none$/i.test(d.mail.dmarcPolicy ?? "")) add({ rule: "02-07", title: "DMARC is monitoring only (p=none)", severity: "low", state: "observed", asset: d.domain, evidence: [d.mail.dmarc[0].slice(0, 200)], why: "p=none asks receivers to take no action on failing mail.", next: "Review rua reports for legitimate senders that fail.", fix: "Move to p=quarantine, then p=reject." });
    if (d.mail.dmarcPct !== null && d.mail.dmarcPct < 100) add({ rule: "02-07", title: `DMARC applies to ${d.mail.dmarcPct}% of mail`, severity: "low", state: "observed", asset: d.domain, evidence: [d.mail.dmarc[0].slice(0, 200)], why: "pct below 100 leaves the rest of failing mail untreated.", next: "Raise pct as reports allow.", fix: "Set pct=100." });
    if (!d.mail.dkim.length && known("dkim")) add({ rule: "02-08", title: "No DKIM key found under common selectors", severity: "info", state: "hypothesized", asset: d.domain, evidence: ["queried 20 common selectors"], why: "Selectors cannot be enumerated, so a key may exist under another name.", next: "Check a message header (DKIM-Signature s=) from the domain.", fix: "Sign outgoing mail with DKIM (2048-bit)." });
    for (const k of d.mail.dkim.filter((k) => k.keyBits !== null && k.keyBits < 2048)) add({ rule: "02-08", title: `DKIM key ${k.selector} is about ${k.keyBits} bits`, severity: "low", state: "observed", asset: `${k.selector}._domainkey.${d.domain}`, evidence: ["public key length estimated from the record"], why: "Keys under 2048 bits are considered weak.", next: "Rotate the selector.", fix: "Publish a 2048-bit key under a new selector and retire this one." });
    if (!d.mail.mtaSts.dns && mxs.length && known("mta-sts")) add({ rule: "16-02", title: "No MTA-STS policy for inbound mail", severity: "info", state: "observed", asset: d.domain, evidence: [`_mta-sts.${d.domain} not published`], why: "Without MTA-STS, sending servers may fall back to unencrypted delivery if STARTTLS is stripped.", next: "Confirm all MX hosts present valid certificates.", fix: "Publish MTA-STS (mode: testing, then enforce) and TLS-RPT." });
    if (d.mail.smtp?.starttls === false) add({ rule: "03-06", title: "Mail server does not offer STARTTLS", severity: "medium", state: "observed", asset: d.mail.smtp.host, evidence: [`EHLO response from ${d.mail.smtp.host} lists no STARTTLS`], why: "Mail to this domain travels unencrypted.", next: "Check the MX provider configuration.", fix: "Enable STARTTLS with a valid certificate." });
    if (d.mail.smtp?.banner && /\d+\.\d+/.test(d.mail.smtp.banner)) add({ rule: "03-08", title: "Mail server banner discloses a version", severity: "info", state: "observed", asset: d.mail.smtp.host, evidence: [d.mail.smtp.banner.slice(0, 160)], why: "Version strings help target known issues; this is a lead, not a vulnerability (18-02).", next: "Confirm the product and patch level.", fix: "Suppress version details in the SMTP banner." });
  }
  if (!d.dnssec.ds && known("ds")) add({ rule: "02-10", title: "DNSSEC is not enabled", severity: "info", state: "observed", asset: d.domain, evidence: ["no DS record at the parent zone"], why: "Without DNSSEC, resolvers cannot verify answers are authentic (cache poisoning protection).", next: "Check whether the DNS provider supports one-click DNSSEC.", fix: "Enable DNSSEC and publish the DS record at the registrar." });
  if (d.wildcard) add({ rule: "02-13", title: "Wildcard DNS answers every subdomain", severity: "info", state: "validated", asset: `*.${d.domain}`, evidence: [`random name ${d.wildcard.probe} → ${d.wildcard.a.join(", ")}`], why: "Every name resolves, which hides which hosts are real and can widen exposure (e.g. cookies scoped to the parent).", next: "List intended subdomains.", fix: "Replace the wildcard with explicit records if not required." });
  const oldHosts = d.ct.names.filter((n) => !hosts.some((h) => h.host === n)).slice(0, 25);
  if (d.ct.names.length) add({ rule: "02-15", title: `${d.ct.names.length} hostnames appear in certificate transparency logs`, severity: "info", state: "observed", asset: d.domain, evidence: [d.ct.names.slice(0, 12).join(", ") + (d.ct.names.length > 12 ? " …" : ""), `issuers: ${d.ct.issuers.slice(0, 4).map((i) => `${i.name} (${i.count})`).join(", ")}`], why: "Every certificate is public: these names are known to anyone and each is a potential asset.", next: oldHosts.length ? `Review hosts not collected in this run: ${oldHosts.slice(0, 6).join(", ")}` : "All listed hosts were collected.", fix: "Decommission names that are no longer used; prefer wildcard certificates for internal names only if justified." });
  if (d.wayback.interesting.length) add({ rule: "05-10", title: `${d.wayback.interesting.length} archived URLs look like admin, backup, debug or API endpoints`, severity: "info", state: "hypothesized", asset: d.domain, evidence: d.wayback.interesting.slice(0, 8), why: "Old routes in the Internet Archive may still be served and may be less maintained.", next: "Owner: check whether these routes still respond and should.", fix: "Remove or protect legacy routes; return 410 for retired ones." });
  // Per host
  for (const h of hosts) {
    if (h.reference) continue;
    if (h.dangling) add({
      rule: "02-03", title: `Possible dangling DNS: ${h.host} → ${h.dangling.target}`, severity: "high", state: "hypothesized", asset: h.host, evidence: [`CNAME chain: ${h.host} → ${h.cnameChain.join(" → ")}`, h.dangling.reason],
      why: "If the provider lets another account claim this resource, they could serve content on your hostname. The map says: consider the hypothesis, do not claim takeover.", next: "Owner: confirm whether the provider resource is still yours.", fix: "Remove or repoint the stale record, or reclaim the resource; then retest DNS and hostname content.",
      chain: [
        { step: `${h.host} has a CNAME`, state: "observed" }, { step: `Destination ${h.dangling.target} is on ${h.dangling.provider}`, state: "observed" }, { step: h.dangling.reason, state: "observed" },
        { step: "Dangling-DNS / takeover hypothesis", state: "hypothesized" }, { step: "Owner confirms the resource is unclaimed and permits safe verification", state: "not-tested" },
        { step: "Provider lets another account claim the name (verified without taking production traffic)", state: "not-tested" }, { step: "Map cookies, links, scripts and login flows that trust the hostname", state: "not-tested" },
        { step: "Remove/repoint the record or reclaim the resource, then retest", state: "next" },
      ],
    });
    const priv = h.addresses.filter((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|fc|fd|::1$)/i.test(a));
    if (priv.length) add({ rule: "02-16", title: "Public DNS returns a private address", severity: "medium", state: "observed", asset: h.host, evidence: [`A/AAAA ${priv.join(", ")}`], why: "Internal addresses in public DNS leak network layout and enable DNS-rebinding style attacks on internal services.", next: "Confirm whether split-horizon DNS was intended.", fix: "Publish internal names only on internal resolvers." });
    const caa = A(h, 257, "CAA");
    if (!caa.length && h.tls?.cert && !h.dnsFailed.includes("CAA")) add({ rule: "02-09", title: "No CAA record", severity: "low", state: "observed", asset: h.host, evidence: ["no CAA at the name or any parent"], why: "Any public CA may issue certificates for the name.", next: `Current issuer: ${h.tls.cert.issuer.slice(0, 80)}`, fix: "Publish CAA records naming only the CAs you use." });
    else if (caa.length && h.tls?.cert) {
      const allowed = caa.filter((x) => /issue(wild)?\s/i.test(x)).map((x) => x.split(/\s+/).pop()!.replace(/"/g, "").toLowerCase());
      const issuer = h.tls.cert.issuer.toLowerCase();
      const known: Record<string, RegExp> = { "letsencrypt.org": /let's encrypt|isrg/, "digicert.com": /digicert/, "sectigo.com": /sectigo|comodo/, "pki.goog": /google trust/, "amazon.com": /amazon/, "globalsign.com": /globalsign/, "comodoca.com": /comodo|sectigo/ };
      const ok = allowed.some((a) => known[a]?.test(issuer)) || allowed.some((a) => !known[a]);
      if (!ok) add({ rule: "02-09", title: "Certificate issuer is not in CAA", severity: "medium", state: "observed", asset: h.host, evidence: [`CAA allows ${allowed.join(", ")}`, `issuer ${h.tls.cert.issuer.slice(0, 100)}`], why: "Either CAA is stale or a certificate came from an unexpected CA.", next: "Find out who requested the certificate.", fix: "Update CAA or revoke the unexpected certificate." });
    }
    if (h.tls?.cert) {
      const days = Math.round((Date.parse(h.tls.cert.validTo) - c.now) / DAY);
      if (days < 0) add({ rule: "04-01", title: "TLS certificate has expired", severity: "high", state: "validated", asset: h.host, evidence: [`valid to ${h.tls.cert.validTo}`], why: "Browsers block the site; users who click through are trained to ignore warnings.", next: "Renew now.", fix: "Renew and automate renewal (ACME)." });
      else if (days < 14) add({ rule: "04-01", title: `TLS certificate expires in ${days} days`, severity: "medium", state: "observed", asset: h.host, evidence: [`valid to ${h.tls.cert.validTo}`], why: "Renewal may be failing.", next: "Check the renewal job.", fix: "Renew; alert at 21 days." });
      if (h.tls.cert.selfSigned) add({ rule: "04-01", title: "Self-signed certificate", severity: "high", state: "observed", asset: h.host, evidence: [`subject = issuer = ${h.tls.cert.subject.slice(0, 80)}`], why: "Browsers cannot verify the server.", next: "Replace.", fix: "Use a publicly trusted certificate." });
      if (h.tls.authorizationError && /altname|hostname/i.test(h.tls.authorizationError)) add({ rule: "04-01", title: "Certificate does not cover this hostname", severity: "high", state: "validated", asset: h.host, evidence: [h.tls.authorizationError, `SAN: ${h.tls.cert.san.slice(0, 6).join(", ")}`], why: "Browsers reject the connection.", next: "Reissue with the hostname.", fix: "Add the hostname to the certificate SAN." });
      if (h.tls.cert.bits && (h.tls.cert.keyType === "EC" ? h.tls.cert.bits < 224 : h.tls.cert.keyType === "RSA" && h.tls.cert.bits < 2048)) add({ rule: "04-02", title: `Certificate key is ${h.tls.cert.keyType ?? ""} ${h.tls.cert.bits} bits`.replace("  ", " "), severity: "medium", state: "observed", asset: h.host, evidence: [`key ${h.tls.cert.bits} bits`], why: "RSA keys under 2048 bits are weak.", next: "Reissue.", fix: "Use RSA ≥2048 or ECDSA P-256." });
    }
    if (h.tls?.ok && h.tls.protocol && /TLSv1(\.1)?$/.test(h.tls.protocol)) add({ rule: "04-02", title: `Server negotiated ${h.tls.protocol}`, severity: "medium", state: "validated", asset: h.host, evidence: [`default handshake → ${h.tls.protocol} ${h.tls.cipher}`], why: "TLS 1.0/1.1 are deprecated (RFC 8996).", next: "Disable them.", fix: "Allow TLS 1.2 and 1.3 only." });
    for (const [v, ok] of Object.entries(h.legacyTls ?? {})) if (ok) add({ rule: "04-02", title: `${v} is still accepted`, severity: "medium", state: "validated", asset: h.host, evidence: [`handshake restricted to ${v} succeeded`], why: "Deprecated protocol versions allow downgrade to weaker cryptography (RFC 8996).", next: "Disable at the edge.", fix: "Set the minimum protocol to TLS 1.2." });
    const hh = h.https?.headers ?? {};
    if (h.http && h.https?.status && h.http.status >= 200 && h.http.status < 300) add({ rule: "04-03", title: "Plain HTTP serves content instead of redirecting", severity: "medium", state: "validated", asset: h.host, evidence: [`GET http://${h.host}/ → ${h.http.status}`], why: "Visitors who type the name or follow an http link are not upgraded and can be intercepted.", next: "Add a redirect.", fix: "Redirect all HTTP to HTTPS with 301/308 and enable HSTS." });
    if (h.https?.status && h.https.status < 400) {
      const hsts = hh["strict-transport-security"];
      if (!hsts) add({ rule: "04-04", title: "No HSTS header", severity: "low", state: "observed", asset: h.host, evidence: ["Strict-Transport-Security absent"], why: "Browsers will still try plain HTTP first on later visits, allowing SSL-stripping.", next: "Confirm every subdomain supports HTTPS.", fix: "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains`." });
      else {
        const age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
        if (age < 15_552_000) add({ rule: "04-04", title: `HSTS max-age is ${Math.round(age / 86400)} days`, severity: "low", state: "observed", asset: h.host, evidence: [hsts], why: "Short HSTS lifetimes expire between visits.", next: "Raise after confirming HTTPS everywhere.", fix: "Use max-age ≥ 15552000 (180 days), ideally 31536000." });
      }
      const csp = hh["content-security-policy"];
      const page = h.page;
      if (page) {
        if (!csp) add({ rule: "12-02", title: "No Content-Security-Policy", severity: page.forms.length || page.scripts.length ? "medium" : "low", state: "observed", asset: h.host, evidence: [`page loads ${page.scripts.length} scripts and has ${page.forms.length} forms`], why: "Without CSP, an injection anywhere on the page can run arbitrary script.", next: "Inventory script sources.", fix: "Add a CSP with script-src limited to your origins and nonces; start with Report-Only." });
        else {
          const weak = [/'unsafe-inline'/.test(csp) && !/'nonce-|'strict-dynamic'/.test(csp) ? "'unsafe-inline' without nonces" : "", /'unsafe-eval'/.test(csp) ? "'unsafe-eval'" : "", /(script-src|default-src)[^;]*\s\*(\s|;|$)/.test(csp) ? "wildcard script source" : "", !/frame-ancestors/.test(csp) ? "no frame-ancestors" : "", !/object-src\s+'none'/.test(csp) && !/default-src\s+'none'/.test(csp) ? "object-src not 'none'" : ""].filter(Boolean);
          if (weak.length) add({ rule: "12-02", title: "Content-Security-Policy has gaps", severity: "low", state: "observed", asset: h.host, evidence: [...weak, csp.slice(0, 220)], why: "These directives reduce how much protection the policy gives against injected script or framing.", next: "Check which inline scripts need nonces.", fix: "Remove unsafe-inline/unsafe-eval, add frame-ancestors and object-src 'none'." });
        }
        if (!hh["x-frame-options"] && !/frame-ancestors/.test(csp ?? "")) add({ rule: "04-10", title: "Page can be framed by other sites", severity: page.forms.length ? "medium" : "low", state: "observed", asset: h.host, evidence: ["no X-Frame-Options and no CSP frame-ancestors"], why: "Clickjacking: another site can overlay this page and trick clicks.", next: "Confirm no partner needs to frame it.", fix: "Send `Content-Security-Policy: frame-ancestors 'self'` (or X-Frame-Options: DENY)." });
        if (!/nosniff/i.test(hh["x-content-type-options"] ?? "")) add({ rule: "04-10", title: "No X-Content-Type-Options: nosniff", severity: "low", state: "observed", asset: h.host, evidence: ["header absent"], why: "Browsers may MIME-sniff responses into executable types.", next: "—", fix: "Send `X-Content-Type-Options: nosniff`." });
        if (!hh["referrer-policy"]) add({ rule: "04-10", title: "No Referrer-Policy", severity: "info", state: "observed", asset: h.host, evidence: ["header absent (browser default strict-origin-when-cross-origin applies)"], why: "Full URLs may leak to other sites in older browsers.", next: "—", fix: "Send `Referrer-Policy: strict-origin-when-cross-origin`." });
        for (const s of page.secrets.filter((x) => !x.placeholder)) add({ rule: "15-07", title: `Credential-like ${s.type} in public ${/script/.test(s.location) || /\.js/.test(s.location) ? "JavaScript" : "HTML"}`, severity: s.confidence === "high" && !/^(jwt|google-api-key)$/.test(s.type) ? "high" : "medium", state: "observed", asset: h.host, evidence: [`${s.type} (${s.length} characters, value withheld) at ${s.location}`], why: "Anything shipped to the browser is public. Some keys are meant to be public (browser API keys restricted by referrer); others grant access.", next: "Owner: identify the key and its permissions; do not use it.", fix: "Rotate it if it is a secret; move secret calls server-side; restrict publishable keys by origin/scope." });
        for (const f of page.forms) {
          if (f.password && (f.method === "get" || f.insecureAction)) add({ rule: "06-03", title: f.method === "get" ? "Password form submits with GET" : "Password form posts over plain HTTP", severity: "high", state: "observed", asset: h.host, evidence: [`form action ${f.action} method ${f.method.toUpperCase()}`], why: f.method === "get" ? "Passwords end up in URLs, history, logs and Referer headers." : "Credentials travel unencrypted.", next: "Fix the form.", fix: "Use POST to an https: action." });
          else if (f.method === "post" && !f.csrf && f.inputs.length) add({ rule: "07-07", title: "POST form without a visible anti-CSRF field", severity: "low", state: "hypothesized", asset: h.host, evidence: [`form → ${f.action} fields: ${f.inputs.slice(0, 8).join(", ")}`], why: "Protection may come from SameSite cookies or headers instead; this needs an authorized test to confirm.", next: "Authorized test: replay the form from another origin with a test account.", fix: "Use synchronizer tokens or rely on SameSite=Lax/Strict session cookies plus Origin checks." });
        }
        if (page.mixedContent.length) add({ rule: "04-03", title: "HTTPS page references plain-HTTP resources", severity: "medium", state: "observed", asset: h.host, evidence: page.mixedContent.slice(0, 5), why: "Mixed content can be modified in transit; browsers block or warn.", next: "—", fix: "Load every resource over HTTPS." });
        const noSri = page.scripts.filter((s) => !s.firstParty && !s.integrity);
        if (noSri.length) add({ rule: "12-01", title: `${noSri.length} third-party scripts without Subresource Integrity`, severity: "low", state: "observed", asset: h.host, evidence: noSri.slice(0, 6).map((s) => s.src), why: "If the third party is compromised, its script runs with full access to this page.", next: "Decide which providers are trusted.", fix: "Pin static third-party scripts with integrity= hashes, or self-host them." });
        if (page.signals.sourceMaps.length) add({ rule: "05-09", title: "Public JavaScript references source maps", severity: "low", state: "hypothesized", asset: h.host, evidence: page.signals.sourceMaps.slice(0, 4), why: "Source maps can reveal original source, comments and internal paths. The map file itself was not downloaded (00-04).", next: "Owner: check whether the .map URLs are served.", fix: "Do not deploy source maps publicly, or restrict them." });
        if (page.redirectParams.length) add({ rule: "04-09", title: h.openRedirect?.external ? "Open redirect confirmed" : "Redirect parameter in links", severity: h.openRedirect?.external ? "medium" : "info", state: h.openRedirect?.external ? "validated" : "hypothesized", asset: h.host, evidence: h.openRedirect ? [`${h.openRedirect.url} → Location ${h.openRedirect.location ?? "(none)"}`] : page.redirectParams.slice(0, 3), why: "Unchecked redirect targets let attackers send victims through a trusted URL to a malicious site, and can leak OAuth codes.", next: c.authorized ? "Validated above." : "Authorized test: set the parameter to an external URL and observe Location.", fix: "Allow only relative paths or an allow-list of hosts." });
      }
      const server = hh.server ?? "", powered = hh["x-powered-by"] ?? "";
      const ver = [server, powered, hh["x-aspnet-version"] ?? "", hh["x-generator"] ?? ""].filter((v) => /\d+\.\d+/.test(v));
      if (ver.length) add({ rule: "03-08", title: "Software version disclosed in headers", severity: "low", state: "observed", asset: h.host, evidence: ver, why: "Exact versions make known-vulnerability targeting easy. This is not a confirmed vulnerability (18-02).", next: "Confirm the patch level.", fix: "Hide version strings (server_tokens off, remove X-Powered-By)." });
      for (const ck of cookiesOf(h)) {
        const sess = /sess|sid|auth|token|jwt|login|remember/i.test(ck.name);
        const miss = [!ck.secure ? "Secure" : "", sess && !ck.httpOnly ? "HttpOnly" : "", !ck.sameSite ? "SameSite" : ""].filter(Boolean);
        if (miss.length) add({ rule: "07-01", title: `Cookie ${ck.name} lacks ${miss.join(", ")}`, severity: sess && miss.length ? "medium" : "low", state: "observed", asset: h.host, evidence: [ck.raw.slice(0, 160)], why: "Missing flags expose cookies to network attackers (Secure), script access (HttpOnly) or cross-site requests (SameSite).", next: sess ? "Confirm whether this is a session cookie." : "—", fix: "Set Secure; HttpOnly for session cookies; SameSite=Lax or Strict." });
      }
      if (hh["set-cookie"] && /public/i.test(hh["cache-control"] ?? "") && !/private|no-store/i.test(hh["cache-control"] ?? "")) add({ rule: "13-08", title: "Response sets cookies but is marked publicly cacheable", severity: "medium", state: "hypothesized", asset: h.host, evidence: [`Cache-Control: ${hh["cache-control"]}`, "Set-Cookie present"], why: "A shared cache could store one visitor's cookie or personalized page and serve it to others.", next: "Authorized test with two accounts through the CDN.", fix: "Mark personalized responses private/no-store; strip Set-Cookie on cacheable responses." });
      const acao = hh["access-control-allow-origin"];
      if (acao === "*" && /true/i.test(hh["access-control-allow-credentials"] ?? "")) add({ rule: "04-08", title: "CORS allows any origin with credentials", severity: "high", state: "observed", asset: h.host, evidence: ["Access-Control-Allow-Origin: *", "Access-Control-Allow-Credentials: true"], why: "Browsers reject this exact pair, but it signals a permissive CORS layer that may reflect origins elsewhere.", next: "Authorized test with an Origin header.", fix: "Allow-list origins explicitly." });
      if (h.cors?.reflected) add({ rule: "04-08", title: `CORS reflects arbitrary origins${h.cors.credentials ? " with credentials" : ""}`, severity: h.cors.credentials ? "high" : "low", state: "validated", asset: h.host, evidence: [`Origin: ${h.cors.origin} → Access-Control-Allow-Origin: ${h.cors.acao}`, `credentials: ${h.cors.credentials}`], why: h.cors.credentials ? "Any website can read authenticated responses from this origin in a victim's browser." : "Any website can read public responses; harmless for public data.", next: "Check which endpoints return user data.", fix: "Allow-list exact origins; never reflect with credentials." });
    }
    if (h.notFound?.leaks.length) add({ rule: "05-12", title: "Error page leaks internals", severity: "medium", state: "observed", asset: h.host, evidence: h.notFound.leaks, why: "Stack traces and debug pages reveal code paths, versions and configuration.", next: "Disable debug mode.", fix: "Serve generic error pages in production; log details server-side." });
    if (h.notFound?.soft404) add({ rule: "05-12", title: "Unknown paths return 200 (soft 404)", severity: "info", state: "observed", asset: h.host, evidence: ["random path answered 200"], why: "Monitoring and scanners cannot distinguish missing pages; usually an SPA fallback.", next: "—", fix: "Return 404 for unknown routes where possible." });
    if (h.https?.status && h.https.status < 400 && h.page && h.securityTxt && (h.securityTxt.status !== 200 || !h.securityTxt.contact.length) && h.host === c.host) add({ rule: "17-02", title: "No security.txt (vulnerability contact)", severity: "info", state: "observed", asset: h.host, evidence: [h.securityTxt.status === 200 ? "/.well-known/security.txt → 200, but the response has no Contact field (likely a catch-all page)" : `/.well-known/security.txt → ${h.securityTxt.status}`], why: "Researchers who find a problem have no published way to report it (RFC 9116).", next: "—", fix: "Publish /.well-known/security.txt with Contact and Expires." });
    else if (h.securityTxt?.expired) add({ rule: "17-02", title: "security.txt has expired", severity: "low", state: "observed", asset: h.host, evidence: [`Expires: ${h.securityTxt.expires}`], why: "An expired file may point to a dead contact.", next: "—", fix: "Update Expires and contacts." });
    for (const e of (h.exposures ?? []).filter((x) => x.signature)) {
      const benign = /openid-configuration|swagger|openapi|actuator\/health|graphql/.test(e.path);
      add({ rule: benign ? "10-01" : "13-06", title: `${e.path} is publicly served`, severity: benign ? "info" : /\.git|\.env|backup|composer\.lock|phpinfo|server-status/.test(e.path) ? "critical" : "medium", state: "validated", asset: h.host, evidence: [`GET ${e.path} → ${e.status}, ${e.bytes} bytes, format signature matched (content not stored)`], why: benign ? "Public API/identity metadata; expected for many services but widens the documented surface." : "Repository data, environment files and backups commonly contain credentials and source.", next: benign ? "Confirm it should be public." : "Owner: block the path now and rotate any credentials it could contain.", fix: benign ? "Keep only if intended." : "Deny the path at the web server/edge; remove the file from the deploy; rotate secrets." });
    }
    for (const p of (h.ports ?? []).filter((x) => x.open && ![80, 443].includes(x.port))) add({ rule: [3306, 5432, 6379, 9200, 11211, 27017, 1433, 1521].includes(p.port) ? "03-05" : [22, 3389, 5900, 23].includes(p.port) ? "03-04" : "03-02", title: `Port ${p.port} is reachable from the internet`, severity: [6379, 9200, 11211, 27017, 2375, 23].includes(p.port) ? "high" : [3306, 5432, 1433, 1521, 3389, 5900, 445].includes(p.port) ? "high" : "medium", state: "observed", asset: `${h.host}:${p.port}`, evidence: [p.banner ? `banner: ${p.banner.slice(0, 120)}` : "TCP connect succeeded"], why: "Databases, caches, remote desktop and admin services should not be reachable from everywhere.", next: "Confirm whether exposure is intended; check authentication.", fix: "Restrict with firewall/security groups to known addresses or a VPN." });
  }
  // Order: severity, then state.
  const sev: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return out.sort((a, b) => sev[a.severity] - sev[b.severity] || a.rule.localeCompare(b.rule));
}

// ---------------------------------------------------------------------------------------------
// Every rule of the map gets a disposition (18-07 / 18-08): triggered, clear, not observed, or not tested with its blocker.
const NEEDS_ACCOUNTS = "Not tested: needs written authorization and test accounts (and often source or role definitions). Passive observation cannot exercise authenticated behaviour.";
const NEEDS_INTERNAL = "Not tested: needs internal access (configuration, logs, cloud console, CI/CD or code). Not observable from the public internet.";
const NEEDS_ACTIVE = "Not tested: confirming this needs active input testing within an authorized scope; only the public indicator is recorded.";

export function disposition(d: DomainFacts, hosts: HostFacts[], findings: Finding[], c: { authorized: boolean; host: string; domain: string; skipped: number }): RuleDisposition[] {
  const live = hosts.filter((h) => !h.reference);
  const pages = live.filter((h) => !!h.page);
  const any = (fn: (h: HostFacts) => boolean) => live.filter(fn).map((h) => h.host);
  const P = (fn: (p: NonNullable<HostFacts["page"]>, h: HostFacts) => boolean) => pages.filter((h) => fn(h.page!, h)).map((h) => h.host);
  type R = { status: RuleStatus; note: string; assets?: string[] };
  const t = (assets: string[], note: string): R => (assets.length ? { status: "triggered", note, assets } : { status: "not-observed", note: "Precondition not observed in this run." });
  const authOnly = (assets: string[], note: string): R => (c.authorized ? t(assets, note) : { status: "not-tested", note: "Not tested: authorized-only check (publish the ownership record to enable). " + note });
  const E: Record<string, () => R> = {
    "00-01": () => ({ status: "triggered", note: c.authorized ? "Authorized scope: owner-verified checks enabled for owned roots only." : "No authorization: passive public observation only.", assets: [c.host] }),
    "00-02": () => t(hosts.filter((h) => h.provider || h.reference).map((h) => h.host), `Attributed to vendors/third parties and not tested: ${[...new Set(hosts.map((h) => h.provider?.name).filter(Boolean))].join(", ") || "references only"}.`),
    "00-03": () => t(hosts.map((h) => h.host), `${hosts.length} assets recorded with source, parent and discovery path.`),
    "00-04": () => t([...any((h) => !!h.exposures?.some((e) => e.signature)), ...P((p) => p.secrets.length > 0)], "Only indicators recorded (status, size, type); contents and secret values were not stored."),
    "00-05": () => ({ status: "clear", note: "No test in this tool alters data, sends messages, charges money or interrupts service.", assets: [] }),
    "00-06": () => ({ status: findings.some((f) => f.state === "hypothesized") ? "triggered" : "clear", note: `${findings.filter((f) => f.state === "hypothesized").length} findings kept as hypotheses; banners/versions reported as leads, not vulnerabilities.`, assets: [] }),
    "00-07": () => t(hosts.filter((h) => h.errors.length > 0).map((h) => h.host), "Hosts with transient errors are listed with timestamps; no present-tense exposure is claimed for them."),
    "00-08": () => ({ status: "triggered", note: "Already-explored nodes are linked as edges and not revisited.", assets: [] }),
    "01-01": () => (d.rdap ? { status: findings.some((f) => f.rule === "01-01") ? "triggered" : "clear", note: `Created ${d.rdap.created ?? "?"}, expires ${d.rdap.expires ?? "?"}, status ${d.rdap.status.join(", ") || "?"}.`, assets: [d.domain] } : { status: "not-tested", note: d.rdapError ?? "RDAP unavailable." }),
    "01-02": () => (d.rdap?.registrar ? { status: findings.some((f) => f.rule === "01-02") ? "triggered" : "clear", note: `Registrar ${d.rdap.registrar}; abuse ${d.rdap.registrarAbuse ?? "not published"}.`, assets: [d.domain] } : { status: "not-tested", note: "Registrar not disclosed." }),
    "01-03": () => t(d.ct.names.filter((n) => /\b(dev|staging|stage|test|qa|uat|admin|internal|vpn|old|beta|preview|api)\b/.test(n)), "Naming patterns in certificate logs suggest environment/role hosts."),
    "01-04": () => t([...(d.idn.punycode ? [d.domain] : []), ...d.lookalikes.filter((l) => l.resolves).map((l) => l.name)], `${d.lookalikes.length} confusable variants checked by DNS.`),
    "01-05": () => t(any((h) => (h.https?.redirects ?? []).some((r) => { try { return !sameSite(new URL(r.location).hostname, h.host); } catch { return false; } })), "Cross-domain redirects recorded."),
    "01-06": () => (d.rdap?.changed ? { status: "triggered", note: `Registration last changed ${d.rdap.changed}. History beyond RDAP is not available passively.`, assets: [d.domain] } : { status: "not-tested", note: "No change history available." }),
    "02-01": () => t(any((h) => A(h, 2, "NS").length > 0), `Nameservers: ${hosts.flatMap((h) => A(h, 2, "NS")).slice(0, 4).join(", ")}`),
    "02-02": () => t(any((h) => h.addresses.length > 0), "Addresses resolved and attributed."),
    "02-03": () => t(any((h) => h.cnameChain.length > 0), `CNAME chains followed${findings.some((f) => f.rule === "02-03") ? "; dangling hypothesis raised" : "; no dangling target found"}.`),
    "02-04": () => t(any((h) => A(h, 15, "MX").length > 0), d.mail.nullMx ? "Null MX: the domain accepts no mail." : "MX hosts recorded as references."),
    "02-05": () => t(any((h) => A(h, 16, "TXT").length > 0), "TXT records reviewed (verification tokens reveal SaaS relationships)."),
    "02-06": () => d.unavailable.includes("txt") ? { status: "not-tested", note: "TXT lookup failed; SPF unknown." } : (d.mail.spf.length ? { status: findings.some((f) => f.rule === "02-06") ? "triggered" : "clear", note: `${d.mail.spf[0].slice(0, 120)} · ${d.mail.spfLookups} lookups`, assets: [d.domain] } : { status: findings.some((f) => f.rule === "02-06") ? "triggered" : "not-observed", note: "No SPF record." }),
    "02-07": () => d.unavailable.includes("dmarc") ? { status: "not-tested", note: "DMARC lookup failed; policy unknown." } : ({ status: findings.some((f) => f.rule === "02-07") ? "triggered" : d.mail.dmarc.length ? "clear" : "not-observed", note: d.mail.dmarc[0]?.slice(0, 120) ?? "No DMARC record.", assets: [d.domain] }),
    "02-08": () => ({ status: d.mail.dkim.length ? (findings.some((f) => f.rule === "02-08" && f.state !== "hypothesized") ? "triggered" : "clear") : "not-observed", note: d.mail.dkim.length ? `Selectors: ${d.mail.dkim.map((k) => k.selector).join(", ")}` : "None under 20 common selectors.", assets: [d.domain] }),
    "02-09": () => ({ status: findings.some((f) => f.rule === "02-09") ? "triggered" : "clear", note: "CAA (including inherited) compared with the served certificate issuer.", assets: [] }),
    "02-10": () => (d.unavailable.includes("ds") ? { status: "not-tested", note: "DS lookup failed; DNSSEC state unknown." } : { status: d.dnssec.ds ? "clear" : "triggered", note: d.dnssec.ds ? `DS present${d.dnssec.validated ? ", resolver validated (AD)" : ""}.` : "No DS record.", assets: [d.domain] }),
    "02-11": () => t(live.filter((h) => h.ips.some((i) => i.ptr.length)).map((h) => h.host), "PTR names recorded."),
    "02-12": () => t(any((h) => A(h, 65, "HTTPS").length > 0), "HTTPS/SVCB records recorded."),
    "02-13": () => (d.unavailable.includes("wildcard") ? { status: "not-tested", note: "Random-label lookup failed; wildcard state unknown." } : d.wildcard ? { status: "triggered", note: "Wildcard confirmed with a random label.", assets: [`*.${d.domain}`] } : { status: "clear", note: "Random label did not resolve.", assets: [] }),
    "02-14": () => ({ status: "not-tested", note: "Zone transfer (AXFR) is an active request to the nameservers; nameservers here are operated by DNS providers (00-02), so it was not attempted." }),
    "02-15": () => t(d.ct.names.length ? [d.domain] : [], `${d.ct.names.length} names in CT; ${d.ct.certificates} unexpired certificates.`),
    "02-16": () => (findings.some((f) => f.rule === "02-16") ? { status: "triggered", note: "Private address in public DNS.", assets: [] } : { status: "clear", note: "No private addresses in public answers; rebinding itself needs an authorized test.", assets: [] }),
    "03-01": () => (c.authorized ? t(live.flatMap((h) => h.ips.filter((i) => !i.provider).map((i) => i.ip)), "Addresses not attributed to a provider are in scope.") : { status: "not-tested", note: "No authorization: addresses recorded and attributed only." }),
    "03-02": () => authOnly(any((h) => !!h.ports?.some((p) => p.open)), "TCP reachability of common service ports (connect only)."),
    "03-03": () => t(any((h) => (h.https?.status ?? 0) > 0 || (h.http?.status ?? 0) > 0), "HTTP(S) answers recorded."),
    "03-04": () => authOnly(any((h) => !!h.ports?.some((p) => p.open && [22, 3389, 5900, 23].includes(p.port))), "SSH/RDP/VNC/Telnet reachability."),
    "03-05": () => authOnly(any((h) => !!h.ports?.some((p) => p.open && [3306, 5432, 6379, 9200, 11211, 27017, 1433, 1521].includes(p.port))), "Database/cache ports."),
    "03-06": () => (d.mail.smtp ? { status: d.mail.smtp.error ? "not-tested" : "triggered", note: d.mail.smtp.error ?? `${d.mail.smtp.host}: STARTTLS ${d.mail.smtp.starttls ? "offered" : "not offered"}`, assets: [d.mail.smtp.host] } : { status: "not-observed", note: "No MX to check." }),
    "03-07": () => t(P((p) => p.links.some((l) => /\/(admin|wp-admin|dashboard|console|manage)\b/i.test(l))), "Links to admin/management paths (not accessed)."),
    "03-08": () => t(findings.filter((f) => f.rule === "03-08").map((f) => f.asset), "Version strings recorded as leads."),
    "03-09": () => ({ status: "not-tested", note: c.authorized ? "Non-web TLS services are covered by the port list only." : "Requires port probing (authorized only)." }),
    "03-10": () => t(any((h) => h.errors.some((e) => /timeout/i.test(e))), "Timeouts recorded; no retries beyond the budget."),
    "03-11": () => t(P((p, h) => /router|camera|scada|plc|printer|ilo|idrac|ipmi|webcam/i.test(`${p.title} ${h.https?.headers.server ?? ""}`)), "Appliance/IoT signatures in titles or server headers."),
    "04-01": () => t(any((h) => !!h.tls?.ok), `TLS observed: ${live.filter((h) => h.tls?.ok).map((h) => `${h.host} ${h.tls!.protocol}`).slice(0, 4).join(", ")}`),
    "04-02": () => (findings.some((f) => f.rule === "04-02") ? { status: "triggered", note: "Legacy protocol or weak key.", assets: [] } : { status: c.authorized ? "clear" : "triggered", note: c.authorized ? "TLS 1.0/1.1 refused." : "Negotiated protocol recorded; legacy-version handshakes run only when authorized.", assets: [] }),
    "04-03": () => t(any((h) => !!h.http?.status), `HTTP behaviour: ${live.filter((h) => h.http?.status).map((h) => `${h.host} → ${h.http!.status}`).slice(0, 4).join(", ")}`),
    "04-04": () => t(any((h) => !!h.https?.headers["strict-transport-security"]), "HSTS policy parsed."),
    "04-05": () => t(any((h) => !!h.provider && /cdn|platform/.test(h.provider.kind)), "CDN/platform edges identified; origin not tested behind them."),
    "04-06": () => t(any((h) => !!h.https?.headers["content-encoding"] || !!h.https?.headers["cache-control"]), "Compression/caching headers recorded."),
    "04-07": () => t(any((h) => h.tls?.alpn === "h2" || /h3/.test(h.https?.headers["alt-svc"] ?? "")), "ALPN/Alt-Svc recorded."),
    "04-08": () => (c.authorized ? t(any((h) => !!h.cors), "Origin reflection tested with a .invalid origin.") : t(any((h) => !!h.https?.headers["access-control-allow-origin"]), "CORS headers on the public response.")),
    "04-09": () => t(P((p) => p.redirectParams.length > 0), "Redirect parameters in links."),
    "04-10": () => t(pages.map((h) => h.host), "Security headers reviewed on every collected page."),
    "05-01": () => t(pages.map((h) => h.host), `${pages.length} live websites.`),
    "05-02": () => t(any((h) => h.robots?.status === 200), `Disallowed paths: ${live.flatMap((h) => h.robots?.disallow ?? []).slice(0, 8).join(" ") || "none"}`),
    "05-03": () => t(any((h) => (h.sitemap?.urls ?? 0) > 0), `Sitemap URLs: ${live.reduce((s, h) => s + (h.sitemap?.urls ?? 0), 0)}`),
    "05-04": () => t(pages.map((h) => h.host), "Links, forms and scripts inventoried."),
    "05-05": () => t(P((p) => p.spa.length > 0), "Client-side rendering detected."),
    "05-06": () => t(P((p) => p.forms.length > 0), "Forms inventoried (not submitted)."),
    "05-07": () => t(P((p) => p.idRoutes.length > 0), "Routes with identifiers (object ownership needs authorized testing)."),
    "05-08": () => t(P((p) => p.fileRoutes.length > 0), "Upload/download/export routes listed."),
    "05-09": () => t(P((p) => p.scripts.some((s) => s.firstParty)), "First-party bundles read; source-map references recorded."),
    "05-10": () => t(d.wayback.interesting.length ? [d.domain] : [], `${d.wayback.urls.length} archived URLs, ${d.wayback.interesting.length} legacy/admin-looking.`),
    "05-11": () => t(P((p) => p.searchOrPaging.length > 0), "Search/paging parameters seen."),
    "05-12": () => t(any((h) => !!h.notFound), "One random path requested per host to observe error handling."),
    "06-01": () => t(P((p) => p.authLinks.login.length > 0 || p.forms.some((f) => f.password)), "Login entry points (no login attempted)."),
    "06-02": () => t(P((p) => p.authLinks.register.length > 0), "Registration entry points (not used)."),
    "06-03": () => (P((p) => p.forms.some((f) => f.password)).length ? { status: "triggered", note: "Password form found; policy and lockout need authorized testing.", assets: P((p) => p.forms.some((f) => f.password)) } : { status: "not-observed", note: "No password field on collected pages." }),
    "06-04": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }),
    "06-05": () => (P((p) => p.authLinks.reset.length > 0).length ? { status: "triggered", note: "Recovery entry point found; token handling needs authorized testing.", assets: P((p) => p.authLinks.reset.length > 0) } : { status: "not-observed", note: "No recovery link seen." }),
    "06-06": () => t([...any((h) => !!h.oidc), ...P((p) => p.authLinks.sso.length > 0)], `OIDC metadata: ${live.filter((h) => h.oidc).map((h) => `${h.host} PKCE ${h.oidc!.pkce ? "S256" : "not advertised"}`).join(", ") || "none"}`),
    "06-07": () => t(P((p) => p.links.some((l) => /saml|sso/i.test(l))), "SAML/SSO links (metadata not requested)."),
    "06-08": () => t(P((p) => p.signals.apiCalls.some((a) => /webauthn|passkey/i.test(a))), "WebAuthn/passkey endpoints in client code."),
    "06-09": () => t(P((p) => p.secrets.length > 0), "Credential-like strings in public code (values withheld)."),
    "06-10": () => ({ status: "not-tested", note: NEEDS_ACTIVE }), "06-11": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }),
    "07-01": () => t(any((h) => cookiesOf(h).length > 0), "Cookie flags reviewed (values withheld)."),
    "07-02": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "07-03": () => t(P((p) => p.authLinks.logout.length > 0), "Logout endpoint seen; server-side revocation needs authorized testing."),
    "07-04": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }),
    "07-05": () => t([...P((p) => p.secrets.some((s) => s.type === "jwt")), ...any((h) => /eyJ[\w-]{8,}\./.test(h.https?.headers["set-cookie"] ?? ""))], "JWTs in public responses (not decoded or replayed)."),
    "07-06": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "07-07": () => t(P((p) => p.forms.some((f) => f.method === "post")), "State-changing forms found (not submitted)."),
    "07-08": () => t(P((p) => p.links.some((l) => /[?&](token|session|sid|access_token|auth)=/i.test(l))), "Tokens in URLs."),
    "07-09": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }),
    ...Object.fromEntries(["08-01", "08-02", "08-03", "08-04", "08-05", "08-06", "08-07", "08-08", "08-09", "08-10"].map((id) => [id, (): R => (id === "08-01" && P((p) => p.idRoutes.length > 0).length ? { status: "not-tested", note: "Identifier routes exist; ownership checks need two authorized test accounts. " + NEEDS_ACCOUNTS, assets: P((p) => p.idRoutes.length > 0) } : { status: "not-tested", note: NEEDS_ACCOUNTS })])),
    "09-01": () => t(P((p) => p.forms.length > 0 || p.paramLinks.length > 0), "Inputs inventoried; no payloads were sent."),
    ...Object.fromEntries(["09-02", "09-03", "09-04", "09-05", "09-06", "09-07", "09-08", "09-09", "09-10", "09-11", "09-12", "09-13", "09-14"].map((id) => [id, (): R => ({ status: "not-tested", note: NEEDS_ACTIVE })])),
    "10-01": () => t([...P((p) => p.signals.apiCalls.length > 0), ...any((h) => !!h.exposures?.some((e) => /swagger|openapi/.test(e.path) && e.signature))], `API calls in client code: ${pages.flatMap((h) => h.page!.signals.apiCalls).slice(0, 6).join(", ") || "none"}`),
    "10-02": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "10-03": () => t(P((p) => p.signals.graphql.length > 0), "GraphQL endpoints referenced (introspection not attempted)."),
    "10-04": () => t(any((h) => /grpc/i.test(h.https?.headers["content-type"] ?? "")), "gRPC content types."), "10-05": () => t(P((p) => p.signals.websocket.length > 0), "WebSocket URLs referenced."),
    "10-06": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "10-07": () => t(P((p) => p.versionedApi.length > 0 || p.signals.apiCalls.some((a) => /\/v\d+\//.test(a))), "Versioned API routes."),
    "10-08": () => ({ status: "not-tested", note: NEEDS_ACTIVE }), "10-09": () => ({ status: "not-tested", note: NEEDS_ACTIVE }), "10-10": () => ({ status: "not-tested", note: NEEDS_ACTIVE }),
    "10-11": () => t(P((p) => p.thirdParty.length > 0), "Third-party services called from the page."),
    "11-01": () => t(P((p) => p.links.some((l) => /checkout|onboard|wizard|step|apply/i.test(l))), "Multi-step flows linked (not exercised)."),
    "11-02": () => t(P((p) => p.links.some((l) => /pricing|price|plans|credits|coupon/i.test(l))), "Pricing/credit pages (business logic needs authorized testing)."),
    "11-03": () => t(P((p) => p.thirdParty.some((x) => x.category === "payment") || p.links.some((l) => /checkout|payment|billing/i.test(l))), "Payment integration observed (no transactions attempted)."),
    "11-04": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "11-05": () => t(P((p) => p.links.some((l) => /invite|referral|reward|coupon/i.test(l))), "Invite/referral paths."),
    "11-06": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "11-07": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "11-08": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }), "11-09": () => ({ status: "not-tested", note: NEEDS_ACCOUNTS }),
    "12-01": () => t(P((p) => p.scripts.length > 0), `Scripts: ${pages.reduce((s, h) => s + h.page!.scripts.length, 0)} (${pages.reduce((s, h) => s + h.page!.scripts.filter((x) => !x.firstParty).length, 0)} third-party).`),
    "12-02": () => t(pages.map((h) => h.host), "CSP evaluated."), "12-03": () => t(P((p) => p.signals.storage.length > 0), "Browser storage used by client code (contents unknown)."),
    "12-04": () => t(P((p) => p.signals.messageListener || p.signals.postMessage), "postMessage usage found; origin checks need code review."), "12-05": () => t(P((p) => p.signals.serviceWorker || !!p.manifest), "Service worker / web app manifest."),
    "12-06": () => t(P((p) => p.iframes.length > 0), "Iframes embedded."), "12-07": () => (P((p) => p.signals.innerHTML).length ? { status: "triggered", note: "HTML-injection sinks in client code; reachability from untrusted input needs code review/authorized testing.", assets: P((p) => p.signals.innerHTML) } : { status: "not-observed", note: "No HTML sinks seen in the code read." }),
    "12-08": () => t(P((p) => p.signals.wasm), "WebAssembly loaded."), "12-09": () => t(P((p) => p.links.some((l) => /chrome\.google\.com\/webstore|addons\.mozilla|extension/i.test(l)) || p.externalHosts.some((x) => /chromewebstore|addons\.mozilla/.test(x))), "Extension/companion client links."),
    "13-01": () => t(P((p) => p.forms.some((f) => f.file)), "File inputs (nothing uploaded)."), "13-02": () => t(P((p) => p.fileRoutes.length > 0), "Download/export routes."),
    "13-03": () => t(P((p) => p.forms.some((f) => f.file)), "Uploads imply server-side parsers (not exercised)."),
    "13-04": () => t([...P((p) => p.externalHosts.some((x) => /s3[.-].*amazonaws|storage\.googleapis|blob\.core\.windows|r2\.dev|digitaloceanspaces/.test(x)) || p.scripts.some((s) => /s3[.-].*amazonaws|storage\.googleapis|blob\.core\.windows/.test(s.host)))], "Object storage referenced (bucket listing not attempted)."),
    "13-05": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "13-06": () => authOnly(any((h) => !!h.exposures?.some((e) => e.signature && /backup|\.env|\.git|composer/.test(e.path))), "Backup/config exposure probe."),
    "13-07": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "13-08": () => t(findings.filter((f) => f.rule === "13-08").map((f) => f.asset), "Cacheability of personalized responses."),
    "13-09": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "13-10": () => t(P((p) => p.thirdParty.some((x) => x.category === "analytics" || x.category === "monitoring")), "Analytics/monitoring copies page data to third parties."),
    "14-01": () => t(any((h) => !!h.provider && /cloud|platform|cdn/.test(h.provider.kind)), `Hosting: ${[...new Set(live.map((h) => h.provider?.name).filter(Boolean))].join(", ") || "not attributed"}`),
    "14-02": () => t(P((p) => p.externalHosts.some((x) => /s3[.-].*amazonaws|storage\.googleapis|blob\.core\.windows/.test(x))), "Public object-store hostnames referenced."),
    "14-03": () => t(any((h) => !!h.provider && /platform/.test(h.provider.kind)), "Serverless/PaaS compute identified from headers/CNAMEs."),
    "14-04": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "14-05": () => t(any((h) => /kubernetes|k8s|ingress-nginx|envoy|istio/i.test(JSON.stringify(h.https?.headers ?? {}))), "Kubernetes/ingress signatures in headers."),
    "14-06": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "14-07": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "14-08": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "14-09": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "14-10": () => ({ status: "not-tested", note: NEEDS_INTERNAL }),
    "14-11": () => t(any((h) => h.provider?.kind === "cdn" || h.provider?.kind === "platform"), "Edge in front of workloads; origin exposure behind it not tested."),
    "15-01": () => t([...P((p) => p.frameworks.length > 0), ...findings.filter((f) => f.rule === "03-08").map((f) => f.asset)], `Identified: ${[...new Set(pages.flatMap((h) => h.page!.frameworks))].join(", ") || "headers only"}`),
    "15-02": () => t(P((p) => p.externalHosts.some((x) => /github\.com|gitlab\.com|bitbucket\.org/.test(x))), "Public repository links."),
    "15-03": () => authOnly(any((h) => !!h.exposures?.some((e) => /package\.json|composer\.lock/.test(e.path) && e.signature)), "Manifest exposure probe."),
    "15-04": () => t(P((p) => p.scripts.some((s) => /jsdelivr|unpkg|cdnjs/.test(s.host))), "Packages loaded from public registries/CDNs at runtime."),
    "15-05": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "15-06": () => ({ status: "not-tested", note: NEEDS_INTERNAL }),
    "15-07": () => t([...P((p) => p.signals.sourceMaps.length > 0 || p.secrets.length > 0), ...any((h) => !!h.notFound?.leaks.length)], "Source maps, debug output or credential-like strings in public releases."),
    "15-08": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "15-09": () => t(P((p) => p.thirdParty.length > 0), `SaaS: ${[...new Set(pages.flatMap((h) => h.page!.thirdParty.map((x) => `${x.host} (${x.category})`)))].slice(0, 6).join(", ")}`),
    "16-01": () => t(d.mail.spf.length || d.mail.dkim.length ? [d.domain] : [], "Sending authentication reviewed (SPF/DKIM/DMARC)."),
    "16-02": () => t(any((h) => A(h, 15, "MX").length > 0), `Inbound: MTA-STS ${d.mail.mtaSts.mode ?? "absent"}, TLS-RPT ${d.mail.tlsRpt ? "present" : "absent"}.`),
    "16-03": () => t(P((p) => p.forms.some((f) => /contact|message|support|feedback/i.test(f.action + f.inputs.join(" ")))), "Contact forms (not submitted)."),
    "16-04": () => ({ status: "not-tested", note: NEEDS_INTERNAL }),
    "16-05": () => t(P((p) => p.thirdParty.some((x) => ["identity", "payment", "analytics"].includes(x.category))), "Identity/payment/analytics scripts embedded."),
    "16-06": () => t(P((p) => p.externalHosts.length > 0), `${new Set(pages.flatMap((h) => h.page!.externalHosts)).size} external domains referenced.`),
    "17-01": () => ({ status: "not-tested", note: NEEDS_INTERNAL }),
    "17-02": () => t(any((h) => h.securityTxt?.status === 200), "Public vulnerability-reporting route (security.txt); detection itself is internal."),
    "17-03": () => (findings.some((f) => f.rule === "15-07") ? { status: "triggered", note: "Credential-like strings were public; rotation/invalidation must be confirmed by the owner.", assets: findings.filter((f) => f.rule === "15-07").map((f) => f.asset) } : { status: "not-observed", note: "No exposed credential observed." }),
    "17-04": () => t(any((h) => Object.keys(h.https?.headers ?? {}).some((k) => /ratelimit|retry-after/i.test(k))), "Rate-limit headers observed; resilience testing needs a staging environment."),
    "17-05": () => ({ status: "not-tested", note: NEEDS_INTERNAL }), "17-06": () => ({ status: "not-tested", note: "Retest happens on the next run: the client marks findings that disappeared as remediated." }), "17-07": () => ({ status: "not-tested", note: NEEDS_INTERNAL }),
    "18-01": () => ({ status: findings.length ? "triggered" : "clear", note: `${findings.length} findings recorded with asset, evidence, state and time.`, assets: [] }),
    "18-02": () => ({ status: findings.some((f) => f.rule === "03-08") ? "triggered" : "not-observed", note: "Versions are not matched to CVEs here; applicability unknown.", assets: [] }),
    "18-03": () => ({ status: findings.some((f) => f.chain.length > 4) ? "triggered" : "not-observed", note: "Prerequisite chains are modelled as directed steps with their own states.", assets: [] }),
    "18-04": () => ({ status: findings.some((f) => f.state === "hypothesized") ? "triggered" : "not-observed", note: "Hypotheses list the discriminating test as the next step.", assets: [] }),
    "18-05": () => ({ status: findings.length ? "triggered" : "not-observed", note: "Each finding carries a proposed fix; none is marked resolved without a retest.", assets: [] }),
    "18-06": () => ({ status: "triggered", note: "Passed checks close only that check on that asset at this time.", assets: [] }),
    "18-07": () => ({ status: "triggered", note: "Coverage below lists every rule with its disposition.", assets: [] }),
    "18-08": () => ({ status: "triggered", note: `Blocked rules are listed as not tested with their blocker${c.skipped ? `; ${c.skipped} hosts not reached in time` : ""}.`, assets: [] }),
    "18-09": () => ({ status: "triggered", note: "Traversal ended when no new in-scope children remained or limits were reached; completion is time-stamped, not permanent.", assets: [] }),
  };
  // If collection itself failed for every in-scope host, absence of a precondition means nothing.
  const blind = live.length > 0 && live.every((h) => h.dnsFailed.length > 0 && !h.https?.status && !h.addresses.length);
  return RULES.map((r) => {
    const fn = E[r.id];
    let res: R = fn ? fn() : { status: "not-tested", note: NEEDS_INTERNAL };
    if (blind && res.status === "not-observed") res = { status: "not-tested", note: `Collection failed (${live[0].errors[0]?.slice(0, 140) ?? "DNS/HTTP errors"}); whether the precondition exists is unknown.` };
    return { id: r.id, family: r.family, status: res.status, note: res.note, assets: [...new Set(res.assets ?? [])].slice(0, 12), findings: findings.filter((f) => f.rule === r.id).map((f) => f.id) };
  });
}
