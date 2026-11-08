import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { lookalikes, attributeProvider, murmur3, techFromHeaders } from "../src/domain-intel/collect.js";
import { DomainRun, normalizeTarget, runDomainIntel, verificationValue } from "../src/domain-intel/engine.js";
import { dnsTypeNumber, liveNet, type DnsResult, type HttpResult, type IntelNet, type TcpResult, type TlsResult } from "../src/domain-intel/net.js";
import { FAMILIES, RULES } from "../src/domain-intel/rules.js";
import { registerDomainIntelRoutes } from "../src/http/domain-routes.js";

// A recorded-call fixture network. Nothing here touches the internet.
type Calls = { dns: string[]; http: Array<{ url: string; headers?: Record<string, string> }>; tls: Array<{ host: string; min?: string }>; tcp: string[] };
function fixtureNet(opts: { dns: Record<string, string[] | "NX" | "ERR">; http: Record<string, Partial<HttpResult>>; tls?: Record<string, Partial<TlsResult>>; legacyTls?: boolean; openPorts?: number[]; json?: Record<string, unknown> }): IntelNet & { calls: Calls } {
  const calls: Calls = { dns: [], http: [], tls: [], tcp: [] };
  return {
    calls,
    async dns(name, type): Promise<DnsResult> {
      calls.dns.push(`${name}|${type}`);
      const v = opts.dns[`${name}|${type}`];
      if (v === "ERR") return { status: -1, ad: false, answers: [], error: "fixture: resolver unreachable" };
      if (v === "NX") return { status: 3, ad: false, answers: [] };
      return { status: 0, ad: false, answers: (v ?? []).map((data) => ({ name, type: dnsTypeNumber(type), TTL: 300, data })) };
    },
    async http(url, o = {}): Promise<HttpResult> {
      calls.http.push({ url, headers: o.headers });
      const r = (o.headers?.origin ? opts.http[url + "#cors"] : undefined) ?? opts.http[url];
      const base: HttpResult = { url, finalUrl: url, status: 404, headers: { "content-type": "text/html" }, body: "<html><body>Not found</body></html>", truncated: false, redirects: [], remoteAddress: null, ms: 3 };
      return { ...base, ...(r ?? {}), headers: { ...(r?.headers ?? base.headers) } };
    },
    async json(url) {
      calls.http.push({ url });
      return (opts.json?.[url] ?? null) as never;
    },
    async tls(host, o = {}): Promise<TlsResult> {
      calls.tls.push({ host, min: o.minVersion });
      if (o.minVersion && /TLSv1(\.1)?$/.test(o.minVersion)) return { host, port: 443, ok: !!opts.legacyTls, protocol: opts.legacyTls ? o.minVersion : null };
      return { host, port: 443, ok: true, protocol: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256", alpn: "h2", authorized: true, authorizationError: null, ...(opts.tls?.[host] ?? {}) } as TlsResult;
    },
    async tcp(host, port): Promise<TcpResult> {
      calls.tcp.push(`${host}:${port}`);
      const open = (opts.openPorts ?? []).includes(port);
      return { host, port, open, banner: open && port === 6379 ? "-ERR unknown command" : undefined, ms: 1, error: open ? undefined : "ECONNREFUSED" };
    },
  };
}

const NOW = Date.parse("2026-11-04T12:00:00Z");
const D = "fixture-shop.com";
// Built at runtime so the repository never stores a scanner-matching literal (fake value).
const FAKE_AWS = ["AKIA", "Q3EXAMPLE7FIXTUR"].join("");
const page = `<!doctype html><html lang="en"><head><title>Fixture Shop</title><meta name="generator" content="WordPress 6.1.1"></head><body>
<a href="/login">Sign in</a> <a href="/account/register">Create account</a> <a href="/forgot-password">Forgot password?</a>
<a href="/orders/12345">Order</a> <a href="/go?next=/cart">Cart</a> <a href="/export/report.csv">Export</a> <a href="/search?q=a&page=2">Search</a>
<a href="https://old.${D}/">Old site</a> <a href="https://github.com/fixture-shop">Code</a> <img src="http://cdn.${D}/x.png">
<form action="/session" method="get"><input name="user"><input type="password" name="pw"></form>
<form action="/contact" method="post"><input name="email"><textarea name="message"></textarea></form>
<form action="/upload" method="post" enctype="multipart/form-data"><input type="hidden" name="csrf_token" value="x"><input type="file" name="f"></form>
<script src="/static/app.js"></script><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><script src="https://js.stripe.com/v3/"></script>
<script>gtag('config','G-AB12CD34EF');localStorage.setItem('a','b'); window.addEventListener('message', e => document.getElementById('x').innerHTML = e.data);</script>
</body></html>`;
const appJs = `fetch("/api/v2/cart");const ws=new WebSocket("wss://live.${D}/socket");const k="${FAKE_AWS}";\n//# sourceMappingURL=app.js.map`;

function shopFixture(extra: { authorized?: boolean } = {}) {
  return fixtureNet({
    legacyTls: true,
    openPorts: [6379],
    dns: {
      [`${D}|A`]: ["203.0.113.10"], [`${D}|NS`]: ["ns1.fixture-dns.net."], [`${D}|MX`]: ["10 mx.fixture-mail.net."], [`${D}|TXT`]: ["\"v=spf1 include:a.spf.test include:b.spf.test ?all\"", "\"google-site-verification=abc\""],
      [`${D}|CAA`]: [], [`_dmarc.${D}|TXT`]: [], [`${D}|DS`]: [], [`old.${D}|CNAME`]: ["fixture-shop-old.herokuapp.com."], [`old.${D}|A`]: "NX",
      [`www.${D}|CNAME`]: [`${D}.`], [`www.${D}|A`]: ["203.0.113.10"], [`selector1._domainkey.${D}|TXT`]: ["\"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC" + "A".repeat(150) + "\""],
      "a.spf.test|TXT": ["\"v=spf1 include:c.spf.test include:d.spf.test include:e.spf.test include:f.spf.test ~all\""], "b.spf.test|TXT": ["\"v=spf1 include:g.spf.test include:h.spf.test include:i.spf.test include:j.spf.test -all\""],
      [`fixtureshop.com|A`]: ["198.51.100.7"], [`_void-verify.${D}|TXT`]: extra.authorized ? [`"${verificationValue(D, "s3cret")}"`] : [],
    },
    json: {
      [`https://rdap.org/domain/${D}`]: { status: ["active"], events: [{ eventAction: "registration", eventDate: "2015-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2026-11-24T00:00:00Z" }, { eventAction: "last changed", eventDate: "2026-10-01T00:00:00Z" }], entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Fixture Registrar"]]] }], nameservers: [{ ldhName: "ns1.fixture-dns.net" }], secureDNS: { delegationSigned: false } },
      [`https://crt.sh/?q=${encodeURIComponent("%." + D)}&output=json&exclude=expired&deduplicate=Y`]: [{ name_value: `${D}\nwww.${D}`, issuer_name: "C=US, O=Let's Encrypt, CN=R11", not_before: "2026-10-20T00:00:00", not_after: "2027-01-18T00:00:00" }, { name_value: `old.${D}\nstaging.${D}`, issuer_name: "C=US, O=Let's Encrypt, CN=R10", not_before: "2025-01-01T00:00:00", not_after: "2027-04-01T00:00:00" }],
      [`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(D + "/*")}&output=json&fl=original&collapse=urlkey&limit=3000`]: [["original"], [`https://${D}/wp-admin/`], [`https://${D}/backup.sql`], [`https://${D}/about`]],
      [`https://rdap.org/ip/203.0.113.10`]: { name: "FIXTURE-HOSTING", country: "US", entities: [{ vcardArray: ["vcard", [["fn", {}, "text", "Fixture Hosting LLC"]]] }] },
    },
    http: {
      [`https://${D}/`]: { status: 200, headers: { "content-type": "text/html; charset=utf-8", server: "nginx/1.18.0", "x-powered-by": "PHP/7.4.3", "set-cookie": "PHPSESSID=abc123; path=/, theme=dark; Secure; SameSite=Lax", "cache-control": "public, max-age=600" }, body: page },
      [`http://${D}/`]: { status: 200, headers: { "content-type": "text/html" }, body: "" },
      [`https://${D}/static/app.js`]: { status: 200, headers: { "content-type": "application/javascript" }, body: appJs },
      [`https://${D}/robots.txt`]: { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /admin\nSitemap: https://fixture-shop.com/sitemap.xml" },
      [`https://${D}/sitemap.xml`]: { status: 200, headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://fixture-shop.com/a</loc></url></urlset>" },
      [`https://${D}/.git/HEAD`]: { status: 200, headers: { "content-type": "text/plain" }, body: "ref: refs/heads/main\n" },
      [`https://${D}/#cors`]: { status: 200, headers: { "content-type": "text/html", "access-control-allow-origin": "https://void-intel-origin-check.invalid", "access-control-allow-credentials": "true" }, body: "" },
    },
    tls: { [D]: { cert: { subject: `CN=${D}`, issuer: "C=US, O=Let's Encrypt, CN=R11", validFrom: "2026-08-20T00:00:00Z", validTo: "2026-11-14T00:00:00Z", san: [D, `www.${D}`], serial: "01", fingerprint256: "AA", bits: 2048, keyType: "RSA", curve: null, selfSigned: false, chainDepth: 2 } } },
  });
}

describe("domain intelligence — target handling", () => {
  it("normalizes input and refuses what is not a public domain", () => {
    expect(normalizeTarget("https://Fixture-Shop.com/path?x=1")).toBe("fixture-shop.com");
    expect(normalizeTarget("münchen.de")).toBe("xn--mnchen-3ya.de");
    for (const bad of ["127.0.0.1", "localhost", "intranet.corp", "printer.local", "a", "x".repeat(400), "foo.internal", "db.lan", "javascript:alert(1)", "metadata.google.internal"]) expect(normalizeTarget(bad), bad).toBeNull();
  });
  it("the live network adapter refuses private and loopback addresses (no SSRF through domain runs)", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1"]) {
      const t = await liveNet.tcp(ip, 80, { timeoutMs: 500 });
      expect(t.open).toBe(false);
      expect(t.error).toMatch(/EGRESS_BLOCKED|non-public/);
      const s = await liveNet.tls(ip, { timeoutMs: 500 });
      expect(s.ok).toBe(false);
    }
  });
  it("parses all 19 families and 188 rules of the map", () => {
    expect(FAMILIES).toHaveLength(19);
    expect(RULES).toHaveLength(188);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(188);
  });
  it("generates confusable variants for lookalike checks, none for platform subdomains", () => {
    const v = lookalikes("fixture-shop.com").map((x) => x.name);
    expect(v).toContain("fixtureshop.com".replace("fixtureshop", "fixture-shp"));
    expect(v).toContain("fixture-shop.net");
    expect(lookalikes("asherinvoid.vercel.app")).toEqual([]);
  });
  it("attributes platforms so their infrastructure is never treated as the target", () => {
    expect(attributeProvider("asherinvoid.vercel.app")?.name).toBe("Vercel");
    expect(attributeProvider("void-web-production.up.railway.app")?.name).toBe("Railway");
    expect(attributeProvider("x.example.org", { "cf-ray": "1" })?.name).toBe("Cloudflare");
  });
});

describe("domain intelligence — passive run", () => {
  it("finds, chains and states evidence without any intrusive request", async () => {
    const net = shopFixture();
    const r = await runDomainIntel(`https://${D}/`, { net, ownedRoots: [], secret: "s3cret", now: () => NOW });
    expect(r.scope.mode).toBe("passive");
    // Every rule of the map has a disposition.
    expect(r.rules).toHaveLength(188);
    expect(r.coverage.dispositioned).toBe(188);
    const titles = r.findings.map((f) => `${f.rule} ${f.title}`);
    const has = (re: RegExp) => expect(titles.some((t) => re.test(t)), `${re} in\n${titles.join("\n")}`).toBe(true);
    has(/02-03 Possible dangling DNS: old\.fixture-shop\.com/);
    has(/02-07 No DMARC/);
    has(/02-06 SPF ends with \?all/);
    has(/02-06 SPF needs \d+ DNS lookups/);
    has(/01-01 Domain registration expires in 20 days/);
    has(/01-02 No registrar transfer lock/);
    has(/04-01 TLS certificate expires in 10 days/);
    has(/04-03 Plain HTTP serves content/);
    has(/04-04 No HSTS/);
    has(/12-02 No Content-Security-Policy/);
    has(/06-03 Password form submits with GET/);
    has(/15-07 Credential-like aws-access-key-id in public JavaScript/);
    has(/07-01 Cookie PHPSESSID lacks Secure, HttpOnly, SameSite/);
    has(/13-08 Response sets cookies but is marked publicly cacheable/);
    has(/03-08 Software version disclosed/);
    has(/05-09 Public JavaScript references source maps/);
    has(/04-09 Redirect parameter in links/);
    has(/02-09 No CAA record/);
    has(/05-10 .*archived URLs/);
    has(/12-01 .*third-party scripts without Subresource Integrity/);
    has(/04-03 HTTPS page references plain-HTTP resources/);
    // States follow the map: the dangling CNAME is a hypothesis with an 8-step chain, not a claimed takeover.
    const dangling = r.findings.find((f) => f.rule === "02-03")!;
    expect(dangling.state).toBe("hypothesized");
    expect(dangling.chain).toHaveLength(8);
    expect(dangling.chain.filter((s) => s.state === "not-tested")).toHaveLength(3);
    // The secret value is never in the report.
    expect(JSON.stringify(r)).not.toContain(FAKE_AWS);
    // Pivots: tracking IDs and technologies are extracted.
    const root = r.hosts.find((h) => h.host === D)!;
    expect(root.page?.trackingIds).toContain("G-AB12CD34EF");
    expect(root.technologies).toEqual(expect.arrayContaining(["WordPress 6.1.1", "PHP", "server: nginx/1.18.0", "Google Analytics"]));
    // Page bodies are not carried in the report.
    expect(r.hosts.every((h) => !h.https?.body)).toBe(true);
    // Cookie values are masked.
    expect(JSON.stringify(r.findings)).not.toContain("abc123");
    // Passive: no sensitive-path probes, no Origin header test, no legacy TLS, no port probes except the SMTP MX.
    expect(net.calls.http.some((c) => /\.git\/HEAD|\.env|server-status|backup\.zip/.test(c.url))).toBe(false);
    expect(net.calls.http.some((c) => c.headers?.origin)).toBe(false);
    expect(net.calls.tls.some((c) => c.min)).toBe(false);
    expect(net.calls.tcp.every((c) => c.endsWith(":25"))).toBe(true);
    // Authorized-only rules are reported as not tested, with the reason.
    expect(r.rules.find((x) => x.id === "03-05")!.status).toBe("not-tested");
    expect(r.rules.find((x) => x.id === "08-01")!.status).toBe("not-tested");
    // Recursion: CNAME, certificate-log and link discoveries became nodes; the MX/NS hosts are references.
    expect(r.hosts.map((h) => h.host)).toEqual(expect.arrayContaining([D, `www.${D}`, `old.${D}`, `staging.${D}`]));
    expect(r.hosts.find((h) => h.host === "mx.fixture-mail.net")?.reference).toBe(true);
    expect(r.edges.some((e) => e.from === `old.${D}` && e.to === "fixture-shop-old.herokuapp.com" && e.kind === "CNAME")).toBe(true);
    // Decision graph path and workflow are reported for the diagrams.
    expect(r.decision).toMatchObject({ passive: true, authorized: false, web: true, auth: true, dataEndpoints: true });
    expect(r.workflow.map((w) => w.id)).toEqual(["scope", "registration", "labels", "wave-1", "analyze"]);
    expect(r.unknowns.join(" ")).toMatch(/Authorized-only checks .* were not run/);
  });

  it("reports nothing as missing when lookups fail (blind run)", async () => {
    const net = fixtureNet({ dns: new Proxy({}, { get: () => "ERR" }) as Record<string, "ERR">, http: {} });
    const r = await runDomainIntel("unreachable-fixture.org", { net, ownedRoots: [], secret: "x", now: () => NOW });
    expect(r.findings).toEqual([]);
    expect(r.rules.filter((x) => x.status === "not-observed")).toEqual([]);
    expect(r.unknowns[0]).toMatch(/could not be observed/);
  });
});

describe("domain intelligence — authorized run (owner-verified)", () => {
  it("unlocks owner-only checks by DNS proof and validates findings", async () => {
    const net = shopFixture({ authorized: true });
    const r = await runDomainIntel(D, { net, ownedRoots: [], secret: "s3cret", now: () => NOW });
    expect(r.scope.mode).toBe("authorized");
    expect(r.scope.reason).toMatch(/_void-verify/);
    const f = (re: RegExp) => r.findings.find((x) => re.test(x.title));
    expect(f(/\/\.git\/HEAD is publicly served/)).toMatchObject({ severity: "critical", state: "validated" });
    expect(f(/TLSv1\.0 is still accepted/)).toMatchObject({ state: "validated" });
    expect(f(/CORS reflects arbitrary origins with credentials/)).toMatchObject({ severity: "info", state: "observed" });
    expect(f(/Port 6379 is reachable/)).toMatchObject({ severity: "high" });
    // Each address is probed once even when several hostnames share it.
    expect(net.calls.tcp.filter((c) => c === "203.0.113.10:6379")).toHaveLength(1);
    // Exposure checks keep a signature match only; the file contents never reach the report.
    expect(JSON.stringify(r)).not.toContain("refs/heads/main");
  });
  it("never probes ports on shared platform infrastructure, even when owned (00-02)", async () => {
    const net = fixtureNet({
      openPorts: [22],
      dns: { "void-fixture.vercel.app|A": ["76.76.21.21"] },
      http: { "https://void-fixture.vercel.app/": { status: 200, headers: { "content-type": "text/html", server: "Vercel", "x-vercel-id": "iad1::x" }, body: "<html><head><title>v</title></head><body></body></html>" } },
    });
    const r = await runDomainIntel("void-fixture.vercel.app", { net, ownedRoots: ["void-fixture.vercel.app"], secret: "x", now: () => NOW });
    expect(r.scope.mode).toBe("authorized");
    expect(net.calls.tcp).toEqual([]);
    expect(r.hosts[0].provider?.name).toBe("Vercel");
    expect(r.hosts.map((h) => h.host)).not.toContain("www.void-fixture.vercel.app");
  });
});

describe("domain intelligence — HTTP API", () => {
  it("validates input, returns the report, caches and rate-limits", async () => {
    const app = Fastify();
    const net = shopFixture();
    registerDomainIntelRoutes(app, { net, ownedRoots: [], secret: "s3cret" });
    await app.ready();
    expect((await app.inject({ url: "/api/v2/domain-intel?domain=127.0.0.1" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v2/domain-intel?domain=" })).statusCode).toBe(400);
    const ok = await app.inject({ url: `/api/v2/domain-intel?domain=${D}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rules).toHaveLength(188);
    const runId = ok.json().runId;
    expect(runId).toMatch(/^[a-f0-9]{24}$/);
    const cont = await app.inject({ url: `/api/v2/domain-intel/continue?run=${runId}` });
    expect(cont.statusCode).toBe(200);
    expect(cont.json()).toMatchObject({ runId, complete: true });
    expect((await app.inject({ url: "/api/v2/domain-intel/continue?run=xyz" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/v2/domain-intel/continue?run=${"0".repeat(24)}` })).statusCode).toBe(404);
    const again = await app.inject({ url: `/api/v2/domain-intel?domain=${D}` });
    expect(again.headers["x-domain-intel-cache"]).toBe("hit");
    const v = await app.inject({ url: `/api/v2/domain-intel/verification?domain=www.${D}` });
    expect(v.json()).toMatchObject({ domain: D, record: `_void-verify.${D}`, value: verificationValue(D, "s3cret") });
    expect((await app.inject({ url: "/api/v2/domain-intel/rules" })).json().rules).toHaveLength(188);
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await app.inject({ url: `/api/v2/domain-intel?domain=n${i}-fixture.com&fresh=1` })).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    // A relayed visitor (Void forwards an opaque key) has its own bucket; a malformed key does not.
    const other = await app.inject({ url: "/api/v2/domain-intel?domain=other-fixture.com&fresh=1", headers: { "x-void-client": "a".repeat(32) } });
    expect(other.statusCode).toBe(200);
    const bad = await app.inject({ url: "/api/v2/domain-intel?domain=other2-fixture.com&fresh=1", headers: { "x-void-client": "not-a-key" } });
    expect(bad.statusCode).toBe(429);
    await app.close();
  }, 30_000);
});

describe("domain intelligence — regressions from the first live run", () => {
  it("scopes a tenant on a shared platform to the host, never the platform's other customers (00-02)", async () => {
    const host = "void-fixture.up.railway.app";
    const net = fixtureNet({
      dns: { [`${host}|A`]: ["66.33.22.1"], "other-customer.up.railway.app|A": ["66.33.22.2"] },
      json: { [`https://crt.sh/?q=${encodeURIComponent("%." + host)}&output=json&exclude=expired&deduplicate=Y`]: [{ name_value: `${host}\nother-customer.up.railway.app`, issuer_name: "O=Let's Encrypt", not_before: "2026-10-01", not_after: "2027-01-01" }] },
      http: { [`https://${host}/`]: { status: 200, headers: { "content-type": "text/html", server: "railway-edge" }, body: "<html><head><title>t</title></head><body><a href='https://other-customer.up.railway.app/'>x</a></body></html>" } },
    });
    const r = await runDomainIntel(host, { net, ownedRoots: [host], secret: "x", now: () => NOW });
    expect(r.domain).toBe(host);
    expect(r.scope.registrableDomain).toBe("railway.app");
    expect(r.scope.platform).toMatch(/Railway hosts .* scope is this host only/);
    expect(r.hosts.filter((h) => !h.reference).map((h) => h.host)).toEqual([host]);
    expect(net.calls.http.some((c) => c.url.includes("other-customer"))).toBe(false);
    expect(net.calls.http.some((c) => c.url === "https://rdap.org/domain/railway.app")).toBe(false);
    expect(r.scope.verification.record).toBe(`_void-verify.${host}`);
  });

  it("reads the full SMTP EHLO reply after the greeting (no false 'no STARTTLS')", async () => {
    const { createServer } = await import("node:net");
    const { __intelTesting } = await import("../src/domain-intel/net.js");
    __intelTesting.allowLoopback = true;
    const srv = createServer((sock) => { sock.on("error", (error) => { if((error as NodeJS.ErrnoException).code!=="ECONNRESET")throw error; });
      let greeted = false;
      sock.write("220-mx.fixture ESMTP ready\r\n");
      setTimeout(() => { sock.write("220 mx.fixture ESMTP\r\n"); greeted = true; }, 60);
      sock.on("data", (d) => {
        if (/^EHLO/.test(d.toString())) sock.write(greeted ? "250-mx.fixture at your service\r\n250-SIZE 157286400\r\n250-8BITMIME\r\n250-STARTTLS\r\n250 SMTPUTF8\r\n" : "554 too early\r\n");
        if (/^QUIT/.test(d.toString())) sock.end("221 bye\r\n");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      const res = await liveNet.tcp("127.0.0.1", port, { smtpEhlo: "void-intel.invalid", timeoutMs: 3000 });
      expect(res.open).toBe(true);
      expect(res.banner).toMatch(/250-STARTTLS/);
      expect(res.banner).toMatch(/250 SMTPUTF8/);
    } finally {
      __intelTesting.allowLoopback = false;
      srv.close();
    }
  });

  it("recognises an ECDSA P-256 certificate as EC (not a weak 256-bit key)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:tls");
    const { __intelTesting } = await import("../src/domain-intel/net.js");
    const dir = mkdtempSync(join(tmpdir(), "intel-ec-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "30", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const srv = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (s) => s.end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    __intelTesting.allowLoopback = true;
    try {
      const t = await liveNet.tls("localhost", { port: (srv.address() as { port: number }).port, timeoutMs: 3000 });
      expect(t.ok).toBe(true);
      expect(t.cert?.keyType).toBe("EC");
      expect(t.cert?.bits).toBe(256);
    } finally {
      __intelTesting.allowLoopback = false;
      srv.close();
    }
  });
});

describe("domain intelligence — unbounded branching", () => {
  it("keeps branching in waves until the frontier is empty (no host, depth or reference cap)", async () => {
    const D2 = "branchy-fixture.com";
    const dns: Record<string, string[] | "NX" | "ERR"> = { [`${D2}|A`]: ["203.0.113.50"] };
    // A chain 25 hosts long: each page links to the next, far past the old 16-host / depth-3 limits.
    const http: Record<string, Partial<HttpResult>> = {};
    for (let i = 0; i < 25; i++) {
      const h = i === 0 ? D2 : `n${i}.${D2}`, next = `n${i + 1}.${D2}`;
      dns[`${h}|A`] = ["203.0.113.50"];
      http[`https://${h}/`] = { status: 200, headers: { "content-type": "text/html" }, body: `<html><head><title>${h}</title></head><body><a href="https://${next}/">next</a></body></html>` };
    }
    dns[`n25.${D2}|A`] = "NX";
    // Wave 1 only: the run reports what is left; continuing explores it.
    const net = fixtureNet({ dns, http, json: { [`https://crt.sh/?q=${encodeURIComponent("%." + D2)}&output=json&exclude=expired&deduplicate=Y`]: [{ name_value: `san-only.${D2}`, issuer_name: "O=X", not_before: "2026-10-01", not_after: "2027-01-01" }] } });
    let clock = NOW;
    const run = new DomainRun(D2, { net, ownedRoots: [], secret: "x", now: () => (clock += 5) });
    await run.init(10_000);
    await run.wave(400); // tiny budget: forces several waves
    const first = run.report();
    expect(first.complete).toBe(false);
    expect(first.frontier).toBeGreaterThan(0);
    let waves = 1;
    while (run.frontier > 0 && waves < 50) { await run.wave(400); waves++; }
    const done = run.report();
    expect(done.complete).toBe(true);
    expect(done.waves).toBe(waves);
    const inScope = done.hosts.filter((h) => !h.reference).map((h) => h.host);
    expect(inScope).toContain(`n24.${D2}`);
    expect(inScope).toContain(`n25.${D2}`); // branch recorded even though it does not resolve
    expect(inScope).toContain(`san-only.${D2}`); // certificate-log branch
    expect(inScope.length).toBeGreaterThan(16);
    expect(done.rules).toHaveLength(188);
    expect(done.workflow.filter((w) => w.id.startsWith("wave-"))).toHaveLength(waves);
  });
  it("turns certificate SANs and resolvable common names into branches, ignoring wildcard answers", async () => {
    const D3 = "sans-fixture.com";
    const net = fixtureNet({
      dns: { [`${D3}|A`]: ["203.0.113.60"], [`api.${D3}|A`]: ["203.0.113.61"], [`void-intel-x.${D3}|A`]: [], [`mail.${D3}|A`]: [] },
      http: { [`https://${D3}/`]: { status: 200, headers: { "content-type": "text/html" }, body: "<html><head><title>t</title></head><body></body></html>" } },
      tls: { [D3]: { cert: { subject: `CN=${D3}`, issuer: "O=Let's Encrypt", validFrom: "2026-10-01T00:00:00Z", validTo: "2027-01-01T00:00:00Z", san: [D3, `vpn.${D3}`, "other-company.example.net"], serial: "1", fingerprint256: "AA", bits: 256, keyType: "EC", curve: "prime256v1", selfSigned: false, chainDepth: 2 } } },
    });
    const r = await runDomainIntel(D3, { net, ownedRoots: [], secret: "x", now: () => NOW });
    const via = (h: string) => r.edges.find((e) => e.to === h)?.kind;
    expect(via(`api.${D3}`)).toBe("DNS name");
    expect(via(`vpn.${D3}`)).toBe("certificate SAN");
    expect(r.hosts.find((h) => h.host === "other-company.example.net")?.reference).toBe(true);
    expect(r.findings.some((f) => /Certificate key/.test(f.title))).toBe(false); // EC P-256 is not weak
  });
  it("hashes favicons like internet search engines (MurmurHash3 x86-32, signed) and names technologies from headers", () => {
    expect(murmur3(Buffer.from(""))).toBe(0);
    expect(murmur3(Buffer.from("hello"))).toBe(613153351);
    expect(murmur3(Buffer.from("The quick brown fox jumps over the lazy dog"))).toBe(776992547);
    expect(techFromHeaders({ server: "nginx/1.25.3", "x-powered-by": "PHP/8.2", "set-cookie": "laravel_session=x; path=/", "cf-ray": "1" })).toEqual(expect.arrayContaining(["server: nginx/1.25.3", "powered by: PHP/8.2", "Laravel", "Cloudflare"]));
  });
  it("a host started late in a wave is still collected completely (no silent truncation)", async () => {
    const base = shopFixture();
    let t = NOW;
    const tick = <F extends (...a: never[]) => unknown>(f: F) => (async (...a: Parameters<F>) => { t += 40; return (f as unknown as (...x: unknown[]) => unknown).apply(base, a); }) as unknown as F;
    const net = { ...base, dns: tick(base.dns), http: tick(base.http), json: tick(base.json), tls: tick(base.tls), tcp: tick(base.tcp) } as IntelNet;
    const run = new DomainRun(D, { net, ownedRoots: [], secret: "x", now: () => t });
    await run.init(100);
    while (run.frontier > 0) await run.wave(50);
    const r = run.report();
    const withSite = r.hosts.filter((h) => !h.reference && (h.https?.status ?? 0) === 200 && /html/.test(h.https?.headers["content-type"] ?? ""));
    expect(withSite.length).toBeGreaterThan(0);
    for (const h of withSite) expect(h.page, h.host).not.toBeNull();
    expect(r.findings.some((f) => /Password form submits with GET/.test(f.title))).toBe(true);
  });
});


describe('private evidence access separation',()=>{
 it('requires an operator key, separates caches and protects continuation',async()=>{
  const app=Fastify(),net=shopFixture(),key='fixture-evidence-key-at-least-32-characters';
  registerDomainIntelRoutes(app,{net,ownedRoots:[D],secret:'fixture',evidenceKey:key});await app.ready();
  const request=`/api/v2/domain-intel?domain=${D}`;
  const privateRun=await app.inject({url:request,headers:{'x-void-evidence-key':key}});
  expect(privateRun.statusCode).toBe(200);expect(privateRun.json().pageEvidence.enabled).toBe(true);expect(privateRun.json().pageEvidence.records.length).toBeGreaterThan(0);
  expect(privateRun.headers['cache-control']).toBe('no-store');
  const publicRun=await app.inject({url:request});expect(publicRun.json().pageEvidence.enabled).toBe(false);expect(publicRun.json().pageEvidence.records).toEqual([]);
  const denied=await app.inject({url:request,headers:{'x-void-evidence-key':'wrong'}});expect(denied.statusCode).toBe(403);
  const cont=await app.inject({url:`/api/v2/domain-intel/continue?run=${privateRun.json().runId}`});expect(cont.statusCode).toBe(403);
  await app.close();
 });
 it("requires both an audit key and authorized scope for live validation", async () => {
  const app = Fastify();
  const key = "fixture-key-not-production-0123456789";
  registerDomainIntelRoutes(app, { net: fixtureNet({dns:{},http:{}}), ownedRoots: [], evidenceKey: key, secret: "fixture" });
  try {
   const url = "/api/v2/domain-intel?domain=" + D + "&validate=1";
   expect((await app.inject({ url })).json().error).toBe("VALIDATION_KEY_REQUIRED");
   const denied = await app.inject({ url, headers: { "x-void-evidence-key": key } });
   expect(denied.statusCode).toBe(403);
   expect(denied.json().error).toBe("VALIDATION_SCOPE_REQUIRED");
   expect(denied.headers["cache-control"]).toBe("no-store");
  } finally { await app.close(); }
 });

});
