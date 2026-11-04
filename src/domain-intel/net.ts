import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { safeFetch, resolvePublic, type SafeResponse } from "../net/safe-fetch.js";
import { isPublicAddress } from "../net/ip-guard.js";

/**
 * Network adapter for domain intelligence. Every call is a normal public request (DNS over HTTPS,
 * RDAP, certificate transparency, an HTTP GET, a TLS handshake). Addresses are checked with the same
 * egress guard the crawler uses, so a target that resolves to a private, loopback or metadata address
 * is never contacted. Tests substitute a fixture implementation of this interface.
 */
export interface DnsAnswer { name: string; type: number; TTL?: number; data: string }
export interface DnsResult { status: number; ad: boolean; answers: DnsAnswer[]; error?: string }
export interface HttpResult {
  url: string; finalUrl: string; status: number; headers: Record<string, string>; body: string; truncated: boolean;
  redirects: Array<{ url: string; status: number; location: string }>; remoteAddress: string | null; ms: number; error?: string;
}
export interface TlsResult {
  host: string; port: number; ok: boolean; error?: string; protocol?: string | null; cipher?: string | null; alpn?: string | null;
  authorized?: boolean; authorizationError?: string | null;
  cert?: { subject: string; issuer: string; validFrom: string; validTo: string; san: string[]; serial: string; fingerprint256: string; bits?: number; selfSigned: boolean; chainDepth: number };
}
export interface TcpResult { host: string; port: number; open: boolean; banner?: string; error?: string; ms: number }
export interface IntelNet {
  dns(name: string, type: string): Promise<DnsResult>;
  http(url: string, opts?: { method?: "GET" | "HEAD"; maxBytes?: number; headers?: Record<string, string>; follow?: boolean; timeoutMs?: number }): Promise<HttpResult>;
  json<T>(url: string, timeoutMs?: number): Promise<T | null>;
  tls(host: string, opts?: { port?: number; minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3"; maxVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3"; timeoutMs?: number }): Promise<TlsResult>;
  tcp(host: string, port: number, opts?: { readBanner?: boolean; send?: string; timeoutMs?: number }): Promise<TcpResult>;
}

const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE_NUM: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, DS: 43, RRSIG: 46, DNSKEY: 48, SVCB: 64, HTTPS: 65, CAA: 257 };
export const dnsTypeNumber = (t: string) => TYPE_NUM[t] ?? 0;

