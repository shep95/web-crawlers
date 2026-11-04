import * as cheerio from "cheerio";
import { getDomain, getPublicSuffix, getSubdomain } from "tldts";
import { detectSecrets, type SecretType } from "../text/secrets.js";
import type { DnsResult, HttpResult, IntelNet, TcpResult, TlsResult } from "./net.js";

/** Facts gathered for the registrable domain as a whole (registration, mail, history). */
export interface DomainFacts {
  domain: string;
  suffix: string | null;
  idn: { punycode: boolean; unicode: string | null; mixedScript: boolean };
  rdap: null | { registrar: string | null; registrarAbuse: string | null; status: string[]; created: string | null; changed: string | null; expires: string | null; nameservers: string[]; dnssec: boolean | null; source: string };
  rdapError?: string;
  mail: {
    spf: string[]; spfAll: string | null; spfLookups: number; spfLookupHosts: string[]; spfPtr: boolean;
    dmarc: string[]; dmarcPolicy: string | null; dmarcSubPolicy: string | null; dmarcPct: number | null; dmarcRua: string[];
    dkim: Array<{ selector: string; keyBits: number | null; revoked: boolean }>;
    mtaSts: { dns: string | null; policy: string | null; mode: string | null };
    tlsRpt: string | null; bimi: string | null; nullMx: boolean;
    smtp: null | { host: string; banner: string | null; starttls: boolean | null; error?: string };
  };
  ct: { names: string[]; issuers: Array<{ name: string; count: number }>; certificates: number; earliest: string | null; latest: string | null; error?: string };
  wildcard: { a: string[]; probe: string } | null;
  lookalikes: Array<{ name: string; kind: string; resolves: boolean; a: string[] }>;
  wayback: { urls: string[]; interesting: string[]; error?: string };
  dnssec: { ds: boolean; dnskey: boolean; validated: boolean };
  /** Lookups that failed (network/resolver error): their absence is unknown, never reported as missing. */
  unavailable: string[];
}

export interface ScriptFacts { src: string; host: string; firstParty: boolean; integrity: boolean; crossorigin: boolean }
export interface PageFacts {
  title: string | null; generator: string | null; lang: string | null; bytes: number;
  forms: Array<{ action: string; method: string; password: boolean; file: boolean; hidden: string[]; inputs: string[]; csrf: boolean; insecureAction: boolean }>;
  scripts: ScriptFacts[]; inlineScripts: number; iframes: string[]; links: string[]; externalHosts: string[];
  manifest: string | null; spa: string[]; frameworks: string[];
  authLinks: { login: string[]; register: string[]; reset: string[]; logout: string[]; sso: string[] };
  paramLinks: Array<{ url: string; params: string[] }>; redirectParams: string[]; idRoutes: string[]; fileRoutes: string[];
  searchOrPaging: string[]; versionedApi: string[]; mixedContent: string[]; emails: number;
  signals: { storage: string[]; postMessage: boolean; messageListener: boolean; innerHTML: boolean; eval: boolean; wasm: boolean; serviceWorker: boolean; websocket: string[]; graphql: string[]; apiCalls: string[]; sourceMaps: string[] };
  secrets: Array<{ type: SecretType; confidence: string; location: string; length: number; placeholder: boolean }>;
  thirdParty: Array<{ host: string; category: string }>;
}

export interface HostFacts {
  host: string; depth: number; parent: string | null; via: string; inScope: boolean; reference: boolean;
  provider: { name: string; kind: string; evidence: string } | null;
  dns: Record<string, DnsResult>; cnameChain: string[]; addresses: string[]; dangling: null | { target: string; provider: string; reason: string };
  ips: Array<{ ip: string; ptr: string[]; network: string | null; org: string | null; country: string | null; cidr: string | null; provider: string | null }>;
  https: HttpResult | null; http: HttpResult | null; tls: TlsResult | null; legacyTls: Record<string, boolean | null> | null;
  page: PageFacts | null; robots: { status: number; disallow: string[]; sitemaps: string[] } | null; sitemap: { status: number; urls: number; sample: string[] } | null;
  securityTxt: { status: number; contact: string[]; expires: string | null; expired: boolean | null; signed: boolean } | null;
  notFound: { status: number; leaks: string[]; soft404: boolean } | null; oidc: null | { issuer: string | null; grants: string[]; pkce: boolean };
  ports: TcpResult[] | null; exposures: Array<{ path: string; status: number; signature: string | null; bytes: number }> | null;
  cors: null | { origin: string; acao: string | null; credentials: boolean; reflected: boolean }; openRedirect: null | { url: string; location: string | null; external: boolean };
  dnsFailed: string[]; errors: string[]; ms: number;
}

