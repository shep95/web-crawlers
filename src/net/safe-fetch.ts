import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable, Transform } from "node:stream";
import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { checkUrl, isPublicAddress } from "./ip-guard.js";

const noop = () => undefined;

export const DEFAULT_USER_AGENT =
  "OmnispiderMetadataBot/2.0 (+https://github.com/shep95/web-crawlers; respects robots.txt)";

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface SafeResponse {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** True when the body was cut at maxBytes. */
  truncated: boolean;
  /** Wire bytes before decompression (when known). */
  encodedBytes: number;
  redirects: RedirectHop[];
  remoteAddress: string | null;
  timings: { startedAt: string; ttfbMs: number; totalMs: number };
  egress: "direct" | "proxy";
}

export class FetchBlockedError extends Error {
  constructor(
    public reason: string,
    public url: string,
  ) {
    super(`EGRESS_BLOCKED: ${reason} (${url})`);
  }
}

/** Last public address each hostname resolved to (network metadata; bounded). */
const resolvedHosts = new Map<string, string>();
function rememberResolution(host: string, address: string): void {
  if (resolvedHosts.size > 5000) resolvedHosts.delete(resolvedHosts.keys().next().value!);
  resolvedHosts.set(host, address);
}

/**
 * DNS lookup that refuses non-public answers. Because undici connects to the
 * address returned here, this also defeats DNS rebinding between check and use.
 */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | number,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const opts = typeof options === "number" ? { family: options } : options ?? {};
  dnsLookup(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || bad) {
      const e = new Error(`EGRESS_BLOCKED: ${hostname} resolves to non-public address ${bad?.address ?? "none"}`) as NodeJS.ErrnoException;
      e.code = "EGRESS_BLOCKED";
      return callback(e, "", 0);
    }
    rememberResolution(hostname, list[0].address);
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

let dispatcher: Dispatcher | null = null;
let egressMode: "direct" | "proxy" = "direct";

/**
 * Direct egress uses a pinned, guarded resolver. When an outbound proxy is
 * mandated by the environment (HTTPS_PROXY, e.g. dev sandboxes), DNS happens at
 * the proxy, so only the static URL checks apply — never the case on Railway.
 */
export function getDispatcher(): Dispatcher {
  if (dispatcher) return dispatcher;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy && process.env.OMNISPIDER_IGNORE_PROXY !== "1") {
    egressMode = "proxy";
    dispatcher = new ProxyAgent({ uri: proxy, connections: 64 });
  } else {
    egressMode = "direct";
    dispatcher = new Agent({
      connections: 64,
      keepAliveTimeout: 10_000,
      connect: { lookup: guardedLookup as never, timeout: 10_000 },
    });
  }
  return dispatcher;
}

export function getEgressMode(): "direct" | "proxy" {
  getDispatcher();
  return egressMode;
}

function decoderFor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

async function readCapped(
  stream: Readable,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean; bytes: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } finally {
    // Destroying an undici body emits 'error' (RequestAbortedError); a listener must exist
    // or Node treats it as an unhandled stream error and terminates the process.
    stream.on("error", noop);
    stream.destroy();
  }
  return { body: Buffer.concat(chunks), truncated, bytes: size };
}

function headerRecord(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/**
 * Fetch a public URL with SSRF protection on every hop, manual redirect
 * handling, a wall-clock timeout, and decompression-bomb-safe byte caps.
 */
/**
 * Test-only escape hatch so integration tests can exercise the real fetch path
 * against a loopback server. Never set from configuration or request input.
 */
export const __testing = { allowLoopback: false, dispatcher: null as Dispatcher | null };

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 6;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const redirects: RedirectHop[] = [];
  const disp = __testing.dispatcher ?? getDispatcher();

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = __testing.allowLoopback && /^http:\/\/127\.0\.0\.1:/.test(current) ? ({ ok: true, url: new URL(current) } as const) : checkUrl(current);
    if (!check.ok) throw new FetchBlockedError(check.reason, current);
    const res = await request(check.url, {
      method: opts.method ?? "GET",
      dispatcher: disp,
      signal,
      maxRedirections: 0,
      headers: {
        "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT,
        accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en;q=0.9,*;q=0.5",
        ...opts.headers,
      },
    });
    const ttfbMs = Date.now() - started;
    const headers = headerRecord(res.headers as Record<string, string | string[]>);
    // Swallow the abort error that destroy() emits on purpose (see readCapped).
    res.body.on("error", noop);
    if (res.statusCode >= 300 && res.statusCode < 400 && headers.location) {
      res.body.destroy();
      const next = new URL(headers.location, current).toString();
      redirects.push({ url: current, status: res.statusCode, location: next });
      current = next;
      continue;
    }

    const decoder = opts.method === "HEAD" ? null : decoderFor(headers["content-encoding"]);
    let encodedBytes = 0;
    res.body.on("data", (c: Buffer) => {
      encodedBytes += c.length;
    });
    const source: Readable = decoder ? (res.body.pipe(decoder) as unknown as Readable) : (res.body as unknown as Readable);
    if (decoder) res.body.on("error", (e) => decoder.destroy(e));
    let read: { body: Buffer; truncated: boolean; bytes: number };
    try {
      read = await readCapped(source, maxBytes);
    } catch (err) {
      // Corrupt compressed stream: report as empty body rather than crashing the pipeline.
      if ((err as NodeJS.ErrnoException).code?.startsWith("Z_")) read = { body: Buffer.alloc(0), truncated: false, bytes: 0 };
      else throw err;
    } finally {
      res.body.destroy();
    }
    const host = new URL(current).hostname;
    return {
      requestedUrl: rawUrl,
      finalUrl: current,
      status: res.statusCode,
      headers,
      body: read.body,
      truncated: read.truncated,
      encodedBytes,
      redirects,
      remoteAddress: resolvedHosts.get(host) ?? null,
      timings: { startedAt, ttfbMs, totalMs: Date.now() - started },
      egress: egressMode,
    };
  }
  throw new FetchBlockedError("too_many_redirects", rawUrl);
}

/** Convenience JSON GET for public APIs (search federation). */
export async function safeFetchJson<T>(url: string, opts: SafeFetchOptions = {}): Promise<T> {
  const res = await safeFetch(url, { accept: "application/json", maxBytes: 5 * 1024 * 1024, ...opts });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return JSON.parse(res.body.toString("utf8")) as T;
}

export async function safeFetchText(url: string, opts: SafeFetchOptions = {}): Promise<string> {
  const res = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, ...opts });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.body.toString("utf8");
}

/** Resolve a hostname, failing unless every answer is a public address. */
export function resolvePublic(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    guardedLookup(hostname, { all: false }, (err, address) => (err ? reject(err) : resolve(address as string)));
  });
}
