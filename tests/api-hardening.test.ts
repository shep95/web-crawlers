import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api.js";
import { loadConfig } from "../src/core/config.js";

// Regressions for findings from the domain-intelligence run on Void's own crawler API.
describe("API hardening (own-deployment findings)", () => {
  let app: FastifyInstance;
  const prev = process.env.CORS_ORIGIN;
  beforeAll(async () => {
    process.env.CORS_ORIGIN = "*";
    app = await buildApp(loadConfig(), { logger: false, legacy: false, corpusPath: ":memory:", crawler: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    process.env.CORS_ORIGIN = prev;
  });
  it("public CORS is a literal * — the caller's Origin is never reflected", async () => {
    const r = await app.inject({ url: "/api/v2/geography/FR", headers: { origin: "https://evil.example" } });
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
  });
  it("serves an RFC 9116 security.txt with Contact and an Expires within a year", async () => {
    const r = await app.inject({ url: "/.well-known/security.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/^Contact: https:\/\//m);
    const exp = Date.parse(/^Expires: (.+)$/m.exec(r.body)![1]);
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp - Date.now()).toBeLessThan(366 * 86_400_000);
  });
  it("unknown file-like and .well-known paths are real 404s, not the app shell", async () => {
    for (const u of ["/.well-known/void-intel-x", "/wp-login.php", "/backup.zip"]) {
      const r = await app.inject({ url: u, headers: { accept: "text/html" } });
      expect(r.statusCode, u).toBe(404);
    }
  });
});
