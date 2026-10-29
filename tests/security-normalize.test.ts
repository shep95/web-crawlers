import { describe, expect, it } from "vitest";
import { checkUrl, isPublicAddress } from "../src/net/ip-guard.js";
import { FetchBlockedError, safeFetch } from "../src/net/safe-fetch.js";
import { findIdentifiers, isbnValid, normalizeDate, orcidValid, personalDataIndicators, sniffKind } from "../src/metadata/normalize.js";
import { canonicalizeUrl } from "../src/crawl/site-crawler.js";
import { listZipEntries, readZipEntry } from "../src/metadata/zip.js";
import { zip } from "./fixtures/build.js";

describe("egress guard (SSRF)", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd12:3456::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "::ffff:169.254.169.254", "2001:db8::1",
  ])("blocks non-public %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1", "100.128.0.1"])("allows public %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each([
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["gopher://x.test/", "scheme_not_allowed"],
    ["http://user:pw@example.com/", "credentials_in_url"],
    ["http://localhost/", "internal_hostname"],
    ["http://api.railway.internal/", "internal_hostname"],
    ["http://printer.local/", "internal_hostname"],
    ["http://intranet/", "single_label_hostname"],
    ["http://[::1]/", "non_public_ip"],
    ["http://2130706433/", "non_public_ip"],
    ["http://0x7f.1/", "non_public_ip"],
    ["http://169.254.169.254/latest/meta-data/", "non_public_ip"],
    ["http://example.com:22/", "port_not_allowed"],
  ])("rejects %s (%s)", (url, reason) => {
    const r = checkUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it("accepts ordinary public URLs", () => {
    expect(checkUrl("https://example.com/path?q=1").ok).toBe(true);
    expect(checkUrl("http://example.com:8080/").ok).toBe(true);
  });
  it("safeFetch refuses blocked targets before any connection", async () => {
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(safeFetch("http://localhost:8080/admin")).rejects.toBeInstanceOf(FetchBlockedError);
  });
});

describe("normalisation", () => {
  it.each([
    ["D:20230115123000+01'00'", "2023-01-15T11:30:00.000Z"],
    ["D:20230115", "2023-01-15T00:00:00.000Z"],
    ["2021:06:30 14:22:01", "2021-06-30T14:22:01.000Z"],
    ["20240102030405", "2024-01-02T03:04:05.000Z"],
    ["2024-05-01", "2024-05-01T00:00:00.000Z"],
    ["Tue, 01 Apr 2025 10:00:00 GMT", "2025-04-01T10:00:00.000Z"],
    ["2025-03-14T09:00:00+02:00", "2025-03-14T07:00:00.000Z"],
  ])("normalizeDate(%s)", (raw, iso) => {
    expect(normalizeDate(raw)).toEqual({ iso, original: raw });
  });
  it("rejects nonsense dates", () => {
    expect(normalizeDate("not a date")).toBeNull();
    expect(normalizeDate("0001-01-01")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });
  it("validates identifier checksums", () => {
    expect(isbnValid("9780306406157")).toBe(true);
    expect(isbnValid("9780306406158")).toBe(false);
    expect(isbnValid("0306406152")).toBe(true);
    expect(orcidValid("0000-0002-1825-0097")).toBe(true);
    expect(orcidValid("0000-0002-1825-0098")).toBe(false);
    const ids = findIdentifiers("see https://doi.org/10.1000/xyz123. ISBN 978-0-306-40615-8 (bad) and ISSN 0378-5955");
    expect(ids.doi).toEqual(["10.1000/xyz123"]);
    expect(ids.isbn).toEqual([]);
    expect(ids.issn).toEqual(["0378-5955"]);
  });
  it("counts PII without exposing values; Luhn-filters card numbers", () => {
    const r = personalDataIndicators("a@b.com, c@d.org, 4111 1111 1111 1111, 1234 5678 9012 3456, 123-45-6789");
    expect(r).toMatchObject({ emails: 2, paymentCardLike: 1, ssnLike: 1 });
    expect(r.emailDomains).toEqual(["b.com", "d.org"]);
  });
  it("sniffs kinds by magic bytes over declared types", () => {
    expect(sniffKind(Buffer.from("%PDF-1.4"), "text/html", "x").kind).toBe("pdf");
    expect(sniffKind(Buffer.from("<!doctype html><html>"), null, "x").kind).toBe("webpage");
    expect(sniffKind(Buffer.from('{"a":1}'), null, "x").kind).toBe("json");
    expect(sniffKind(Buffer.from("<rss version='2.0'><channel>"), "text/xml", "x").kind).toBe("feed");
    expect(sniffKind(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]), null, "x").kind).toBe("video");
    expect(sniffKind(Buffer.from([0, 1, 2, 3, 0, 0, 0, 0, 0xff, 0xfe, 0x00, 0x01]), null, "x").kind).toBe("binary");
  });
  it("canonicalizes crawl URLs", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM:443/a/?utm_source=x&b=2&a=1#frag")).toBe("https://example.com/a?a=1&b=2");
    expect(canonicalizeUrl("mailto:x@y.z")).toBeNull();
  });
  it("zip reader caps inflation regardless of declared size", () => {
    const z = zip({ "big.txt": Buffer.alloc(10 * 1024 * 1024, 65) }, { "big.txt": 10 });
    const [e] = listZipEntries(z);
    expect(e.uncompressedSize).toBe(10);
    expect(() => readZipEntry(z, e, 1024 * 1024)).toThrow(/buffer|length|Cannot create a Buffer|larger/i);
  });
});
