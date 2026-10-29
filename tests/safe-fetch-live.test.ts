import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "undici";
import { __testing, safeFetch } from "../src/net/safe-fetch.js";

// Exercises the real safeFetch stream handling (redirects, caps, gzip) — the code path
// that crashed the first Railway deploy via an unhandled 'error' on a destroyed body.
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/r1") return res.writeHead(302, { location: "/r2" }), res.end("x".repeat(50_000));
    if (req.url === "/r2") return res.writeHead(301, { location: "/final" }), res.end();
    if (req.url === "/final") return res.writeHead(200, { "content-type": "text/plain" }), res.end("ok");
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let n = 0;
      const pump = () => { while (n++ < 400 && res.write(chunk)); if (n < 400) res.once("drain", pump); else res.end(); };
      return pump();
    }
    if (req.url === "/gz") return res.writeHead(200, { "content-encoding": "gzip" }), res.end(gzipSync(Buffer.alloc(5_000_000, 65)));
    if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }), res.end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __testing.allowLoopback = true;
  __testing.dispatcher = new Agent();
});
afterAll(async () => {
  __testing.allowLoopback = false;
  __testing.dispatcher = null;
  await new Promise<void>((r) => server.close(() => r()));
});

describe("safeFetch stream safety", () => {
  it("follows redirect chains without crashing on discarded bodies", async () => {
    let uncaught: unknown = null;
    const h = (e: unknown) => (uncaught = e);
    process.on("uncaughtException", h);
    const r = await safeFetch(`${base}/r1`);
    await new Promise((res) => setTimeout(res, 50));
    process.off("uncaughtException", h);
    expect(uncaught).toBeNull();
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("ok");
    expect(r.redirects.map((x) => x.status)).toEqual([302, 301]);
  });
  it("truncates at the byte cap without crashing", async () => {
    const r = await safeFetch(`${base}/big`, { maxBytes: 100_000 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(100_000);
  });
  it("caps decompressed output (gzip bomb)", async () => {
    const r = await safeFetch(`${base}/gz`, { maxBytes: 1_000_000 });
    expect(r.body.length).toBe(1_000_000);
    expect(r.truncated).toBe(true);
  });
  it("stops redirect loops", async () => {
    await expect(safeFetch(`${base}/loop`, { maxRedirects: 3 })).rejects.toThrow(/too_many_redirects/);
  });
});