// ---------------------------------------------------------------------------------------------
// Provider attribution (00-02): hostnames, nameservers, headers and network names that identify a
// vendor, CDN or platform. A host on one of these is a dependency, never a target by inference.
const PROVIDERS: Array<{ name: string; kind: string; host?: RegExp; header?: (h: Record<string, string>) => boolean; org?: RegExp }> = [
  { name: "Vercel", kind: "platform", host: /\.vercel\.app$|\.vercel-dns\.com$|\.now\.sh$/i, header: (h) => /vercel/i.test(h.server ?? "") || "x-vercel-id" in h, org: /vercel/i },
  { name: "Railway", kind: "platform", host: /\.up\.railway\.app$|\.railway\.app$/i, header: (h) => /railway/i.test(h.server ?? "") || "x-railway-request-id" in h || "x-railway-edge" in h, org: /railway/i },
  { name: "Cloudflare", kind: "cdn", host: /\.cloudflare\.net$|\.ns\.cloudflare\.com$|\.pages\.dev$|\.workers\.dev$/i, header: (h) => /cloudflare/i.test(h.server ?? "") || "cf-ray" in h, org: /cloudflare/i },
  { name: "Fastly", kind: "cdn", host: /\.fastly\.net$|\.fastlylb\.net$/i, header: (h) => "x-served-by" in h && /cache-/i.test(h["x-served-by"] ?? ""), org: /fastly/i },
  { name: "Akamai", kind: "cdn", host: /\.akamai(?:edge|technologies|hd)?\.net$|\.edgekey\.net$|\.edgesuite\.net$/i, header: (h) => /akamai/i.test(h.server ?? ""), org: /akamai/i },
  { name: "Amazon CloudFront", kind: "cdn", host: /\.cloudfront\.net$/i, header: (h) => /cloudfront/i.test(h.via ?? "") || "x-amz-cf-id" in h },
  { name: "Amazon Web Services", kind: "cloud", host: /\.amazonaws\.com$|\.awsdns-\d+\./i, header: (h) => "x-amz-request-id" in h || /AmazonS3|awselb/i.test(h.server ?? ""), org: /amazon|aws/i },
  { name: "Microsoft Azure", kind: "cloud", host: /\.azurewebsites\.net$|\.cloudapp\.azure\.com$|\.azureedge\.net$|\.trafficmanager\.net$|\.blob\.core\.windows\.net$|\.azurefd\.net$/i, org: /microsoft|azure/i },
  { name: "Google Cloud", kind: "cloud", host: /\.googleusercontent\.com$|\.appspot\.com$|\.run\.app$|\.web\.app$|\.firebaseapp\.com$|storage\.googleapis\.com$/i, header: (h) => /^(gws|Google Frontend|gfe)/i.test(h.server ?? ""), org: /google/i },
  { name: "GitHub Pages", kind: "platform", host: /\.github\.io$/i, header: (h) => /github\.com/i.test(h.server ?? ""), org: /github/i },
  { name: "Netlify", kind: "platform", host: /\.netlify\.app$|\.netlify\.com$/i, header: (h) => /netlify/i.test(h.server ?? ""), org: /netlify/i },
  { name: "Heroku", kind: "platform", host: /\.herokuapp\.com$|\.herokudns\.com$/i, org: /heroku|salesforce/i },
  { name: "Render", kind: "platform", host: /\.onrender\.com$/i, header: (h) => "rndr-id" in h },
  { name: "Fly.io", kind: "platform", host: /\.fly\.dev$/i, header: (h) => "fly-request-id" in h },
  { name: "Shopify", kind: "saas", host: /\.myshopify\.com$|shops\.myshopify\.com$/i, header: (h) => "x-shopid" in h },
  { name: "Squarespace", kind: "saas", host: /\.squarespace\.com$/i, header: (h) => /squarespace/i.test(h.server ?? "") },
  { name: "Wix", kind: "saas", host: /\.wixdns\.net$|\.wixsite\.com$/i, header: (h) => /pepyaka|wix/i.test(h.server ?? "") },
  { name: "Google Workspace mail", kind: "mail", host: /aspmx\.l\.google\.com$|googlemail\.com$/i },
  { name: "Microsoft 365 mail", kind: "mail", host: /\.mail\.protection\.outlook\.com$/i },
  { name: "Proton Mail", kind: "mail", host: /\.protonmail\.ch$/i },
  { name: "Zoho Mail", kind: "mail", host: /\.zoho\.(?:com|eu)$/i },
];