function fmtName(o: Record<string, string | string[]> | undefined): string {
  if (!o) return "";
  return Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : v}`).join(", ");
}

/** Public address for a hostname, or throws (private/loopback/link-local answers are refused). */
async function publicAddress(host: string): Promise<string> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (!isPublicAddress(host)) throw new Error("EGRESS_BLOCKED: non-public address");
    return host;
  }
  return resolvePublic(host);
}

export const liveNet: IntelNet = {
  async dns(name, type) {
    try {
      const res = await safeFetch(`${DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}&do=1`, { accept: "application/dns-json", timeoutMs: 8000, maxBytes: 512 * 1024 });
      const j = JSON.parse(res.body.toString("utf8")) as { Status: number; AD?: boolean; Answer?: DnsAnswer[] };
      return { status: j.Status, ad: !!j.AD, answers: j.Answer ?? [] };
    } catch (e) {
      return { status: -1, ad: false, answers: [], error: (e as Error).message.slice(0, 200) };
    }
  },
  async http(url, opts = {}) {
    const t0 = Date.now();
    try {
      const res: SafeResponse = await safeFetch(url, {
        method: opts.method ?? "GET", maxBytes: opts.maxBytes ?? 768 * 1024, timeoutMs: opts.timeoutMs ?? 12_000,
        maxRedirects: opts.follow === false ? 0 : 6, headers: opts.headers,
        userAgent: "VoidDomainIntel/1.0 (+https://github.com/shep95/web-crawlers; passive public observation)",
      });
      return { url, finalUrl: res.finalUrl, status: res.status, headers: res.headers, body: res.body.toString("utf8"), truncated: res.truncated, redirects: res.redirects, remoteAddress: res.remoteAddress, ms: Date.now() - t0 };
    } catch (e) {
      return { url, finalUrl: url, status: 0, headers: {}, body: "", truncated: false, redirects: [], remoteAddress: null, ms: Date.now() - t0, error: (e as Error).message.slice(0, 200) };
    }
  },
  async json(url, timeoutMs = 12_000) {
    const r = await this.http(url, { timeoutMs, maxBytes: 4 * 1024 * 1024, headers: { accept: "application/json, application/rdap+json" } });
    if (r.status < 200 || r.status >= 300) return null;
    try {
      return JSON.parse(r.body);
    } catch {
      return null;
    }
  },
  async tls(host, opts = {}) {
    const port = opts.port ?? 443;
    let address: string;
    try {
      address = await publicAddress(host);
    } catch (e) {
      return { host, port, ok: false, error: (e as Error).message.slice(0, 200) };
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: TlsResult, s?: TLSSocket) => {
        if (done) return;
        done = true;
        s?.destroy();
        resolve(r);
      };
      const socket = tlsConnect({ host: address, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ["h2", "http/1.1"], minVersion: opts.minVersion, maxVersion: opts.maxVersion, timeout: opts.timeoutMs ?? 8000 });
      socket.once("secureConnect", () => {
        const c = socket.getPeerCertificate(true) as PeerCertificate & { issuerCertificate?: PeerCertificate; bits?: number };
        let depth = 0;
        for (let x: (PeerCertificate & { issuerCertificate?: PeerCertificate }) | undefined = c; x && depth < 10; x = x.issuerCertificate === x ? undefined : x.issuerCertificate) depth++;
        const subject = fmtName(c.subject as unknown as Record<string, string>), issuer = fmtName(c.issuer as unknown as Record<string, string>);
        finish({
          host, port, ok: true, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name ?? null, alpn: socket.alpnProtocol || null,
          authorized: socket.authorized, authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          cert: c && c.valid_to ? {
            subject, issuer, validFrom: new Date(c.valid_from).toISOString(), validTo: new Date(c.valid_to).toISOString(),
            san: (c.subjectaltname ?? "").split(/,\s*/).filter(Boolean).map((s) => s.replace(/^DNS:/, "")), serial: c.serialNumber,
            fingerprint256: c.fingerprint256, bits: c.bits, selfSigned: subject === issuer, chainDepth: depth,
          } : undefined,
        }, socket);
      });
      socket.once("timeout", () => finish({ host, port, ok: false, error: "timeout" }, socket));
      socket.once("error", (e) => finish({ host, port, ok: false, error: e.message.slice(0, 200) }, socket));
    });
  },
  async tcp(host, port, opts = {}) {
    const t0 = Date.now();
    let address: string;
    try {
      address = await publicAddress(host);
    } catch (e) {
      return { host, port, open: false, error: (e as Error).message.slice(0, 200), ms: 0 };
    }
    return new Promise((resolve) => {
      const s = new Socket();
      let banner = "", settled = false;
      const end = (r: Omit<TcpResult, "ms">) => {
        if (settled) return;
        settled = true;
        s.destroy();
        resolve({ ...r, ms: Date.now() - t0 });
      };
      s.setTimeout(opts.timeoutMs ?? 4000);
      s.once("connect", () => {
        if (opts.send) s.write(opts.send);
        if (!opts.readBanner && !opts.send) end({ host, port, open: true });
      });
      s.on("data", (d) => {
        banner += d.toString("latin1");
        if (banner.length > 512 || /\r?\n$/.test(banner)) end({ host, port, open: true, banner: banner.slice(0, 512).replace(/[^\x20-\x7e\r\n]/g, "·").trim() });
      });
      s.once("timeout", () => end(banner ? { host, port, open: true, banner: banner.slice(0, 512).trim() } : { host, port, open: s.readyState === "open", error: "timeout" }));
      s.once("error", (e) => end({ host, port, open: false, error: (e as NodeJS.ErrnoException).code ?? e.message }));
      s.connect(port, address);
    });
  },
};
