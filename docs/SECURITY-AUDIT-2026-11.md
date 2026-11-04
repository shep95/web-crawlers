# Security audit — Void and Omnispider, November 2026

Scope: the two repositories (`shep95/asherin.void`, `shep95/web-crawlers`) and their production
deployments (Void on Railway and Vercel, the Omnispider API and crawler on Railway with Postgres).
Everything here is authorized: these are the owner's own systems. No third-party system was tested;
the only external targets were public resolvers, registries and certificate logs read passively.

This is a finite, time-stamped audit. It does not claim the systems are secure — only what was
checked, what was found, what was fixed and retested, and what remains unknown.

## Method

1. **Dependencies** — `npm audit` on production dependencies of both repositories.
2. **Secrets** — the crawler's own detector over every tracked file and the full git history of both
   repositories (types and locations only; values never printed).
3. **Code review** of the parts that take untrusted input: crawler HTTP routes and their auth, the
   domain-intelligence collector (DNS/TLS/TCP/HTTP to user-chosen names), the Void worker relays.
4. **Live, owner-authorized external assessment** with the new Domain Intelligence engine (the
   188-rule cause-and-effect map) against `asherinvoid.vercel.app`, `void-web-production.up.railway.app`
   and `omnispider-production.up.railway.app`, run from Railway; fixes deployed; same run repeated.

## Findings

| # | Severity | Where | Finding | State | Fix | Retest |
|---|---|---|---|---|---|---|
| 1 | Critical (install-time) | crawler deps | `tar` path traversal via `canvas` → `@mapbox/node-pre-gyp` (pulled in by `unpdf` 0.12) | validated (advisory) | `unpdf` 1.9 (no `canvas`) | `npm audit`: 0 |
| 2 | High | crawler deps | Infinite-loop parsers on hostile media: `music-metadata`, `image-size`, `file-type` — the crawler parses untrusted files | validated (advisory) | `music-metadata` 12, `image-size` 2 | `npm audit`: 0; full suite green |
| 3 | High | crawler deps | `fastify` schema-validation bypass and X-Forwarded-* spoofing; `find-my-way` HTTP/2 DoS; `fast-uri` host confusion | validated (advisory) | patched minor releases | `npm audit`: 0 |
| 4 | High | crawler deps | `zod` memory exhaustion on oversized collections; `js-yaml` quadratic CPU | validated (advisory) | `zod` 4, `js-yaml` patched | `npm audit`: 0 |
| 5 | Moderate | crawler deps | `glob` / `minimatch` (via `@fastify/static`) | validated (advisory) | pinned `glob` 14.0.3, `minimatch` 11 via overrides | `npm audit`: 0 |
| 6 | High (availability) | production API | `/api/v2/coverage` returned 500: parallel full-table aggregates exhausted Postgres dynamic shared memory (SQLSTATE 53100), then hit the statement timeout | validated (production logs) | aggregates run serially, parallel workers off, built in the background and served from the last completed build | 500 reproduced live; fix deployed (verification below) |
| 7 | Low | production API | CORS reflected any `Origin` (no credentials) | validated live | literal `*` | live: `Access-Control-Allow-Origin: *` |
| 8 | Info | production API | Unknown file-like paths answered 200 with the app shell (soft 404) | observed | real 404 for file-like and `/.well-known` paths | live: `/wp-login.php` → 404 |
| 9 | Info | all three hosts | No vulnerability-reporting contact | observed | RFC 9116 `/.well-known/security.txt` | live on Railway hosts; Vercel pending (see below) |
| 10 | Low | Void on Railway | No HSTS | observed | `Strict-Transport-Security` on every response | live: present |
| 11 | Low | API UI | CSP had no explicit `object-src` (fell back to `default-src 'self'`) | observed | `object-src 'none'` | test |
| 12 | Medium (fairness) | domain-intel relay | Every Void visitor shared one rate-limit bucket at the crawler | validated (code) | Void forwards an opaque salted daily hash per visitor | test |
| 13 | Medium | Void on Vercel | `/api/occurrences` had no Vercel function (Text tab 404 on Vercel only) | validated live | `api/occurrences.js`; check that every worker route has a function | check |
| 14 | — | both repos | Secrets scan: 8 current-tree and 6 history candidates | all are deliberate test fixtures (documented example keys, fake JWT/PEM, dummy URL credentials, CI-only Postgres password) | — | no live credential found |

The domain-intelligence engine itself was also corrected after its first live run (the run that
found 6–10): it scoped `*.up.railway.app` tenants to all of `railway.app` (now scoped to the owned
host), reported ECDSA P-256 keys as "256-bit", and misread Google's EHLO reply as having no STARTTLS.
Each has a regression test.

## Verified safe in review

- Admin routes (`/api/v2/crawler/pause|resume`) fail closed without configured keys; keys are stored
  as digests and compared with `timingSafeEqual`.
- Every outbound request of the domain-intelligence collector (HTTP, TLS, TCP) refuses private,
  loopback, link-local and metadata addresses (tested); domains are normalized and internal TLDs refused.
- Domain intelligence never stores page bodies, secret values, cookie values or exposed-file contents;
  report text is rendered in Void with `textContent` only (checked).
- Owner-only probes run only for declared or DNS-proven owned hosts and never against shared platform
  networks (00-02).

## Not fixed / not verifiable from here

- **Vercel deployment is stale.** Vercel still serves an older build (no `/domain`, no `security.txt`,
  no `/api/occurrences`). The Vercel connection used for this work no longer has access to the
  project (403/404), so the deployment could not be triggered or inspected. The Vercel build passes
  locally (`npm run build:vercel`, `checks/vercel.mjs`).
- **DNSSEC and wildcard DNS** on `vercel.app` / `railway.app` are platform properties.
- **Search latency** for some one-word queries was 12–20 s in production; not a security issue,
  not yet diagnosed.
- Not assessed: cloud account IAM, CI/CD secrets, Railway/Vercel team access, backups — no access.
  Absence of findings there is not evidence of safety.
