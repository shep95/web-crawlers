# Repository audit & completion ledger

_Audit date: 2026-10-29. Scope: the whole repository at commit `252248c` (pre-change)._

## 1. Architecture found

* **Stack:** TypeScript (Node ≥ 20), Fastify API (`src/api.ts`), Commander CLI (`src/cli.ts`), SQLite via better-sqlite3 (`src/core/storage.ts`), cheerio parsing, optional Playwright.
* **Crawl path:** `Orchestrator` (`src/core/orchestrator.ts`) seeded from user-supplied URLs → frontier table → `CrawlPolicy` (robots, rate limit) → `EngineRegistry` (http / playwright / Wayback) → saved raw HTML to disk + page row (URL, title, status, hash).
* **Other modules:** topic "intelligence" lookups (`src/topic/*`), chatbot over crawled text (`src/chat/*`), Scribd/"deep-web" corpus sync with webhook publishing (`src/sources/*`, `src/sync/*`), "Nomad" security stack (`src/security/nomad.ts`).
* **Deployment:** `railway.toml` with Nixpacks; no Dockerfile; no health check; no volume.
* **No frontend** in the repository; no metadata model beyond `{url, title, status, hash}`.

## 2. Confirmed defects (root cause → fix)

| # | Severity | Defect | Root cause | Fix |
|---|---|---|---|---|
| 1 | Critical | SSRF: `169.254.169.254` (cloud metadata), `100.64/10`, IPv6 (`::1`, `fc00::/7`, `::ffff:127.0.0.1`), and hostnames resolving to private IPs were reachable | Literal-IPv4 string checks only; `blockLinkLocal` option never used; redirects followed automatically without re-checking; no DNS validation | `src/net/ip-guard.ts` + `src/net/safe-fetch.ts`: BlockList over all reserved ranges, DNS answers validated **and pinned** in the connector (no rebinding), manual redirects re-checked per hop |
| 2 | Critical | Auth never enforced | `dev_mode: true` in default config short-circuits auth | v2 API uses `API_KEYS` env (hashed compare); legacy routes are off by default and require keys in production |
| 3 | High | Memory exhaustion: response bodies read fully with no cap | `await resp.arrayBuffer()` | Streaming read with byte caps, decompression handled manually with caps; zip inflation hard-capped (`maxOutputLength`) — a zip whose headers lie is now harmless (tested) |
| 4 | High | Person-dossier pipeline exposed via `POST /v1/lookup` (home addresses, family phone numbers, co-residents, move-outs of a named person) | `src/topic/household-intel.ts`, `people-intel.ts` | Removed from the HTTP surface; the new engine counts and masks PII and never stores it. CLI code still exists in the repo (not deployed) |
| 5 | High | Deep-web scheduler ran on every boot, wrote to ephemeral disk, and pushed "uncensored" full text to webhooks by default | `auto_sync: true`, `uncensored: true`, `publish_full_text: true` defaults | Defaults off; legacy module only mounts with `LEGACY_API=on` |
| 6 | Medium | Per-host rate limiter ineffective under concurrency | read-then-sleep race on `lastRequest` | Host slots are reserved before fetching (`hosts.next_allowed_at`), one in-flight request per host |
| 7 | Medium | Playwright launched for most pages | `needsJsRendering` matched the words "react"/"vue" anywhere and retried every non-2xx via browser | New pipeline does not render; legacy heuristic left only in legacy path |
| 8 | Medium | Shallow config merge dropped nested defaults; `PORT`-only binding fine but crawler data on ephemeral container disk | `{...DEFAULT, ...yaml}` | New code reads env; corpus lives on a mounted volume (`DATA_DIR`) |
| 9 | Medium | Unbounded in-memory chat sessions | `Map` without eviction | Legacy only (not mounted by default) |
| 10 | Low | `Content-Length` used as file size even when the body was compressed; CSV statistics counted empty cells as `0`; MP4 epoch-zero timestamps reported as real 1904 dates; malformed PDFs reported no failure | Found by the new tests | Fixed, each with a regression test |

## 3. The misunderstanding that was corrected

Crawling had been treated as **collecting URLs and titles**. That is discovery input. The crawler now:

1. discovers resources itself (bootstrap catalogs/feeds/sitemaps + everything it reads + topical discovery), never requiring user-supplied links;
2. retrieves each resource's **actual content**, detects its format from bytes, and runs the matching extractors;
3. follows references **for a purpose** (artifact, licence, methodology, schema, revision, provenance, citation, model card…) and links the findings back with the right scope;
4. stores each observation with evidence and indexes contents + metadata together;
5. answers questions from that corpus.

