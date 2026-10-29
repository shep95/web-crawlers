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

## 4. Completion ledger

Statuses: **Verified complete** (implemented and tested) · **Implemented, unverified** (code exists, required verification not yet run) · **Blocked** · **Not implemented**.

| Capability | Status | Evidence |
|---|---|---|
| 41-category registry with applicability, methods, schema, limitations | Verified complete | `tests/metadata-pipeline.test.ts` (registry), `docs/COVERAGE.md` |
| Every category observed from real artifacts (offline fixtures) | Verified complete | `tests/coverage.test.ts` |
| Every category observed in an autonomous crawl | Verified complete | `tests/autonomous-crawler.test.ts` → "covers all 41 categories" |
| Truthful availability states per resource | Verified complete | not-applicable / extraction-failed / unavailable assertions |
| Evidence types, scope, original vs normalised values | Verified complete | site-vs-resource licence scope test; date tests |
| Autonomous discovery without user URLs (bootstrap → frontier) | Verified complete (local) | e2e test starts from a bootstrap source only |
| Purpose-driven following of supporting material | Verified complete | methodology/schema/rights/revision purposes asserted |
| Separate stage tracking (retrieved/inspected/extracted/indexed) | Verified complete | e2e test |
| Trap / budget / robots / canonicalisation controls | Verified complete | calendar, pagination, robots, utm-variant assertions |
| Duplicate content detection | Verified complete | mirror page linked as duplicate, not indexed twice |
| Version changes, conditional revisits (304) | Verified complete | revisit test (changed fields + `not_modified`) |
| Failed parsers recorded without losing the resource | Verified complete | broken PDF test |
| Restart recovery | Verified complete | simulated crash with outstanding lease |
| Archive inspection (zip/tar/tgz, BagIt, nested entries) | Verified complete | e2e bundle.zip test |
| PDF text layer, attachments | Verified complete (text) / Implemented, unverified (attachments) | methodology PDF test |
| Image OCR | Not implemented | images without embedded text metadata report text as unavailable |
| Selective browser rendering for JS-only pages | Not implemented in the new crawler | static retrieval only; legacy Playwright engine remains in legacy path |
| Search over collected corpus with evidence + gaps | Verified complete | e2e search assertions |
| Topical discovery from questions (APIs used only to find resources) | Implemented, unverified live | sandbox egress blocks those APIs |
| Bootstrap sources (Data.gov, Zenodo, HF Hub, Commons, Internet Archive, arXiv, HN, sitemaps/feeds) | Implemented, unverified live until deployment | parsers unit-tested for search providers; live check pending |
| Network enrichment (DNS, TLS, Wayback, Crossref, GitHub, HF, PyPI/npm) | Implemented, partially verified | PyPI verified live from sandbox; others require direct egress |
| SSRF guard | Verified complete | `tests/security-normalize.test.ts` |
| API auth, rate limits, validation, security headers | Verified complete | `tests/crawl-api.test.ts` |
| Railway deployment | See README / commit log | updated after deployment |

## 5. Known limitations

* Single-writer SQLite: one replica. Horizontal scaling would need Postgres + a shared queue.
* No OCR, no JS rendering in the autonomous crawler.
* Cross-source corroboration exists for DOIs (Crossref); broader claim reconciliation across sources is not implemented.
* Signatures (PDF/DKIM/OOXML) are detected, not cryptographically verified.
