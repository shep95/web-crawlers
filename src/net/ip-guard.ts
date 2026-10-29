import { BlockList, isIP } from "node:net";

/**
 * Egress guard for crawler traffic. Every address a crawl request connects to
 * (after DNS resolution, on every redirect hop) must pass `isPublicAddress`.
 */
const blocked = new BlockList();
const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT (Railway / cloud internal ranges live here)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const V6_BLOCKS: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local (Railway private networking uses fd12::/16)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];
for (const [net, prefix] of V4_BLOCKS) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6_BLOCKS) blocked.addSubnet(net, prefix, "ipv6");

/** Extract an embedded IPv4 from IPv4-mapped / NAT64 / 6to4-compatible IPv6 forms. */
function embeddedV4(addr: string): string | null {
  const lower = addr.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::ffff:0:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicAddress(address: string): boolean {
  const addr = address.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(addr);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(addr, "ipv4");
  const v4 = embeddedV4(addr);
  if (v4) return isIP(v4) === 4 && !blocked.check(v4, "ipv4");
  return !blocked.check(addr, "ipv6");
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Static (pre-DNS) URL validation: scheme, credentials, port, internal hostnames, literal IPs. */
export function checkUrl(raw: string, allowedSchemes = ["http", "https"]): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  const scheme = url.protocol.replace(":", "");
  if (!allowedSchemes.includes(scheme)) return { ok: false, reason: "scheme_not_allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "missing_host" };
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "internal_hostname" };
  }
  if (!host.includes(".") && isIP(host.replace(/^\[|\]$/g, "")) === 0) {
    return { ok: false, reason: "single_label_hostname" };
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !isPublicAddress(literal)) return { ok: false, reason: "non_public_ip" };
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) {
    return { ok: false, reason: "port_not_allowed" };
  }
  return { ok: true, url };
}
