/**
 * Seeds a Postgres corpus and load-tests /api/v2/search.
 *   DATABASE_URL=postgres://… npx tsx scripts/bench-search.ts [resources] [connections] [seconds]
 * Prints throughput and latency percentiles; numbers depend entirely on the hardware it runs on.
 */
import autocannon from "autocannon";
import { PgCorpus } from "../src/corpus/pg-store.js";
import { analyzeResponse } from "../src/metadata/pipeline.js";
import { buildApp } from "../src/api.js";
import { loadConfig } from "../src/core/config.js";
import { response, HTML_RICH, CSV } from "../tests/fixtures/build.js";

const N = Number(process.argv[2] ?? 20_000);
const CONNS = Number(process.argv[3] ?? 64);
const SECS = Number(process.argv[4] ?? 20);
const url = process.env.DATABASE_URL!;
const WORDS = "snowfall rainfall temperature glacier river basin station survey census population health clinic school budget transport energy solar wind ocean coral forest soil crop yield migration language museum archive photograph video lecture model benchmark dataset report".split(" ");
const PLACES = "northern india;himalaya;kenya;brazil;norway;canada;japan;australia;peru;nepal;ladakh;alaska;sahel;andes;mongolia".split(";");

const store = await PgCorpus.connect(url, { max: 20 });
const existing = Number((await store.pool.query("SELECT COUNT(*) n FROM corpus_docs")).rows[0].n);
if (existing < N) {
  const html = await analyzeResponse(response(HTML_RICH, { "content-type": "text/html" }, "https://bench.test/x"), { sourceType: "url", enrich: false });
  const csv = await analyzeResponse(response(CSV, { "content-type": "text/csv" }, "https://bench.test/x.csv"), { sourceType: "url", enrich: false });
  const t0 = Date.now();
  for (let i = existing; i < N; i += 500) {
    const batch = Array.from({ length: Math.min(500, N - i) }, (_, j) => i + j);
    await store.enqueue(batch.map((k) => ({ url: `https://host${k % 997}.bench.test/r/${k}`, priority: 1, depth: 0, via: "bench", purpose: "discovery" as const })));
    await Promise.all(batch.map(async (k) => {
      const r = (await store.byUrl(`https://host${k % 997}.bench.test/r/${k}`))!;
      const base = k % 3 === 0 ? csv : html;
      const w = [WORDS[k % WORDS.length], WORDS[(k * 7) % WORDS.length], WORDS[(k * 13) % WORDS.length]];
      const rec = { ...base, title: `${w[0]} ${w[1]} dataset — ${PLACES[k % PLACES.length]}`, description: `Observations of ${w.join(", ")} in ${PLACES[(k * 3) % PLACES.length]}.`, finalUrl: r.url };
      await store.saveSnapshot(r.id, rec, { text: `${rec.description} ${w.join(" ")} measurements ${PLACES[k % PLACES.length]}`.repeat(20), index: true });
      await store.finish(r.id, "indexed", Date.now() + 86400_000, { kind: base.kind, title: rec.title, indexed_at: new Date().toISOString() });
    }));
    process.stdout.write(`\rseeded ${Math.min(i + 500, N)}/${N}`);
  }
  console.log(`\nseeding took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
await store.pool.query("ANALYZE");
// Rate limits must be lifted before the app is built (limiters read settings at startup).
process.env.RATE_LIMIT_PER_MIN = "100000000";
const app = await buildApp(loadConfig(), { logger: false, corpus: store, crawler: false, legacy: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const queries = Array.from({ length: 400 }, (_, i) => `${WORDS[i % WORDS.length]} ${WORDS[(i * 5) % WORDS.length]} ${PLACES[i % PLACES.length]}`);
for (const [label, distinct] of [["distinct questions (cache mostly cold)", queries.length], ["popular questions (20 hot queries)", 20]] as const) {
  const res = await autocannon({
    url: `http://127.0.0.1:${port}`,
    connections: CONNS,
    duration: SECS,
    requests: Array.from({ length: distinct }, (_, i) => ({ method: "GET", path: `/api/v2/search?q=${encodeURIComponent(queries[i])}&limit=10` })),
  });
  console.log(`\n${label}: ${res.requests.average.toFixed(0)} req/s avg, latency p50 ${res.latency.p50} ms, p97.5 ${res.latency.p97_5} ms, p99 ${res.latency.p99} ms, errors ${res.errors}, non-2xx ${res.non2xx}, timeouts ${res.timeouts}`);
}
await app.close();
await store.close();