/** Dangling-DNS fingerprints (02-03): the provider page that answers for a resource nobody has claimed. */
const TAKEOVER: Array<{ provider: string; host: RegExp; body?: RegExp; nx?: boolean }> = [
  { provider: "GitHub Pages", host: /\.github\.io$/i, body: /There isn't a GitHub Pages site here/i },
  { provider: "Heroku", host: /\.herokuapp\.com$|\.herokudns\.com$/i, body: /No such app|herokucdn\.com\/error-pages\/no-such-app/i },
  { provider: "Amazon S3", host: /\.s3[.-][\w.-]*amazonaws\.com$|\.s3-website/i, body: /NoSuchBucket|The specified bucket does not exist/i },
  { provider: "Azure", host: /\.azurewebsites\.net$|\.cloudapp\.net$|\.cloudapp\.azure\.com$|\.trafficmanager\.net$|\.blob\.core\.windows\.net$|\.azureedge\.net$/i, nx: true },
  { provider: "Netlify", host: /\.netlify\.app$|\.netlify\.com$/i, body: /Not Found - Request ID/i },
  { provider: "Vercel", host: /\.vercel\.app$|cname\.vercel-dns\.com$/i, body: /DEPLOYMENT_NOT_FOUND|The deployment could not be found/i },
  { provider: "Shopify", host: /\.myshopify\.com$/i, body: /Sorry, this shop is currently unavailable/i },
  { provider: "Fastly", host: /\.fastly\.net$/i, body: /Fastly error: unknown domain/i },
  { provider: "Pantheon", host: /\.pantheonsite\.io$/i, body: /The gods are wise, but do not know of the site/i },
  { provider: "Surge", host: /\.surge\.sh$/i, body: /project not found/i },
  { provider: "Firebase", host: /\.web\.app$|\.firebaseapp\.com$/i, body: /Site Not Found/i },
  { provider: "Railway", host: /\.up\.railway\.app$/i, body: /Application not found/i },
];

const THIRD_PARTY_CATEGORIES: Array<[RegExp, string]> = [
  [/google-analytics\.com|googletagmanager\.com|analytics\.|segment\.(?:com|io)|plausible\.io|mixpanel|hotjar|clarity\.ms|amplitude/i, "analytics"],
  [/stripe\.com|paypal\.com|braintree|adyen|squareup|checkout\.com|klarna/i, "payment"],
  [/auth0\.com|okta\.com|onelogin|clerk\.|firebaseauth|accounts\.google\.com|login\.microsoftonline\.com|cognito/i, "identity"],
  [/doubleclick|googlesyndication|adservice|facebook\.net|connect\.facebook|ads\./i, "advertising"],
  [/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|ajax\.googleapis\.com|code\.jquery\.com/i, "public CDN"],
  [/recaptcha|hcaptcha|turnstile/i, "bot protection"],
  [/intercom|zendesk|crisp\.chat|drift\.com|tawk\.to|hubspot/i, "support/CRM"],
  [/sentry|datadog|newrelic|bugsnag|logrocket/i, "monitoring"],
  [/fonts\.googleapis|fonts\.gstatic|typekit|use\.fontawesome/i, "fonts"],
  [/youtube|vimeo|player\./i, "media embed"],
];

export const registrable = (host: string) => getDomain(host, { allowPrivateDomains: true }) ?? host;
export const sameSite = (a: string, b: string) => registrable(a) === registrable(b);

export function attributeProvider(host: string, headers: Record<string, string> = {}, extra: { cname?: string[]; ns?: string[]; org?: string | null } = {}): HostFacts["provider"] {
  for (const p of PROVIDERS) {
    if (p.host && p.host.test(host)) return { name: p.name, kind: p.kind, evidence: `hostname ${host}` };
    const c = extra.cname?.find((x) => p.host?.test(x));
    if (c) return { name: p.name, kind: p.kind, evidence: `CNAME → ${c}` };
    if (p.header && p.header(headers)) return { name: p.name, kind: p.kind, evidence: `HTTP response headers (${Object.keys(headers).filter((k) => /server|^x-(vercel|railway|amz)|cf-ray|via|fly|rndr/.test(k)).join(", ") || "server"})` };
    if (p.org && extra.org && p.org.test(extra.org)) return { name: p.name, kind: p.kind, evidence: `IP network owner “${extra.org}” (RDAP)` };
  }
  return null;
}

const strip = (s: string) => s.replace(/\.$/, "").toLowerCase();
const txtValue = (d: string) => d.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
const answers = (r: DnsResult | undefined, type: number) => (r?.answers ?? []).filter((a) => a.type === type).map((a) => a.data);

// ---------------------------------------------------------------------------------------------
export async function collectDomain(net: IntelNet, domain: string, opts: { authorized: boolean; budget: () => boolean }): Promise<DomainFacts> {
  const unicode = domain.includes("xn--") ? domain.split(".").map((l) => (l.startsWith("xn--") ? punyDecode(l.slice(4)) : l)).join(".") : null;
  const facts: DomainFacts = {
    domain, suffix: getPublicSuffix(domain, { allowPrivateDomains: true }),
    idn: { punycode: domain.includes("xn--"), unicode, mixedScript: unicode ? mixedScripts(unicode) : false },
    rdap: null,
    mail: { spf: [], spfAll: null, spfLookups: 0, spfLookupHosts: [], spfPtr: false, dmarc: [], dmarcPolicy: null, dmarcSubPolicy: null, dmarcPct: null, dmarcRua: [], dkim: [], mtaSts: { dns: null, policy: null, mode: null }, tlsRpt: null, bimi: null, nullMx: false, smtp: null },
    ct: { names: [], issuers: [], certificates: 0, earliest: null, latest: null }, wildcard: null, lookalikes: [], wayback: { urls: [], interesting: [] },
    dnssec: { ds: false, dnskey: false, validated: false }, unavailable: [],
  };
  const probe = `void-intel-${Math.random().toString(36).slice(2, 10)}.${domain}`;
  const [rdap, txt, dmarc, mtaSts, tlsRpt, bimi, ds, dnskey, wild, mx, ct, wb] = await Promise.all([
    net.json<Record<string, unknown>>(`https://rdap.org/domain/${encodeURIComponent(domain)}`, 12_000),
    net.dns(domain, "TXT"), net.dns(`_dmarc.${domain}`, "TXT"), net.dns(`_mta-sts.${domain}`, "TXT"), net.dns(`_smtp._tls.${domain}`, "TXT"),
    net.dns(`default._bimi.${domain}`, "TXT"), net.dns(domain, "DS"), net.dns(domain, "DNSKEY"), net.dns(probe, "A"), net.dns(domain, "MX"),
    net.json<Array<{ name_value: string; issuer_name: string; not_before: string; not_after: string }>>(`https://crt.sh/?q=${encodeURIComponent("%." + domain)}&output=json&exclude=expired&deduplicate=Y`, 20_000),
    net.json<string[][]>(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain + "/*")}&output=json&fl=original&collapse=urlkey&limit=400`, 15_000),
  ]);
  const failed = (r: DnsResult) => r.status === -1 || r.status === 2; // transport error or SERVFAIL
  for (const [name, r] of [["txt", txt], ["dmarc", dmarc], ["mta-sts", mtaSts], ["tls-rpt", tlsRpt], ["ds", ds], ["dnskey", dnskey], ["wildcard", wild], ["mx", mx]] as const) if (failed(r)) facts.unavailable.push(name);
  if (rdap) {
    const ev = (a: string) => ((rdap.events as Array<{ eventAction: string; eventDate: string }>) ?? []).find((e) => e.eventAction === a)?.eventDate ?? null;
    const ents = (rdap.entities as Array<{ roles?: string[]; vcardArray?: unknown[]; entities?: unknown[] }>) ?? [];
    const vcardName = (e: { vcardArray?: unknown[] } | undefined) => ((e?.vcardArray?.[1] as unknown[][] | undefined)?.find((x) => x[0] === "fn")?.[3] as string | undefined) ?? null;
    const reg = ents.find((e) => e.roles?.includes("registrar"));
    const abuse = ((reg?.entities as Array<{ roles?: string[]; vcardArray?: unknown[] }> | undefined) ?? []).find((e) => e.roles?.includes("abuse"));
    const abuseEmail = ((abuse?.vcardArray?.[1] as unknown[][] | undefined)?.find((x) => x[0] === "email")?.[3] as string | undefined) ?? null;
    facts.rdap = {
      registrar: vcardName(reg), registrarAbuse: abuseEmail ? abuseEmail.replace(/^(.).*(@.*)$/, "$1…$2") : null,
      status: ((rdap.status as string[]) ?? []).map((s) => s.toLowerCase()), created: ev("registration"), changed: ev("last changed"), expires: ev("expiration"),
      nameservers: ((rdap.nameservers as Array<{ ldhName: string }>) ?? []).map((n) => strip(n.ldhName)),
      dnssec: typeof (rdap.secureDNS as { delegationSigned?: boolean } | undefined)?.delegationSigned === "boolean" ? !!(rdap.secureDNS as { delegationSigned: boolean }).delegationSigned : null,
      source: "rdap.org",
    };
  } else facts.rdapError = "RDAP did not answer for this name (private registry, unsupported TLD, or a platform subdomain without its own registration)";
  const txts = answers(txt, 16).map(txtValue);
  facts.mail.spf = txts.filter((t) => /^v=spf1\b/i.test(t));
  if (facts.mail.spf[0]) {
    facts.mail.spfAll = /([+~?-]?)all\b/i.exec(facts.mail.spf[0])?.[0] ?? null;
    facts.mail.spfPtr = /\bptr\b/i.test(facts.mail.spf[0]);
    const seen = new Set<string>();
    const walk = async (record: string, depth: number): Promise<void> => {
      for (const m of record.matchAll(/\b(include|redirect|exists|a|mx|ptr)(?:[:=]([^\s]+))?/gi)) {
        facts.mail.spfLookups++;
        const target = m[2];
        if (target && /include|redirect/i.test(m[1]) && !seen.has(target) && depth < 4 && seen.size < 12 && opts.budget()) {
          seen.add(target);
          facts.mail.spfLookupHosts.push(target);
          const r = await net.dns(target, "TXT");
          const next = answers(r, 16).map(txtValue).find((t) => /^v=spf1\b/i.test(t));
          if (next) await walk(next, depth + 1);
        }
      }
    };
    await walk(facts.mail.spf[0], 0);
  }
  facts.mail.dmarc = answers(dmarc, 16).map(txtValue).filter((t) => /^v=DMARC1/i.test(t));
  if (facts.mail.dmarc[0]) {
    const tag = (k: string) => new RegExp(`(?:^|;)\\s*${k}=([^;]+)`, "i").exec(facts.mail.dmarc[0])?.[1]?.trim() ?? null;
    facts.mail.dmarcPolicy = tag("p");
    facts.mail.dmarcSubPolicy = tag("sp");
    facts.mail.dmarcPct = tag("pct") ? Number(tag("pct")) : null;
    facts.mail.dmarcRua = (tag("rua") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^(mailto:.).*(@.*)$/i, "$1…$2"));
  }
  facts.mail.mtaSts.dns = answers(mtaSts, 16).map(txtValue).find((t) => /^v=STSv1/i.test(t)) ?? null;
  if (facts.mail.mtaSts.dns && opts.budget()) {
    const pol = await net.http(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, { maxBytes: 16 * 1024, follow: false });
    if (pol.status === 200) {
      facts.mail.mtaSts.policy = pol.body.slice(0, 2000);
      facts.mail.mtaSts.mode = /mode:\s*(\w+)/i.exec(pol.body)?.[1] ?? null;
    }
  }
  facts.mail.tlsRpt = answers(tlsRpt, 16).map(txtValue).find((t) => /^v=TLSRPTv1/i.test(t)) ?? null;
  facts.mail.bimi = answers(bimi, 16).map(txtValue).find((t) => /^v=BIMI1/i.test(t)) ?? null;
  const mxs = answers(mx, 15);
  facts.mail.nullMx = mxs.length === 1 && /^0\s+\.?$/.test(mxs[0].trim());
  // DKIM: selectors are not enumerable; a fixed list of common public selectors is queried (02-08).
  const selectors = ["default", "google", "selector1", "selector2", "k1", "k2", "s1", "s2", "mail", "dkim", "smtp", "mandrill", "mxvault", "zoho", "protonmail", "resend", "sendgrid", "pm", "fm1", "everlytickey1"];
  const dk = await Promise.all(selectors.map((s) => net.dns(`${s}._domainkey.${domain}`, "TXT")));
  if (dk.every(failed)) facts.unavailable.push("dkim");
  dk.forEach((r, i) => {
    const v = answers(r, 16).map(txtValue).find((t) => /\bp=/i.test(t));
    if (v) {
      const key = /\bp=([A-Za-z0-9+/=]*)/i.exec(v)?.[1] ?? "";
      facts.mail.dkim.push({ selector: selectors[i], keyBits: key ? approxRsaBits(key) : null, revoked: key === "" });
    }
  });
  facts.dnssec = { ds: answers(ds, 43).length > 0, dnskey: answers(dnskey, 48).length > 0, validated: !!(ds.ad || dnskey.ad) };
  const wa = failed(wild) ? [] : answers(wild, 1);
  if (wa.length) facts.wildcard = { a: wa, probe };
  if (ct) {
    const names = new Set<string>(), issuers = new Map<string, number>();
    let earliest: string | null = null, latest: string | null = null;
    for (const c of ct.slice(0, 5000)) {
      for (const n of String(c.name_value).split(/\n/)) {
        const h = strip(n.replace(/^\*\./, ""));
        if (h.endsWith(domain) && /^[a-z0-9.-]+$/.test(h)) names.add(h);
      }
      const iss = /O=([^,]+)/.exec(c.issuer_name)?.[1] ?? c.issuer_name;
      issuers.set(iss, (issuers.get(iss) ?? 0) + 1);
      if (!earliest || c.not_before < earliest) earliest = c.not_before;
      if (!latest || c.not_before > latest) latest = c.not_before;
    }
    facts.ct = { names: [...names].sort(), issuers: [...issuers].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), certificates: ct.length, earliest, latest };
  } else facts.ct.error = "certificate transparency log (crt.sh) did not answer in time";
  if (wb && Array.isArray(wb)) {
    const urls = wb.slice(1).map((r) => r[0]).filter(Boolean);
    facts.wayback.urls = urls.slice(0, 400);
    facts.wayback.interesting = urls.filter((u) => /\/(admin|wp-admin|wp-login|phpmyadmin|backup|old|test|staging|dev|debug|console|api\/v\d|graphql|swagger|\.env|\.git|config|export|download|upload)\b|\.(bak|sql|zip|tar|gz|log|old|swp)(\?|$)/i.test(u)).slice(0, 60);
  } else facts.wayback.error = "Internet Archive CDX did not answer in time";
  // Lookalikes (01-04): a small set of confusable variants, checked by DNS only (registered or not).
  if (opts.budget()) {
    const variants = lookalikes(domain).slice(0, 14);
    const res = await Promise.all(variants.map((v) => net.dns(v.name, "A")));
    facts.lookalikes = variants.map((v, i) => ({ ...v, resolves: answers(res[i], 1).length > 0, a: answers(res[i], 1).slice(0, 3) })).filter((v) => v.resolves || res[0]);
  }
  // SMTP (03-06 / 16-02): one connection to the first MX, as any sending server would make: banner, EHLO, STARTTLS offer.
  const mx0 = mxs.map((m) => m.split(/\s+/)).sort((a, b) => Number(a[0]) - Number(b[0]))[0]?.[1];
  if (mx0 && !facts.mail.nullMx && opts.budget()) {
    const host = strip(mx0);
    const r = await net.tcp(host, 25, { readBanner: true, send: "EHLO void-intel.invalid\r\n", timeoutMs: 6000 });
    facts.mail.smtp = { host, banner: r.banner?.split(/\r?\n/)[0]?.slice(0, 200) ?? null, starttls: r.banner ? /STARTTLS/i.test(r.banner) : null, error: r.open ? undefined : r.error ?? "no answer (outbound port 25 is often blocked by hosting networks)" };
  }
  return facts;
}

function approxRsaBits(b64: string): number | null {
  const bytes = Math.floor((b64.replace(/=+$/, "").length * 3) / 4);
  if (bytes < 60) return null;
  return bytes > 500 ? 4096 : bytes > 250 ? 2048 : bytes > 150 ? 1024 : 512;
}

function mixedScripts(s: string): boolean {
  const scripts = new Set<string>();
  for (const ch of s.replace(/[.\-0-9]/g, "")) {
    if (/\p{Script=Latin}/u.test(ch)) scripts.add("Latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add("Cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add("Greek");
    else scripts.add("other");
  }
  return scripts.size > 1;
}

/** RFC 3492 decoder (enough for display of xn-- labels). */
function punyDecode(input: string): string {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  let n = 128, i = 0, bias = 72;
  const basic = input.lastIndexOf("-");
  const out: number[] = basic > 0 ? [...input.slice(0, basic)].map((c) => c.charCodeAt(0)) : [];
  const adapt = (delta: number, num: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / num);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (idx >= input.length) return input;
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

export function lookalikes(domain: string): Array<{ name: string; kind: string }> {
  // Names under a platform suffix (x.vercel.app, x.github.io) are handed out by the platform, not a registrar: no lookalike check.
  if (getSubdomain(domain, { allowPrivateDomains: true }) || getPublicSuffix(domain, { allowPrivateDomains: true }) !== getPublicSuffix(domain)) return [];
  const suffix = getPublicSuffix(domain, { allowPrivateDomains: true }) ?? "";
  const label = domain.slice(0, -(suffix.length + 1));
  if (!label || label.includes(".")) return [];
  const out = new Map<string, string>();
  const add = (l: string, kind: string, sfx = suffix) => {
    if (l && `${l}.${sfx}` !== domain && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-")) out.set(`${l}.${sfx}`, kind);
  };
  const homo: Record<string, string> = { o: "0", l: "1", i: "1", e: "3", a: "4", s: "5", m: "rn" };
  for (let i = 0; i < label.length; i++) {
    add(label.slice(0, i) + label.slice(i + 1), "omission");
    if (i < label.length - 1) add(label.slice(0, i) + label[i + 1] + label[i] + label.slice(i + 2), "transposition");
    if (homo[label[i]]) add(label.slice(0, i) + homo[label[i]] + label.slice(i + 1), "homoglyph");
  }
  add(label + "-login", "affix");
  add(label + "-secure", "affix");
  for (const t of ["com", "net", "org", "co", "io"]) if (t !== suffix) add(label, "tld swap", t);
  return [...out].map(([name, kind]) => ({ name, kind }));
}

// ---------------------------------------------------------------------------------------------
const SENSITIVE_PATHS: Array<{ path: string; signature: RegExp }> = [
  { path: "/.git/HEAD", signature: /^ref: refs\//m },
  { path: "/.env", signature: /^[A-Z][A-Z0-9_]{2,}=/m },
  { path: "/.DS_Store", signature: /Bud1/ },
  { path: "/server-status", signature: /Apache Server Status/i },
  { path: "/phpinfo.php", signature: /phpinfo\(\)|PHP Version/i },
  { path: "/.well-known/openid-configuration", signature: /"issuer"/ },
  { path: "/swagger.json", signature: /"swagger"|"openapi"/ },
  { path: "/openapi.json", signature: /"openapi"/ },
  { path: "/graphql", signature: /graphql|query/i },
  { path: "/package.json", signature: /"dependencies"|"name"\s*:/ },
  { path: "/composer.lock", signature: /"packages"/ },
  { path: "/backup.zip", signature: /^PK/ },
  { path: "/actuator/health", signature: /"status"/ },
  { path: "/debug", signature: /traceback|stack|debug/i },
];

const DB_PORTS = [21, 22, 23, 25, 110, 143, 445, 1433, 1521, 2375, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 11211, 27017];

export async function collectHost(
  net: IntelNet,
  host: string,
  meta: { depth: number; parent: string | null; via: string; inScope: boolean; reference: boolean; authorized: boolean; budget: () => boolean; probedIps?: Set<string> },
): Promise<HostFacts> {
  const t0 = Date.now();
  const f: HostFacts = {
    host, depth: meta.depth, parent: meta.parent, via: meta.via, inScope: meta.inScope, reference: meta.reference, provider: null, dns: {}, cnameChain: [], addresses: [], dangling: null,
    ips: [], https: null, http: null, tls: null, legacyTls: null, page: null, robots: null, sitemap: null, securityTxt: null, notFound: null, oidc: null, ports: null, exposures: null, cors: null, openRedirect: null, dnsFailed: [], errors: [], ms: 0,
  };
  const types = meta.reference ? ["A", "AAAA", "CNAME"] : ["A", "AAAA", "CNAME", "NS", "MX", "TXT", "CAA", "SOA", "HTTPS"];
  const res = await Promise.all(types.map((t) => net.dns(host, t)));
  types.forEach((t, i) => (f.dns[t] = res[i]));
  types.forEach((t, i) => {
    if (res[i].status === -1 || res[i].status === 2) f.dnsFailed.push(t);
  });
  if (f.dnsFailed.length) f.errors.push(`DNS lookups failed (${f.dnsFailed.join(", ")}): ${res.find((r) => r.error)?.error ?? "SERVFAIL"}`);
  f.cnameChain = [...answers(f.dns.CNAME, 5), ...answers(f.dns.A, 5)].map(strip).filter((v, i, a) => a.indexOf(v) === i);
  f.addresses = [...answers(f.dns.A, 1), ...answers(f.dns.AAAA, 28)];
  // CAA is inherited from the closest ancestor that publishes it (RFC 8659).
  if (!meta.reference && !answers(f.dns.CAA, 257).length) {
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const parentName = labels.slice(i).join(".");
      const r = await net.dns(parentName, "CAA");
      if (answers(r, 257).length) {
        f.dns.CAA = { ...r, answers: r.answers.map((a) => ({ ...a, name: parentName })) };
        break;
      }
    }
  }
  // Dangling DNS hypothesis (02-03, worked chain steps 1–3): CNAME to a provider resource that does not exist.
  const lastCname = f.cnameChain.at(-1);
  if (lastCname) {
    const fp = TAKEOVER.find((t) => t.host.test(lastCname));
    if (fp && (fp.nx || !f.addresses.length) && (f.dns.A.status === 3 || !f.addresses.length)) f.dangling = { target: lastCname, provider: fp.provider, reason: "CNAME target does not resolve (NXDOMAIN)" };
  }
  if (meta.reference || !f.addresses.length) {
    f.provider = attributeProvider(host, {}, { cname: f.cnameChain });
    f.ms = Date.now() - t0;
    return f;
  }
  // IP ownership (03-01 / 14-01): PTR + RDAP network name for up to 3 addresses.
  f.ips = await Promise.all(
    f.addresses.slice(0, 3).map(async (ip) => {
      const ptrName = ip.includes(":") ? null : ip.split(".").reverse().join(".") + ".in-addr.arpa";
      const [ptr, rd] = await Promise.all([ptrName ? net.dns(ptrName, "PTR") : Promise.resolve(null), net.json<Record<string, unknown>>(`https://rdap.org/ip/${encodeURIComponent(ip)}`, 10_000)]);
      const ents = (rd?.entities as Array<{ vcardArray?: unknown[] }> | undefined) ?? [];
      const org = ents.map((e) => (e.vcardArray?.[1] as unknown[][] | undefined)?.find((x) => x[0] === "fn")?.[3] as string | undefined).find(Boolean) ?? null;
      const cidr = (rd?.cidr0_cidrs as Array<{ v4prefix?: string; v6prefix?: string; length: number }> | undefined)?.[0];
      return {
        ip, ptr: ptr ? answers(ptr, 12).map(strip) : [], network: (rd?.name as string) ?? null, org, country: (rd?.country as string) ?? null,
        cidr: cidr ? `${cidr.v4prefix ?? cidr.v6prefix}/${cidr.length}` : null, provider: attributeProvider(host, {}, { org: `${rd?.name ?? ""} ${org ?? ""}` })?.name ?? null,
      };
    }),
  );
  // HTTPS + HTTP (03-03, 04-01, 04-03), TLS handshake (04-01/04-07).
  const [https, http, tls] = await Promise.all([
    net.http(`https://${host}/`, { maxBytes: 768 * 1024 }),
    net.http(`http://${host}/`, { follow: false, maxBytes: 16 * 1024 }),
    net.tls(host),
  ]);
  f.https = { ...https, body: https.body };
  f.http = { ...http, body: "" };
  f.tls = tls;
  if (https.error) f.errors.push(`HTTPS: ${https.error}`);
  f.provider = attributeProvider(host, https.headers, { cname: f.cnameChain, org: f.ips.map((i) => `${i.network ?? ""} ${i.org ?? ""}`).join(" ") });
  if (lastCname && !f.dangling && https.status) {
    const fp = TAKEOVER.find((t) => t.host.test(lastCname) && t.body?.test(https.body));
    if (fp) f.dangling = { target: lastCname, provider: fp.provider, reason: `${fp.provider} answers with its “unclaimed resource” page` };
  }
  const base = https.status ? new URL(https.finalUrl) : null;
  if (base && /html/i.test(https.headers["content-type"] ?? "")) f.page = await parsePage(net, https.body, base, host, meta.budget);
  if (base && meta.budget()) {
    const origin = `https://${host}`;
    const rand = `void-intel-${Math.random().toString(36).slice(2, 8)}`;
    const [robots, sec, nf, oidc] = await Promise.all([
      net.http(`${origin}/robots.txt`, { maxBytes: 128 * 1024 }),
      net.http(`${origin}/.well-known/security.txt`, { maxBytes: 32 * 1024 }),
      net.http(`${origin}/${rand}`, { maxBytes: 64 * 1024 }),
      net.http(`${origin}/.well-known/openid-configuration`, { maxBytes: 64 * 1024, follow: false }),
    ]);
    if (robots.status) {
      const ok = robots.status === 200 && !/<html/i.test(robots.body);
      f.robots = { status: robots.status, disallow: ok ? [...robots.body.matchAll(/^\s*Disallow:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 80) : [], sitemaps: ok ? [...robots.body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 10) : [] };
    }
    const smUrl = f.robots?.sitemaps.find((s) => { try { return sameSite(new URL(s).hostname, host); } catch { return false; } }) ?? `${origin}/sitemap.xml`;
    const sm = await net.http(smUrl, { maxBytes: 2 * 1024 * 1024 });
    if (sm.status) {
      const locs = sm.status === 200 ? [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]) : [];
      f.sitemap = { status: sm.status, urls: locs.length, sample: locs.slice(0, 12) };
    }
    if (sec.status) {
      const ok = sec.status === 200 && /contact:/i.test(sec.body);
      const exp = ok ? /^Expires:\s*(.+)$/im.exec(sec.body)?.[1]?.trim() ?? null : null;
      f.securityTxt = { status: sec.status, contact: ok ? [...sec.body.matchAll(/^Contact:\s*(\S+)/gim)].map((m) => m[1].replace(/^(mailto:.).*(@.*)$/i, "$1…$2")) : [], expires: exp, expired: exp ? Date.parse(exp) < Date.now() : null, signed: /BEGIN PGP SIGNED MESSAGE/.test(sec.body) };
    }
    if (nf.status) {
      const leaks = [
        [/Traceback \(most recent call last\)/, "Python traceback"], [/at [\w$.]+ \([^)]*\.(?:js|ts):\d+:\d+\)/, "JavaScript stack trace"], [/Exception in thread|java\.lang\./, "Java exception"],
        [/Fatal error:.*on line \d+|Warning:.*on line \d+/, "PHP error with file path"], [/Microsoft \.NET Framework|ASP\.NET is configured/, ".NET error page"], [/Whitelabel Error Page/, "Spring Boot error page"],
        [/DEBUG = True|Django tried these URL patterns/, "Django debug page"], [/RoutingError|ActionController/, "Rails debug page"], [/<address>(Apache|nginx)\/[\d.]+/i, "server version in error page"],
      ].filter(([re]) => (re as RegExp).test(nf.body)).map(([, n]) => n as string);
      f.notFound = { status: nf.status, leaks, soft404: nf.status === 200 };
    }
    if (oidc.status === 200 && /"issuer"/.test(oidc.body)) {
      try {
        const j = JSON.parse(oidc.body) as { issuer?: string; grant_types_supported?: string[]; code_challenge_methods_supported?: string[] };
        f.oidc = { issuer: j.issuer ?? null, grants: j.grant_types_supported ?? [], pkce: (j.code_challenge_methods_supported ?? []).includes("S256") };
      } catch {
        /* not JSON */
      }
    }
  }
  // Authorized-only checks (00-01): run only for assets the operator owns, and never against third-party networks (00-02).
  const thirdPartyNetwork = !!f.provider && f.provider.kind !== "saas";
  if (meta.authorized && meta.inScope && base && meta.budget()) {
    const origin = `https://${host}`;
    const legacy = await Promise.all((["TLSv1", "TLSv1.1"] as const).map((v) => net.tls(host, { minVersion: v, maxVersion: v, timeoutMs: 6000 })));
    f.legacyTls = { "TLSv1.0": legacy[0].ok, "TLSv1.1": legacy[1].ok };
    const ex = await Promise.all(SENSITIVE_PATHS.map((p) => net.http(origin + p.path, { maxBytes: 8 * 1024, follow: false, timeoutMs: 8000 })));
    // Only the status, size and whether a format signature matched are kept: contents are never stored or shown (00-04).
    f.exposures = ex.map((r, i) => ({ path: SENSITIVE_PATHS[i].path, status: r.status, signature: r.status === 200 && SENSITIVE_PATHS[i].signature.test(r.body) && !/<html/i.test(r.body.slice(0, 400)) ? "matched" : null, bytes: r.body.length }));
    const evil = "https://void-intel-origin-check.invalid";
    const cors = await net.http(origin + "/", { headers: { origin: evil }, maxBytes: 4096 });
    f.cors = { origin: evil, acao: cors.headers["access-control-allow-origin"] ?? null, credentials: /true/i.test(cors.headers["access-control-allow-credentials"] ?? ""), reflected: cors.headers["access-control-allow-origin"] === evil };
    const rp = f.page?.redirectParams[0];
    if (rp) {
      const u = new URL(rp, origin);
      const key = [...u.searchParams.keys()].find((k) => /^(next|url|redirect|redirect_uri|return|returnTo|return_to|continue|dest|destination|goto|target)$/i.test(k));
      if (key) {
        u.searchParams.set(key, "https://example.org/void-intel");
        const r = await net.http(u.href, { follow: false, maxBytes: 4096 });
        const loc = r.headers.location ?? null;
        f.openRedirect = { url: u.href, location: loc, external: !!loc && /^https?:\/\/example\.org/i.test(loc) };
      }
    }
    const target = f.addresses.find((a) => !a.includes(":"));
    if (!thirdPartyNetwork && target && !meta.probedIps?.has(target)) {
      meta.probedIps?.add(target);
      f.ports = await Promise.all(DB_PORTS.map((p) => net.tcp(target, p, { readBanner: [21, 22, 25, 110, 143].includes(p), timeoutMs: 3000 })));
    }
  }
  // Raw bodies were only needed for parsing; the report keeps derived facts, never page contents.
  if (f.https) f.https = { ...f.https, body: "" };
  f.ms = Date.now() - t0;
  return f;
}

