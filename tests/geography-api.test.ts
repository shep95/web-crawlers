import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.js";
import { loadConfig } from "../src/core/config.js";

describe("geography API", async () => {
  const app = await buildApp(loadConfig(), { logger: false, legacy: false, corpusPath: ":memory:", crawler: false });
  afterAll(() => app.close());

  it("lists the registry with counts, and searches any name or alias", async () => {
    const all = (await app.inject("/api/v2/geography")).json();
    expect(all.summary.iso3166_1.assigned).toBe(249);
    expect(all.entries).toHaveLength(249);
    expect(all.entries.find((e: { code: string }) => e.code === "VA")).toMatchObject({ unStatus: "observer_state", type: "sovereign_state" });
    expect(all.nonIso.map((n: { code: string }) => n.code)).toEqual(expect.arrayContaining(["XK", "EU", "UK", "EL"]));
    expect(all.integrity.problems).toEqual([]);
    const q = (await app.inject(`/api/v2/geography?q=${encodeURIComponent("Россия")}`)).json();
    expect(q.matches[0]).toMatchObject({ layer: "iso", code: "RU" });
    expect((await app.inject("/api/v2/geography?q=" + "x".repeat(200))).statusCode).toBe(400);
  });

  it("returns one entry with its subdivisions, non-ISO entries and ISO 3166-2 codes", async () => {
    const ind = (await app.inject("/api/v2/geography/IND")).json();
    expect(ind).toMatchObject({ layer: "iso3166-1", entry: { alpha2: "IN", isoName: "India" } });
    expect(ind.subdivisions.length).toBeGreaterThan(30);
    const xk = (await app.inject("/api/v2/geography/xk")).json();
    expect(xk).toMatchObject({ layer: "non-iso", entry: { code: "XK", kind: "user_assigned_code" } });
    const uk = (await app.inject("/api/v2/geography/UK")).json();
    expect(uk.aliasOf.entry.alpha2).toBe("GB");
    expect((await app.inject("/api/v2/geography/US-GA")).json()).toMatchObject({ layer: "iso3166-2", subdivision: { name: "Georgia" }, country: { code: "US" } });
    expect((await app.inject("/api/v2/geography/ZZ")).statusCode).toBe(404);
    expect(Object.keys((await app.inject("/api/v2/openapi.json")).json().paths)).toEqual(expect.arrayContaining(["/api/v2/geography", "/api/v2/geography/{code}"]));
  });
});
