import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "undici";
import { __testing } from "../src/net/safe-fetch.js";
import { liveNet } from "../src/domain-intel/net.js";
import { PageCrawler } from "../src/domain-intel/pages.js";

let server: Server;
let root: string;
let dispatcher: Agent;
const calls: string[] = [];
const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });

beforeAll(async () => {
  server = createServer((req, res) => {
    calls.push(req.url ?? "");
    const u = new URL(req.url ?? "/", root);
    if (u.pathname === "/") {
      return res.writeHead(200, { "content-type": "text/html" }).end(
        '<a href="/nested">nested</a><a href="/redirect?next=/">redirect</a>' +
        '<a href="/fixed?next=/">fixed redirect</a><a href="/artifact">artifact</a>' +
        '<a href="/fake-key">fake key</a><a href="/api/me">API</a>' +
        '<a href="/sign-out">logout</a><a href="/verify?code=fixture">verify</a>',
      );
    }
    if (u.pathname === "/nested") return res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'" })
      .end('<title>Nested fixture</title><form action="/account" method="post"><input name="a" type="password"></form>');
    if (u.pathname === "/redirect") return res.writeHead(302, { location: u.searchParams.get("next") ?? "/" }).end();
    if (u.pathname === "/fixed") return res.writeHead(302, { location: "https://outside.invalid/" }).end();
    if (u.pathname === "/artifact") return res.writeHead(200, { "content-type": "text/plain" }).end(pem);
    if (u.pathname === "/fake-key") return res.writeHead(200, { "content-type": "text/plain" })
      .end("-----BEGIN PRIVATE KEY-----\nZmFrZS1maXh0dXJlLWtleQ==\n-----END PRIVATE KEY-----");
    if (u.pathname === "/api/me") return res.writeHead(200, {
      "content-type": "application/json",
      ...(req.headers.origin ? { "access-control-allow-origin": req.headers.origin, "access-control-allow-credentials": "true" } : {}),
    }).end('{"public":true}');
    return res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  root = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  __testing.allowLoopback = true;
  dispatcher = new Agent();
  __testing.dispatcher = dispatcher;
});

afterAll(async () => {
  __testing.allowLoopback = false;
  __testing.dispatcher = null;
  await dispatcher.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("live evidence validation against an isolated HTTP server", () => {
  it("uses the shared page analyzer and proves only reproducible anonymous behavior", async () => {
    const crawler = new PageCrawler(liveNet, host => host === "127.0.0.1", () => {}, Date.now, true);
    crawler.enqueue(root + "/", null, "fixture");
    await crawler.wave(15000);
    expect(crawler.frontier).toBe(0);
    const page = (path: string) => crawler.records.find(record => new URL(record.url).pathname === path)!;
    expect(page("/nested").web).toMatchObject({
      headers: { "content-security-policy": true },
      page: { title: "Nested fixture", forms: [{ method: "post", password: true }] },
    });
    const redirect = page("/redirect").validation![0];
    expect(redirect).toMatchObject({ check: "open-redirect", state: "confirmed", control: { status: 302 } });
    expect(new Set(redirect.trials.map(trial => trial.input)).size).toBe(2);
    expect(page("/fixed").validation).toMatchObject([{ check: "open-redirect", state: "not-reproduced" }]);
    const key = page("/artifact").validation![0];
    expect(key).toMatchObject({ check: "public-private-key", state: "confirmed" });
    expect(key.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(key)).not.toContain("BEGIN PRIVATE KEY");
    expect(page("/fake-key").validation).toEqual([]);
    expect(page("/api/me").validation).toMatchObject([{ check: "cors", state: "observed" }]);
    expect(calls.filter(url => url === "/artifact")).toHaveLength(2);
    expect(calls.some(url => /sign-out|verify|account/.test(url))).toBe(false);
  });
  it("runs no proof requests when validation is disabled", async () => {
    calls.length = 0;
    const crawler = new PageCrawler(liveNet, host => host === "127.0.0.1", () => {});
    crawler.enqueue(root + "/artifact", null, "fixture");
    await crawler.wave(10000);
    expect(calls).toEqual(["/artifact"]);
    expect(crawler.records[0].validation).toBeUndefined();
  });
});