async function parsePage(net: IntelNet, html: string, base: URL, host: string, budget: () => boolean): Promise<PageFacts> {
  const $ = cheerio.load(html);
  const abs = (u: string | undefined) => {
    if (!u) return null;
    try {
      return new URL(u, base);
    } catch {
      return null;
    }
  };
  const scripts: ScriptFacts[] = [];
  $("script[src]").each((_, el) => {
    const u = abs($(el).attr("src"));
    if (u) scripts.push({ src: u.href, host: u.hostname, firstParty: sameSite(u.hostname, host), integrity: !!$(el).attr("integrity"), crossorigin: $(el).attr("crossorigin") !== undefined });
  });
  const inline = $("script:not([src])").map((_, el) => $(el).html() ?? "").get();
  const links: string[] = [], external = new Set<string>(), paramLinks: PageFacts["paramLinks"] = [], redirectParams: string[] = [], idRoutes: string[] = [], fileRoutes: string[] = [], searchOrPaging: string[] = [], versionedApi: string[] = [];
  const auth: PageFacts["authLinks"] = { login: [], register: [], reset: [], logout: [], sso: [] };
  $("a[href], link[href], area[href]").each((_, el) => {
    const href = $(el).attr("href");
    const u = abs(href);
    if (!u || !/^https?:$/.test(u.protocol)) return;
    const text = `${$(el).text()} ${u.pathname}`.toLowerCase();
    if (!sameSite(u.hostname, host)) {
      external.add(u.hostname);
      if (/accounts\.google|login\.microsoftonline|auth0|okta|appleid|github\.com\/login\/oauth/.test(u.href)) auth.sso.push(u.href);
      return;
    }
    if (links.length < 400) links.push(u.href);
    if (/\b(log ?in|sign ?in)\b|\/login|\/signin|\/auth\b/.test(text)) auth.login.push(u.href);
    if (/\b(sign ?up|register|create account|join)\b|\/signup|\/register/.test(text)) auth.register.push(u.href);
    if (/forgot|reset|recover/.test(text)) auth.reset.push(u.href);
    if (/log ?out|sign ?out|\/logout/.test(text)) auth.logout.push(u.href);
    const params = [...u.searchParams.keys()];
    if (params.length) paramLinks.push({ url: u.href, params });
    if (params.some((p) => /^(next|url|redirect|redirect_uri|return|returnTo|return_to|continue|dest|destination|goto|target)$/i.test(p))) redirectParams.push(u.href);
    if (/\/\d{2,}(\/|$)|\/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(u.pathname) || params.some((p) => /^(id|uid|user|account|order|doc|file)(_?id)?$/i.test(p))) idRoutes.push(u.href);
    if (/\/(upload|download|export|import|attachments?|files?)\b|\.(pdf|zip|csv|xlsx?|docx?)$/i.test(u.pathname)) fileRoutes.push(u.href);
    if (params.some((p) => /^(q|query|search|page|sort|order|filter|limit|offset)$/i.test(p))) searchOrPaging.push(u.href);
    if (/\/api\/v\d+\//i.test(u.pathname)) versionedApi.push(u.href);
  });
  const forms: PageFacts["forms"] = [];
  $("form").each((_, el) => {
    const f = $(el);
    const action = abs(f.attr("action") ?? base.href)?.href ?? base.href;
    const inputs = f.find("input,select,textarea").map((_, i) => $(i).attr("name") ?? $(i).attr("type") ?? "").get().filter(Boolean).slice(0, 30);
    const hidden = f.find("input[type=hidden]").map((_, i) => $(i).attr("name") ?? "").get().filter(Boolean);
    forms.push({
      action, method: (f.attr("method") ?? "get").toLowerCase(), password: f.find("input[type=password]").length > 0, file: f.find("input[type=file]").length > 0, hidden, inputs,
      csrf: hidden.some((h) => /csrf|xsrf|token|authenticity|nonce|__requestverification/i.test(h)), insecureAction: action.startsWith("http:"),
    });
    if (f.find("input[type=password]").length) auth.login.push(action);
  });
  // First-party scripts are what every visitor's browser downloads; up to 4 are read for client-side signals.
  const firstParty = scripts.filter((s) => s.firstParty).slice(0, 4);
  const bodies = budget() ? await Promise.all(firstParty.map((s) => net.http(s.src, { maxBytes: 1536 * 1024, timeoutMs: 10_000 }))) : [];
  const code = [...inline, ...bodies.map((b) => b.body)];
  const all = code.join("\n");
  const signals: PageFacts["signals"] = {
    storage: ["localStorage", "sessionStorage", "indexedDB"].filter((k) => all.includes(k)),
    postMessage: /\.postMessage\(/.test(all), messageListener: /addEventListener\(\s*["']message["']|onmessage\s*=/.test(all),
    innerHTML: /\.innerHTML\s*=|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write\(/.test(all), eval: /\beval\(|new Function\(/.test(all),
    wasm: /WebAssembly\.(instantiate|compile)|\.wasm["']/.test(all), serviceWorker: /serviceWorker\.register/.test(all),
    websocket: [...new Set([...all.matchAll(/wss?:\/\/[\w.-]+(?::\d+)?[\w/.-]*/g)].map((m) => m[0]))].slice(0, 10),
    graphql: [...new Set([...all.matchAll(/["'`](\/[\w/-]*graphql[\w/-]*)["'`]/gi)].map((m) => m[1]))].slice(0, 10),
    apiCalls: [...new Set([...all.matchAll(/["'`](\/api\/[\w/.{}$-]{1,80})["'`?]/g)].map((m) => m[1]))].slice(0, 40),
    sourceMaps: bodies.map((b, i) => (/\/\/[#@] sourceMappingURL=(\S+)/.exec(b.body.slice(-4000))?.[1] ? `${firstParty[i].src} → ${/\/\/[#@] sourceMappingURL=(\S+)/.exec(b.body.slice(-4000))![1].slice(0, 200)}` : null)).filter((x): x is string => !!x),
  };
  // Credential-like strings in public HTML/JS (15-07 / 06-09): type, location and length only — never the value.
  const secrets: PageFacts["secrets"] = [];
  const scan = (text: string, location: string) => {
    for (const s of detectSecrets(text, { maxFindings: 50 })) {
      if (s.confidence === "low") continue;
      secrets.push({ type: s.type, confidence: s.confidence, location: `${location} @${s.start}`, length: s.length, placeholder: !!s.likelyPlaceholder });
    }
  };
  scan(html.replace(/<script[\s\S]*?<\/script>/gi, ""), base.href);
  inline.forEach((c, i) => scan(c, `${base.href} inline script #${i + 1}`));
  bodies.forEach((b, i) => scan(b.body, firstParty[i].src));
  const thirdParty = [...new Set([...scripts.filter((s) => !s.firstParty).map((s) => s.host), ...$("iframe[src]").map((_, el) => abs($(el).attr("src"))?.hostname ?? "").get()].filter(Boolean))].map((h) => ({ host: h, category: THIRD_PARTY_CATEGORIES.find(([re]) => re.test(h))?.[1] ?? "other" }));
  const frameworks: string[] = [];
  const gen = $('meta[name="generator"]').attr("content") ?? null;
  if (gen) frameworks.push(gen);
  if (/\/_next\//.test(html)) frameworks.push("Next.js");
  if (/__NUXT__|\/_nuxt\//.test(html)) frameworks.push("Nuxt");
  if (/wp-content|wp-includes/.test(html)) frameworks.push("WordPress");
  if (/ng-version=/.test(html)) frameworks.push(`Angular ${/ng-version="([^"]+)"/.exec(html)?.[1] ?? ""}`.trim());
  if (/data-reactroot|react-dom/.test(all)) frameworks.push("React");
  if (/__sveltekit|svelte-/.test(html)) frameworks.push("Svelte");
  if (/Drupal\.settings|drupal\.js/.test(html)) frameworks.push("Drupal");
  if (/cdn\.shopify\.com/.test(html)) frameworks.push("Shopify");
  const spa: string[] = [];
  if ($("#root,#app,#__next,#__nuxt,[data-reactroot]").length && $("body").text().trim().length < 400) spa.push("client-rendered shell");
  if (/history\.pushState|createBrowserRouter|vue-router|react-router/.test(all)) spa.push("client-side router");
  return {
    title: $("title").first().text().trim().slice(0, 200) || null, generator: gen, lang: $("html").attr("lang") ?? null, bytes: html.length,
    forms, scripts, inlineScripts: inline.length, iframes: $("iframe[src]").map((_, el) => abs($(el).attr("src"))?.href ?? "").get().filter(Boolean).slice(0, 20),
    links, externalHosts: [...external].sort().slice(0, 120), manifest: abs($('link[rel="manifest"]').attr("href"))?.href ?? null, spa, frameworks,
    authLinks: Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, [...new Set(v)].slice(0, 10)])) as PageFacts["authLinks"],
    paramLinks: paramLinks.slice(0, 40), redirectParams: [...new Set(redirectParams)].slice(0, 10), idRoutes: [...new Set(idRoutes)].slice(0, 20), fileRoutes: [...new Set(fileRoutes)].slice(0, 20),
    searchOrPaging: [...new Set(searchOrPaging)].slice(0, 10), versionedApi: [...new Set(versionedApi)].slice(0, 10),
    mixedContent: base.protocol === "https:" ? [...html.matchAll(/(?:src|href|action)=["'](http:\/\/[^"']+)/gi)].map((m) => m[1]).filter((u) => !/^http:\/\/(www\.)?w3\.org/.test(u)).slice(0, 10) : [],
    emails: (html.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).length, signals, secrets, thirdParty,
  };
}