## 4. Defects found during this work (all fixed, each with a regression test)

| Defect | Found by | Fix |
|---|---|---|
| Process crash on first Railway deploy: destroying an undici body emits an unhandled `error` | Railway runtime logs | listeners before destroy; `tests/safe-fetch-live.test.ts` reproduces the crash without the fix |
| Tesseract WASM abort on undecodable images surfaced as an unhandled error and poisoned the shared worker | OCR test | decode pre-check, worker `errorHandler`, discard failed workers |
| Discovery purpose lost when the extractor had already recorded the same edge | snowfall scenario | edges merge purpose/scope on conflict (both backends) |
| Archive entries released the parent's host lease (concurrent requests to one host) | review while tracing a flaky test | entries update stage without releasing the host |
| Search: ranking every OR-match (seq scan), `stats()` per request, N+1 queries, cache stampedes → ~4 req/s | load test + EXPLAIN | AND-first ranking, cached stats, batched loads, single-flight → ~970 req/s cold |
| Rate limiter kept a per-request timestamp log (O(requests) per check) | load test | O(1) sliding-window counter |
| Any-term fallback flattened scores; type words ("datasets") required as text | snowfall scenario | order-preserving fallback; type words drive a type boost instead |
| MP4 video tracks misread as audio by music-metadata; epoch-zero container dates reported as 1904 | MP4 fixture | dedicated ISO-BMFF box parser; unset dates rejected |
| pdf-lib accepted garbage silently; CSV statistics counted empty cells as 0; compressed Content-Length used as file size | fixtures | explicit extraction_failed; empty cells excluded; decoded size |

## 5. Completion ledger

Statuses: **Verified complete** (implemented and tested) · **Implemented, unverified** (code exists, required verification not run) · **Blocked** · **Not implemented**.

| Capability | Status | Evidence |
|---|---|---|
| 41-category registry: applicability, methods, core + extended fields, discovery rules, validation | Verified complete | `tests/metadata-pipeline.test.ts`, `GET /api/v2/categories` |
| Every category observed from real artifacts | Verified complete | `tests/coverage.test.ts`, `docs/COVERAGE.md`, e2e "covers all 41" on both backends |
| Truthful availability states, evidence types, scope | Verified complete | e2e + scenario tests |
| Autonomous discovery without user URLs | Verified complete (local); live on Railway | e2e/scenario tests start from bootstrap sources only; production logs show live PDFs being processed |
| Standalone files (S3/GCS/autoindex/IA manifests, Common Crawl index) | Verified complete (local, CC API mocked at HTTP boundary) | `tests/standalone-files.test.ts` |
| Purpose-driven supporting material + scope | Verified complete | scenario + e2e |
| Stage tracking, traps, robots, duplicates, revisits, version diffs, failed parsers, restart recovery | Verified complete | `tests/autonomous-crawler.test.ts` (SQLite + Postgres) |
| Multiple crawler replicas on one frontier | Verified complete | `tests/multi-crawler.test.ts` (4 replicas, 8 hosts, 120 resources) |
| Learned URL-pattern yields, extractor reliability, gap pursuit | Verified complete (learning recorded; priority effect unit-level) | e2e "learns URL-pattern yields" |
| OCR (Tesseract, bundled model) | Verified complete | `tests/ocr-render.test.ts` |
| Selective JS rendering | Verified complete where Chromium exists (CI image may skip) | `tests/ocr-render.test.ts` |
| Search with fact sheets, evidence, supporting facts, gaps | Verified complete | scenario test |
| Search performance | Measured | README table (single 4-vCPU box) |
| OpenAPI + CORS for frontend | Verified complete | `tests/crawl-api.test.ts` |
| Bootstrap sources against live public APIs | Implemented; live results visible only via Railway logs/heartbeat | sandbox egress blocks those hosts |
| Railway multi-service (Postgres + api + crawler) | See deployment notes in the final report | — |
| Cryptographic verification of PDF/DKIM/OOXML signatures | Not implemented (presence detected only) | — |

## 6. Known limitations

* Capacity is horizontal (API replicas, crawler replicas, Postgres read replicas, CDN); claims about specific user counts require load tests at that scale.
* Cross-source claim reconciliation exists for DOIs (Crossref corroboration) only.
* OCR is English-only by default.
