// Generated from docs/domain-cause-effect-map.txt (19 families, 188 rules). Do not edit by hand.
// Each rule: observed condition (if) -> inspection -> positive escalation -> negative/stop path.
export interface MapRule { id: string; family: string; if: string; inspect: string; positive: string; otherwise: string }
export const FAMILIES: Array<{ id: string; name: string }> = [{"id": "00", "name": "authorization, scope, and evidence"}, {"id": "01", "name": "domain and registration identity"}, {"id": "02", "name": "DNS and naming tree"}, {"id": "03", "name": "network, hosting, and exposed services"}, {"id": "04", "name": "TLS, transport, and HTTP edge"}, {"id": "05", "name": "website structure, pages, and content discovery"}, {"id": "06", "name": "identity, enrollment, authentication, and recovery"}, {"id": "07", "name": "session management, cookies, and tokens"}, {"id": "08", "name": "authorization, object ownership, and tenant isolation"}, {"id": "09", "name": "inputs, injection, parsing, and output encoding"}, {"id": "10", "name": "API, GraphQL, gRPC, WebSockets, and webhooks"}, {"id": "11", "name": "application logic and transaction state"}, {"id": "12", "name": "browser/client-side security"}, {"id": "13", "name": "files, storage, databases, and privacy"}, {"id": "14", "name": "cloud infrastructure, containers, and IAM"}, {"id": "15", "name": "software, dependencies, CI/CD, and supply chain"}, {"id": "16", "name": "mail, communications, and external trust"}, {"id": "17", "name": "detection, incident response, reliability, and resilience"}, {"id": "18", "name": "scoring, evidence, remediation, and recursion"}];
export const RULES: MapRule[] = [
{
"id": "00-01",
"family": "00",
"if": "A target domain is supplied",
"inspect": "Define the exact authorized roots, environments, IPs, apps, test windows, and excluded third parties",
"positive": "If written authorization covers the asset, permit the agreed testing class; otherwise use only lawfully available passive information",
"otherwise": "If no permission, do not attempt intrusive tests, login guessing, access to private content, or disruptive probes"
},
{
"id": "00-02",
"family": "00",
"if": "A hostname resolves to a vendor/CDN/third-party network",
"inspect": "Attribute the owner and contractual scope before treating it as an asset",
"positive": "If explicitly included, assess within rules; otherwise document dependency and seek permission",
"otherwise": "Stop at ownership boundary; a DNS link is not authorization"
},
{
"id": "00-03",
"family": "00",
"if": "An asset is newly discovered",
"inspect": "Record source, discovery time, hostname, IP, URL, service, confidence, and parent relation",
"positive": "If new and in scope, enqueue appropriate child categories",
"otherwise": "If duplicated or out of scope, link as reference and stop expansion"
},
{
"id": "00-04",
"family": "00",
"if": "An input or page exposes a potentially sensitive resource",
"inspect": "Determine whether authorization allows inspection without collecting private content",
"positive": "If allowed, use minimal non-sensitive proof and protect evidence",
"otherwise": "Otherwise record only the indicator and recommend owner review"
},
{
"id": "00-05",
"family": "00",
"if": "A test may alter data, send messages, charge money, or interrupt service",
"inspect": "Require a safe sandbox, approved method and rollback criteria",
"positive": "If safety guaranteed, run minimal verification; otherwise use configuration review",
"otherwise": "No destructive confirmation against production without authorization"
},
{
"id": "00-06",
"family": "00",
"if": "A finding is inferred from a banner, version, or pattern",
"inspect": "Separate observation, hypothesis, confirmed weakness, verified impact, and unknown",
"positive": "If evidence supports a safe validation, test carefully",
"otherwise": "If not, report as unverified rather than vulnerable"
},
{
"id": "00-07",
"family": "00",
"if": "An asset disappears or changes during testing",
"inspect": "Timestamp the observation and inspect change history",
"positive": "If transient, retry within scope and compare results",
"otherwise": "If no longer available, retain historical record with no present-tense exposure claim"
},
{
"id": "00-08",
"family": "00",
"if": "A branch spawns another branch already explored",
"inspect": "Record edge to existing node rather than revisit endlessly",
"positive": "If version/state changed, reopen affected tests",
"otherwise": "If unchanged, stop to avoid cycles"
},
{
"id": "01-01",
"family": "01",
"if": "A registered domain exists",
"inspect": "Review RDAP, registrar, registration status, dates, contact/abuse routes, and expiration policy",
"positive": "If unexpected ownership or expiration issue, investigate transfer/renewal controls",
"otherwise": "If records are private/limited, mark missing evidence rather than invent owner"
},
{
"id": "01-02",
"family": "01",
"if": "A domain uses a registrar",
"inspect": "Review registrar account MFA, registry lock, transfer protections, recovery contacts, change approval",
"positive": "If weak controls, investigate hijack risk and remediation",
"otherwise": "If access to registrar configuration unavailable, external audit ends at observable signals"
},
{
"id": "01-03",
"family": "01",
"if": "A domain shares organizational naming patterns",
"inspect": "Discover documented related brands, alternate TLDs, ccTLDs, internationalized variants, and redirects",
"positive": "If in scope and independently attributable, add domains as new roots",
"otherwise": "Similar names alone do not prove shared ownership"
},
{
"id": "01-04",
"family": "01",
"if": "A name is internationalized or visually confusable",
"inspect": "Review Unicode IDNA representation, homograph risks, display consistency and phishing exposure",
"positive": "If owned by organization, review controls and redirects",
"otherwise": "If unrelated, treat as brand-monitoring intelligence, not an asset to test"
},
{
"id": "01-05",
"family": "01",
"if": "An old or alternate domain redirects to a new domain",
"inspect": "Map complete redirect chain and protocol, status, query-string handling",
"positive": "If redirect leads to controlled host, follow in-scope branch",
"otherwise": "If it reaches third party, record edge and stop active testing"
},
{
"id": "01-06",
"family": "01",
"if": "Domain registration or ownership history changes",
"inspect": "Compare timestamps to infrastructure and DNS history",
"positive": "If coincident exposure changes, prioritize verification",
"otherwise": "A timestamp correlation alone is not a causal proof"
},
{
"id": "02-01",
"family": "02",
"if": "An NS record exists",
"inspect": "Identify authoritative nameservers, delegation consistency, geographic/provider diversity, and stale delegation",
"positive": "If inconsistent or dangling, review service control and takeover exposure",
"otherwise": "If externally owned service, scope-check before querying beyond normal resolution"
},
{
"id": "02-02",
"family": "02",
"if": "An A or AAAA record exists",
"inspect": "Resolve IPv4/IPv6, compare DNS answers, ports, TLS, hosting, and routing",
"positive": "If reachable in scope, create host/service branches",
"otherwise": "If not reachable, preserve DNS-only observation; do not label secure"
},
{
"id": "02-03",
"family": "02",
"if": "A CNAME or ALIAS points elsewhere",
"inspect": "Resolve the entire chain, assess destination service ownership and claimed resource status",
"positive": "If dangling to an unclaimed service, request safe owner verification of takeover risk",
"otherwise": "If legitimately claimed, classify the provider and continue to host/application mapping"
},
{
"id": "02-04",
"family": "02",
"if": "An MX record exists",
"inspect": "Identify inbound mail host and provider; branch to email transport and mail authentication",
"positive": "If misrouted or stale, assess mail loss/impersonation concerns",
"otherwise": "If valid, investigate mail controls independently"
},
{
"id": "02-05",
"family": "02",
"if": "TXT records exist",
"inspect": "Classify SPF, DMARC, site verification, other published tokens, and unintended secrets",
"positive": "If unexpected sensitive values, validate exposure without using credentials",
"otherwise": "If merely a verification token, avoid assuming it grants access"
},
{
"id": "02-06",
"family": "02",
"if": "An SPF record exists",
"inspect": "Check syntax, lookup budget, include chains, legacy mechanisms, overly broad authorized senders",
"positive": "If overly permissive, prioritize mail spoofing risk review",
"otherwise": "If valid, still separately test DKIM and DMARC"
},
{
"id": "02-07",
"family": "02",
"if": "A DMARC record exists or is missing",
"inspect": "Review policy, alignment, aggregate reporting destinations, subdomain policy",
"positive": "If weak/missing, evaluate spoofing exposure with owner",
"otherwise": "If strict, check whether legitimate mail remains aligned"
},
{
"id": "02-08",
"family": "02",
"if": "A DKIM selector is published",
"inspect": "Review selector configuration, current key strength, rotation and alignment",
"positive": "If weak/stale, recommend rotation after confirming mail flow",
"otherwise": "If good, continue other mail controls"
},
{
"id": "02-09",
"family": "02",
"if": "A CAA record exists or is missing",
"inspect": "Compare permitted certificate authorities and issuance workflow",
"positive": "If issuance policy is unintended, adjust after verifying operational needs",
"otherwise": "Absence is not by itself proof of compromise"
},
{
"id": "02-10",
"family": "02",
"if": "DS/DNSKEY/RRSIG records appear",
"inspect": "Evaluate DNSSEC trust chain, signing, rollover, expiry, and validator behavior",
"positive": "If broken validation, investigate resolution failure or spoofing protection gap",
"otherwise": "If absent, document DNSSEC posture without declaring an exploit"
},
{
"id": "02-11",
"family": "02",
"if": "PTR or reverse DNS is present",
"inspect": "Compare host naming to forward resolution and email sending policy",
"positive": "If mismatch, review operational impact",
"otherwise": "PTR alone does not prove server ownership"
},
{
"id": "02-12",
"family": "02",
"if": "SRV, SVCB, HTTPS, or other service discovery records appear",
"inspect": "Parse service target, port, priority and protocol parameters",
"positive": "If a new reachable in-scope service is named, enqueue service scan",
"otherwise": "If target is external, stop at third-party boundary"
},
{
"id": "02-13",
"family": "02",
"if": "DNS wildcard responses appear",
"inspect": "Distinguish wildcard results from real named assets using controls",
"positive": "If wildcard, avoid counting invented subdomains",
"otherwise": "If distinct service, add real host branch"
},
{
"id": "02-14",
"family": "02",
"if": "DNS zone transfer is configured",
"inspect": "Review authoritative server transfer ACLs through owner-approved validation",
"positive": "If unauthorized transfer is confirmed, report namespace exposure",
"otherwise": "Otherwise leave as configuration question, no speculative claim"
},
{
"id": "02-15",
"family": "02",
"if": "Historical DNS or certificate records reveal old hosts",
"inspect": "Compare archival timestamps to present resolution and ownership",
"positive": "If still live and authorized, inspect legacy host",
"otherwise": "If stale or outside scope, label historical; avoid calling it active"
},
{
"id": "02-16",
"family": "02",
"if": "DNS rebinding or split-horizon behavior is suspected",
"inspect": "Compare authorized vantage points and DNS answers",
"positive": "If internal/private addresses are served externally, assess SSRF/browser trust issues carefully",
"otherwise": "If inaccessible internally, request administrator-supplied view"
},
{
"id": "03-01",
"family": "03",
"if": "A resolved IP address is in scope",
"inspect": "Determine provider, ASN, CDNs, shared hosting, WAF and actual asset ownership",
"positive": "If dedicated or explicitly in scope, inventory listening ports",
"otherwise": "If shared third-party edge, do not scan unrelated tenant services"
},
{
"id": "03-02",
"family": "03",
"if": "A host responds over TCP/UDP",
"inspect": "Identify service and protocol without stress testing",
"positive": "If service is unexpected, inspect exposure and access policy",
"otherwise": "If expected, inspect hardening and patch state"
},
{
"id": "03-03",
"family": "03",
"if": "Port 80 or 443 serves HTTP(S)",
"inspect": "Proceed to web routing, TLS, headers, pages, and application tests",
"positive": "If multiple virtual hosts, enumerate known in-scope hostnames",
"otherwise": "If only a CDN/WAF, note edge-origin visibility limits"
},
{
"id": "03-04",
"family": "03",
"if": "SSH, RDP, VNC, or VPN is exposed",
"inspect": "Review necessity, authorized users, MFA, network restrictions, version and patch posture",
"positive": "If unnecessarily public, recommend restricting access",
"otherwise": "If no authorized config access, only externally observable properties are known"
},
{
"id": "03-05",
"family": "03",
"if": "A database or cache port is reachable",
"inspect": "Review intended network isolation, authentication, encryption and bind settings",
"positive": "If internet exposure is unintended, escalate without reading data",
"otherwise": "If protected, assess configuration with administrator access"
},
{
"id": "03-06",
"family": "03",
"if": "A mail service port is reachable",
"inspect": "Review SMTP/IMAP/POP exposure, authentication, transport TLS and relay policy",
"positive": "If unexpected relay or cleartext access, investigate via permitted non-abusive validation",
"otherwise": "If controlled, map to email controls"
},
{
"id": "03-07",
"family": "03",
"if": "An admin console or management interface is reachable",
"inspect": "Confirm in-scope ownership and intended audience",
"positive": "If public, review MFA, IP restrictions, role access and version",
"otherwise": "If inaccessible, don't try to bypass it"
},
{
"id": "03-08",
"family": "03",
"if": "A service version or banner is disclosed",
"inspect": "Cross-check software/component identity, patch level and vendor advisories",
"positive": "If known CVE matches, verify applicability and reachability safely",
"otherwise": "Version alone is insufficient to verify vulnerability"
},
{
"id": "03-09",
"family": "03",
"if": "TLS service exists outside the web server",
"inspect": "Check applicable TLS versions, certificates, trusted chain and hostname identity",
"positive": "If invalid or legacy setting, classify risk in protocol context",
"otherwise": "If good, proceed with service-specific access tests"
},
{
"id": "03-10",
"family": "03",
"if": "A service is filtered, times out, or rate-limits probes",
"inspect": "Record observation and distinguish blocked from closed or absent",
"positive": "If rate-limited, slow or stop according to rules",
"otherwise": "Do not infer vulnerability absence from lack of response"
},
{
"id": "03-11",
"family": "03",
"if": "An exposed IoT, OT, or appliance endpoint appears",
"inspect": "Determine owner, life-safety/operational sensitivity and excluded scope",
"positive": "If specifically authorized, use vendor-safe review procedures",
"otherwise": "Otherwise stop active tests and notify owner"
},
{
"id": "04-01",
"family": "04",
"if": "An HTTPS endpoint exists",
"inspect": "Validate certificate hostname, chain, expiration, renewal automation, issuer and policy",
"positive": "If invalid, identify user impact and remediation",
"otherwise": "If valid, test protocol configuration next"
},
{
"id": "04-02",
"family": "04",
"if": "A TLS handshake negotiates legacy protocols or ciphers",
"inspect": "Compare negotiated suites to policy and current guidance",
"positive": "If weak, record server and client compatibility implications",
"otherwise": "If modern, continue forward secrecy and key management review"
},
{
"id": "04-03",
"family": "04",
"if": "HTTP is offered alongside HTTPS",
"inspect": "Determine redirect behavior, mixed-content, HSTS applicability and upgrade path",
"positive": "If sensitive endpoints remain on HTTP, prioritize confidentiality/integrity concern",
"otherwise": "If redirected, still verify first-visit and subdomain behavior"
},
{
"id": "04-04",
"family": "04",
"if": "HTTP response sets HSTS",
"inspect": "Review max-age, subdomain coverage and preload suitability",
"positive": "If missing/weak on sensitive site, consider stronger policy after coverage audit",
"otherwise": "If present, verify subdomain compatibility before changing"
},
{
"id": "04-05",
"family": "04",
"if": "A reverse proxy/CDN/WAF is present",
"inspect": "Review forwarding headers, host handling, cache policy, origin restrictions and bypass exposure",
"positive": "If origin is publicly reachable, review origin access constraints",
"otherwise": "If hidden, do not assume backend is unreachable by all routes"
},
{
"id": "04-06",
"family": "04",
"if": "HTTP compression or caching is enabled",
"inspect": "Check secrets in shared caches, cache keys, cookies and content-type separation",
"positive": "If private data caches publicly, verify with harmless test accounts",
"otherwise": "If safe, continue cache-control integrity checks"
},
{
"id": "04-07",
"family": "04",
"if": "A site offers HTTP/2 or HTTP/3",
"inspect": "Review protocol settings, proxy/backend consistency, resource constraints and patch levels",
"positive": "If parsing inconsistencies indicated, scope-safe specialist tests follow",
"otherwise": "If none, avoid assuming complex request smuggling"
},
{
"id": "04-08",
"family": "04",
"if": "CORS headers are present",
"inspect": "Compare allowed origins, credentials, methods and header restrictions with data sensitivity",
"positive": "If origin is untrusted and sensitive response accessible, verify exposure with test data",
"otherwise": "If restrictive, document expected cross-origin behavior"
},
{
"id": "04-09",
"family": "04",
"if": "Redirect parameters exist",
"inspect": "Review destination allowlist and input normalization",
"positive": "If attacker-controlled external destinations are permitted, examine phishing or token leakage implications",
"otherwise": "If destinations are fixed, close open-redirect branch"
},
{
"id": "04-10",
"family": "04",
"if": "Security headers are present or missing",
"inspect": "Inspect CSP, framing policy, MIME sniffing, referrer rules and permissions policies",
"positive": "If missing, map controls to actual attack possibilities",
"otherwise": "Absence of a single header is not automatically an exploitable bug"
},
{
"id": "05-01",
"family": "05",
"if": "A live website is found",
"inspect": "Collect in-scope starting URLs and follow links within approved crawl rules",
"positive": "If page reveals new in-scope paths or hosts, enqueue them",
"otherwise": "If link is third party or excluded, record edge only"
},
{
"id": "05-02",
"family": "05",
"if": "A robots.txt file exists",
"inspect": "Interpret crawler directives as signals, not authorization or protection",
"positive": "If allowed by authorization, review referenced paths carefully",
"otherwise": "Do not use disallow as permission to access sensitive systems"
},
{
"id": "05-03",
"family": "05",
"if": "An XML sitemap or index exists",
"inspect": "Extract canonical URLs, languages, timestamps and nested sitemaps",
"positive": "If new in-scope routes appear, enqueue route analysis",
"otherwise": "If stale, label historical hint"
},
{
"id": "05-04",
"family": "05",
"if": "HTML links, forms, or script URLs exist",
"inspect": "Parse href, action, method, query, embedded resources and dynamic route references",
"positive": "If new same-origin endpoint, add to route tree",
"otherwise": "If external, record third-party dependency"
},
{
"id": "05-05",
"family": "05",
"if": "A page uses a SPA or client-side router",
"inspect": "Observe authorized browser navigation and network requests",
"positive": "If hidden app routes/API calls appear, add to page and API maps",
"otherwise": "If authentication blocks view, mark gated surface"
},
{
"id": "05-06",
"family": "05",
"if": "A form is found",
"inspect": "Identify input fields, method, backend endpoint, data type, authentication and CSRF expectations",
"positive": "If mutation occurs, branch to permissions, input handling and business logic",
"otherwise": "If read-only, branch to query validation and privacy"
},
{
"id": "05-07",
"family": "05",
"if": "A route contains parameters or IDs",
"inspect": "Classify query/path/body/header/cookie inputs and resource ownership semantics",
"positive": "If user-controlled data enters a sink, branch to validation and authorization",
"otherwise": "If static, perform config and content checks only"
},
{
"id": "05-08",
"family": "05",
"if": "The URL is an upload/download/export/import path",
"inspect": "Branch to file handling, access controls, size/content constraints and privacy",
"positive": "If file operation is destructive, require safe test fixtures",
"otherwise": "If links are dead, report availability issue separately"
},
{
"id": "05-09",
"family": "05",
"if": "JavaScript bundles or source maps are exposed",
"inspect": "Inventory endpoints, feature flags and accidental secrets using non-sensitive inspection",
"positive": "If secret indicator appears, request safe rotation review",
"otherwise": "If code is public by design, don't equate exposure with exploit"
},
{
"id": "05-10",
"family": "05",
"if": "A legacy route or archived endpoint exists",
"inspect": "Check whether it remains deployed, authenticated and in scope",
"positive": "If active, review unsupported code and data retention",
"otherwise": "If only historical, annotate timestamp and stop active branch"
},
{
"id": "05-11",
"family": "05",
"if": "Search, pagination, filtering, and sorting are present",
"inspect": "Identify backend parameters, rate limits and validation paths",
"positive": "If expensive queries or unsafe inputs are plausible, test with harmless limits",
"otherwise": "Otherwise verify expected access controls"
},
{
"id": "05-12",
"family": "05",
"if": "404, 500, or custom error pages exist",
"inspect": "Inspect whether stack traces, internal paths or secrets leak in errors",
"positive": "If yes, log evidence with redaction and review exception handling",
"otherwise": "If generic, do not infer internal error hygiene"
},
{
"id": "06-01",
"family": "06",
"if": "A login endpoint or sign-in button exists",
"inspect": "Map password, passwordless, SSO, MFA, device trust and user enumeration behavior",
"positive": "If credentials authenticate, follow session and authorization branches",
"otherwise": "If access unavailable, do not guess or brute force"
},
{
"id": "06-02",
"family": "06",
"if": "An account registration path exists",
"inspect": "Review email verification, invitation constraints, bot abuse controls and activation races",
"positive": "If unverified identity grants privilege, review account takeover exposure",
"otherwise": "If verified, inspect edge cases and duplicate identities"
},
{
"id": "06-03",
"family": "06",
"if": "Password authentication exists",
"inspect": "Review storage hashing, minimum protections, lockout design, credential-stuffing resistance and breached-password policy",
"positive": "If implementation/config access exists, verify hashing and secret handling",
"otherwise": "If not, external behavior alone cannot prove password storage quality"
},
{
"id": "06-04",
"family": "06",
"if": "MFA is supported",
"inspect": "Review enrollment, enforcement by role, recovery, bypass through alternate paths, phishing-resistant options",
"positive": "If alternate path lacks MFA, investigate policy gap",
"otherwise": "If consistently required, test session elevation behavior"
},
{
"id": "06-05",
"family": "06",
"if": "Password reset or account recovery exists",
"inspect": "Examine token generation, expiry, reuse, rate limiting, identity proofing, invalidation and notification",
"positive": "If token reuse or account enumeration plausible, verify with test accounts",
"otherwise": "If safe, test unusual recovery sequences"
},
{
"id": "06-06",
"family": "06",
"if": "An SSO, OAuth 2.0, or OIDC integration exists",
"inspect": "Review registered redirect URIs, state, nonce, PKCE, scopes, token audience/issuer and trust mapping",
"positive": "If provider or callback misconfiguration exists, assess actual impact",
"otherwise": "If correct, still inspect local role assignment"
},
{
"id": "06-07",
"family": "06",
"if": "SAML federation exists",
"inspect": "Review signature verification, audience, recipient, clock skew, replay protection and claim mapping",
"positive": "If identity claims are overly trusted, review privilege escalation potential",
"otherwise": "If correct, test logout and provisioning"
},
{
"id": "06-08",
"family": "06",
"if": "Passkeys/WebAuthn exist",
"inspect": "Review challenge binding, relying-party origin/ID, user verification, authenticator registration and recovery",
"positive": "If fallback weaker than passkey path, evaluate downgrade risk",
"otherwise": "If robust, inspect account lifecycle and device loss"
},
{
"id": "06-09",
"family": "06",
"if": "A service account or API key is used for authentication",
"inspect": "Review scope, rotation, expiration, storage and revocation",
"positive": "If long-lived/broad, prioritize least privilege",
"otherwise": "If short-lived, check renewal and audit trails"
},
{
"id": "06-10",
"family": "06",
"if": "A username or email existence difference is visible",
"inspect": "Compare safe response behavior for valid/invalid test identities",
"positive": "If enumeration possible, assess practical abuse impact",
"otherwise": "If indistinguishable, close enumeration branch, not all auth risks"
},
{
"id": "06-11",
"family": "06",
"if": "A privileged action requires recent authentication",
"inspect": "Check that reauthentication and MFA changes survive alternate routes and APIs",
"positive": "If bypassed, prioritize critical workflow",
"otherwise": "If enforced, ensure tokens rotate correctly"
},
{
"id": "07-01",
"family": "07",
"if": "A session cookie is set",
"inspect": "Inspect Secure, HttpOnly, SameSite, expiry, Domain, Path and prefix semantics",
"positive": "If unsafe attributes affect the actual threat model, confirm risk",
"otherwise": "If appropriate, inspect rotation/revocation next"
},
{
"id": "07-02",
"family": "07",
"if": "A session is created at login",
"inspect": "Compare pre-login and post-login identifiers; inspect session fixation prevention",
"positive": "If same attacker-controlled identifier persists, evaluate fixation safely",
"otherwise": "If rotated, proceed to logout lifecycle"
},
{
"id": "07-03",
"family": "07",
"if": "A logout endpoint exists",
"inspect": "Verify server-side invalidation of current sessions, refresh tokens and remembered devices",
"positive": "If token remains accepted after logout, determine severity",
"otherwise": "If revoked, test concurrent devices"
},
{
"id": "07-04",
"family": "07",
"if": "Refresh tokens are issued",
"inspect": "Inspect storage, reuse detection, rotation, expiry, audience and revocation",
"positive": "If reused tokens remain active, assess account persistence risk",
"otherwise": "If strong, test lost-device recovery"
},
{
"id": "07-05",
"family": "07",
"if": "JWTs or signed tokens are used",
"inspect": "Review algorithm allowlist, signature validation, issuer, audience, expiration and key rotation",
"positive": "If validation trusts unverified claims, assess authorization effect",
"otherwise": "If valid, authorization must still check resource ownership"
},
{
"id": "07-06",
"family": "07",
"if": "A password/MFA/role change occurs",
"inspect": "Check whether existing sessions and grants are invalidated appropriately",
"positive": "If stale privileges persist, test with two controlled accounts",
"otherwise": "If immediately updated, check long-lived workers and caches"
},
{
"id": "07-07",
"family": "07",
"if": "A state-changing browser request exists",
"inspect": "Evaluate CSRF protections, SameSite and origin checks in context",
"positive": "If authenticated cross-site mutation is possible, validate with harmless action",
"otherwise": "If not, continue XSS and token storage review"
},
{
"id": "07-08",
"family": "07",
"if": "Session tokens appear in URLs, logs, referrers or local storage",
"inspect": "Trace leakage to browser history, analytics, external hosts and accessible scripts",
"positive": "If exposed, prioritize revocation and data protection",
"otherwise": "If not, still test token lifetime and scope"
},
{
"id": "07-09",
"family": "07",
"if": "Concurrent sessions or device management exist",
"inspect": "Review revocation UI, session inventory, unusual-login notification and race behavior",
"positive": "If user cannot revoke known devices, examine response/recovery",
"otherwise": "If supported, verify actual revocation"
},
{
"id": "08-01",
"family": "08",
"if": "An endpoint returns a resource for an identifier",
"inspect": "Determine ownership, role, tenant and policy expected to govern it",
"positive": "If an authorized test account accesses another test account's object, confirm BOLA/IDOR",
"otherwise": "If denied, test other verbs and object types"
},
{
"id": "08-02",
"family": "08",
"if": "Different user roles exist",
"inspect": "Build a role-action matrix for read/create/update/delete/export/approve",
"positive": "If low role can perform high-role action, confirm function-level authorization failure",
"otherwise": "If denied, test alternate client/API route"
},
{
"id": "08-03",
"family": "08",
"if": "Multi-tenant data exists",
"inspect": "Track tenant ID from identity context to every backend data lookup",
"positive": "If tenant A can access tenant B fixture, prioritize isolation breach",
"otherwise": "If isolated, test indirect references and background jobs"
},
{
"id": "08-04",
"family": "08",
"if": "An API accepts an object with editable fields",
"inspect": "Compare client-supplied fields against server-owned fields",
"positive": "If role, price, owner, or tenant can be mass-assigned, evaluate impact",
"otherwise": "If allowlisted, check nested objects and aliases"
},
{
"id": "08-05",
"family": "08",
"if": "A privileged UI control is hidden",
"inspect": "Confirm server independently enforces entitlement",
"positive": "If API accepts direct invocation by unauthorized role, report authorization issue",
"otherwise": "If server rejects, hiding the UI is only usability"
},
{
"id": "08-06",
"family": "08",
"if": "A relationship or nested object is accessed",
"inspect": "Check both parent and child ownership, including indirect joins",
"positive": "If either is unchecked, validate with safe fixtures",
"otherwise": "If both checked, inspect aggregation/export paths"
},
{
"id": "08-07",
"family": "08",
"if": "A shared link, invite, or public resource exists",
"inspect": "Inspect token entropy, scope, expiry, revocation and onward sharing behavior",
"positive": "If token leaks or over-grants, assess real access window",
"otherwise": "If correctly scoped, document remaining intended public access"
},
{
"id": "08-08",
"family": "08",
"if": "An asynchronous worker performs actions",
"inspect": "Check the actor's authority is captured and revalidated at execution",
"positive": "If worker uses excessive platform privilege, inspect cross-user effects",
"otherwise": "If enforced, audit retries and stale roles"
},
{
"id": "08-09",
"family": "08",
"if": "A file or report can be exported",
"inspect": "Verify that filters and permissions apply server-side to all exported rows",
"positive": "If hidden rows are included, prioritize data leakage",
"otherwise": "If correct, check cache and download links"
},
{
"id": "08-10",
"family": "08",
"if": "An administrative or support impersonation feature exists",
"inspect": "Review consent, justification, audit, timeboxing, reauthentication and restrictions",
"positive": "If impersonation bypasses boundaries, escalate",
"otherwise": "If controlled, verify evidence logs"
},
{
"id": "09-01",
"family": "09",
"if": "A query/body/header/cookie/path parameter accepts input",
"inspect": "Identify type, allowed range, normalization, parser and downstream usage",
"positive": "If input is embedded in an interpreter or output sink, branch to sink-specific review",
"otherwise": "If structurally constrained, verify schema enforcement at server"
},
{
"id": "09-02",
"family": "09",
"if": "A value reaches a SQL query",
"inspect": "Review parameterized statements, query builder, stored procedures and dynamic clauses",
"positive": "If string interpolation is used, assess SQL injection with safe authorized checks",
"otherwise": "If parameterized, still inspect dynamic identifiers and authorization"
},
{
"id": "09-03",
"family": "09",
"if": "A value reaches shell/process invocation",
"inspect": "Review command argument construction and allowlists",
"positive": "If shell interpretation is possible, assess command injection with safe test fixtures",
"otherwise": "If direct argument arrays and allowlists, close this sink path"
},
{
"id": "09-04",
"family": "09",
"if": "A value reaches a template renderer",
"inspect": "Identify engine and context-specific escaping/sandboxing",
"positive": "If user input is interpreted as template code, assess server-side template injection",
"otherwise": "If text-only rendering, inspect output encoding"
},
{
"id": "09-05",
"family": "09",
"if": "A value reaches HTML, JS, CSS, or DOM sinks",
"inspect": "Review contextual encoding, HTML sanitization and CSP",
"positive": "If executable script enters browser context, investigate XSS in safe fixtures",
"otherwise": "If encoded, test each context separately"
},
{
"id": "09-06",
"family": "09",
"if": "A value becomes a URL fetched by the backend",
"inspect": "Check scheme, host, IP classification, redirects, DNS changes, egress policy and purpose",
"positive": "If internal destinations are reachable, evaluate SSRF safely without targeting private data",
"otherwise": "If blocked, test normalization and redirect handling"
},
{
"id": "09-07",
"family": "09",
"if": "A parameter selects a filesystem path",
"inspect": "Review canonicalization, fixed root, symlinks, path separators and access permissions",
"positive": "If escaping approved directory is possible, assess traversal using harmless fixture",
"otherwise": "If contained, check upload and archive extraction"
},
{
"id": "09-08",
"family": "09",
"if": "An XML parser receives external input",
"inspect": "Review external entity resolution, DTD, network/file access and parser features",
"positive": "If external entities are enabled, review XXE with isolated test data",
"otherwise": "If disabled, document parser posture"
},
{
"id": "09-09",
"family": "09",
"if": "A NoSQL/LDAP/search query uses user-supplied operators",
"inspect": "Check typed query building, operator allowlists and permissions",
"positive": "If input changes query structure, test injection safely",
"otherwise": "If constrained, verify nested variants"
},
{
"id": "09-10",
"family": "09",
"if": "An HTTP proxy and backend parse requests differently",
"inspect": "Review protocol versions, hop-by-hop headers, message framing and proxy patches",
"positive": "If desynchronization indicators exist, use approved non-disruptive specialist tests",
"otherwise": "If no evidence, avoid high-impact production probes"
},
{
"id": "09-11",
"family": "09",
"if": "User input affects logs or telemetry",
"inspect": "Check log injection, redaction, structured encoding, oversized entries and retention",
"positive": "If forged records or secrets possible, review SIEM trust",
"otherwise": "If safe, continue monitoring effectiveness"
},
{
"id": "09-12",
"family": "09",
"if": "An upload parser handles structured data",
"inspect": "Check MIME sniffing, content parsing, unsafe deserialization and archive extraction",
"positive": "If unexpected code/object execution possible, isolate test in sandbox",
"otherwise": "If safe, verify resource limits"
},
{
"id": "09-13",
"family": "09",
"if": "A response includes serialized user data",
"inspect": "Inspect output encoding per MIME type and client context",
"positive": "If data appears unsafely embedded in script/HTML, validate XSS",
"otherwise": "If safe, inspect unauthorized disclosure"
},
{
"id": "09-14",
"family": "09",
"if": "A sorting/filtering/query language exists",
"inspect": "Review expression parsing, cost bounds, parameterization and allowed operations",
"positive": "If unbounded or executable expressions exist, assess resource or injection risk",
"otherwise": "If constrained, measure denial-of-service resilience safely"
},
{
"id": "10-01",
"family": "10",
"if": "An /api route, API specification or network call exists",
"inspect": "Inventory method, path, parameters, authentication, version, data class and owner",
"positive": "If endpoint manipulates resources, run authorization and input branches",
"otherwise": "If read-only, still assess data visibility and rate limits"
},
{
"id": "10-02",
"family": "10",
"if": "A REST collection endpoint exists",
"inspect": "Review filters, pagination boundaries, sorting, export and rate limits",
"positive": "If it returns too much or another tenant's data, confirm with fixtures",
"otherwise": "If bounded, evaluate cache and availability"
},
{
"id": "10-03",
"family": "10",
"if": "GraphQL is used",
"inspect": "Inspect introspection policy, field-level auth, mutation auth, query complexity, batching and error data",
"positive": "If nested fields bypass controls, verify with test accounts",
"otherwise": "If protected, check recursion/complexity caps"
},
{
"id": "10-04",
"family": "10",
"if": "A gRPC service is present",
"inspect": "Review method authorization, transport security, reflection exposure and message validation",
"positive": "If methods are reachable without intended privilege, confirm scope-safe",
"otherwise": "If restricted, inspect server-to-server identity"
},
{
"id": "10-05",
"family": "10",
"if": "A WebSocket connection is established",
"inspect": "Review upgrade authentication, origin rules, per-message authorization and disconnect/revocation",
"positive": "If session expires but messages remain authorized, assess stale access",
"otherwise": "If revoked, inspect subscription scoping"
},
{
"id": "10-06",
"family": "10",
"if": "A webhook endpoint receives callbacks",
"inspect": "Verify signatures, replay protection, timestamps, idempotency and callback authorization",
"positive": "If unsigned/replayed requests alter state, confirm in sandbox",
"otherwise": "If secure, review asynchronous side effects"
},
{
"id": "10-07",
"family": "10",
"if": "An API has versioned routes",
"inspect": "Compare security controls across current, deprecated and beta versions",
"positive": "If older version bypasses fix, prioritize deprecation",
"otherwise": "If consistent, record covered versions"
},
{
"id": "10-08",
"family": "10",
"if": "An API accepts user-supplied properties",
"inspect": "Review field allowlists, nested data, ownership and object-level permissions",
"positive": "If mass assignment is possible, branch to authorization",
"otherwise": "If not, check business invariants"
},
{
"id": "10-09",
"family": "10",
"if": "Bulk operations or batched requests exist",
"inspect": "Review per-item authorization, maximum count, transaction semantics and rate accounting",
"positive": "If batch omits checks, test with fixtures",
"otherwise": "If enforced, measure resource bound"
},
{
"id": "10-10",
"family": "10",
"if": "An API returns errors or verbose schemas",
"inspect": "Assess whether stack traces, server version, internal IDs or private fields leak",
"positive": "If so, reduce disclosure without hiding useful errors",
"otherwise": "If not, test other failure modes"
},
{
"id": "10-11",
"family": "10",
"if": "An API calls third-party APIs",
"inspect": "Check outbound credentials, data transfer rules, callback verification and vendor trust",
"positive": "If third-party is out of scope, stop active exploration there",
"otherwise": "If permission provided, separately assess integration"
},
{
"id": "11-01",
"family": "11",
"if": "An application has a multi-step workflow",
"inspect": "Model state transitions, allowed actors, invariants and failure/retry states",
"positive": "If a step can be skipped or repeated, assess policy and data effects",
"otherwise": "If validated, test concurrency and rollback"
},
{
"id": "11-02",
"family": "11",
"if": "Money, credits, discounts or prices exist",
"inspect": "Identify server-authoritative values, rounding, idempotency, exchange/tax logic and approval limits",
"positive": "If client can set authoritative amount, confirm only in sandbox",
"otherwise": "If protected, test duplicated request accounting"
},
{
"id": "11-03",
"family": "11",
"if": "A purchase/payment/withdrawal endpoint exists",
"inspect": "Review duplicate submission, retries, gateway callbacks, reconciliation and partial failure",
"positive": "If repeated action has unintended effect, prioritize financial integrity",
"otherwise": "If idempotent, verify with controlled concurrent tests"
},
{
"id": "11-04",
"family": "11",
"if": "Inventory, quotas or resource allocations exist",
"inspect": "Review race conditions, atomic updates and overuse bounds",
"positive": "If concurrent requests violate invariant, confirm with non-production fixtures",
"otherwise": "If atomic, check distributed components"
},
{
"id": "11-05",
"family": "11",
"if": "An invite, referral, reward or coupon process exists",
"inspect": "Check entitlement, stacking, replay, self-referral and account lifecycle",
"positive": "If policy can be bypassed, quantify constrained impact",
"otherwise": "If enforced, document cases"
},
{
"id": "11-06",
"family": "11",
"if": "Approval or moderation flow exists",
"inspect": "Review maker-checker separation, state races, audit and policy override",
"positive": "If low privilege can self-approve, escalate",
"otherwise": "If controlled, test API vs UI parity"
},
{
"id": "11-07",
"family": "11",
"if": "Time-limited offers, tokens or resources exist",
"inspect": "Validate expiry at trusted server time, replay and timezone semantics",
"positive": "If expired object is accepted, assess access consequence",
"otherwise": "If enforced, test caches/queued jobs"
},
{
"id": "11-08",
"family": "11",
"if": "An order/export/delete job runs asynchronously",
"inspect": "Verify unique job identity, input permissions, status reporting, and final outcome reconciliation",
"positive": "If client success precedes durable operation, report misleading state",
"otherwise": "If transactional, test recovery"
},
{
"id": "11-09",
"family": "11",
"if": "A feature has business-specific rules",
"inspect": "Translate each policy into invariant and negative test",
"positive": "If any rule can be violated with authorized fixtures, document exact mechanism",
"otherwise": "If tests pass, record scope and versions, not absolute safety"
},
{
"id": "12-01",
"family": "12",
"if": "A page loads JavaScript from first or third party",
"inspect": "Identify dependencies, integrity controls, permissions, source maps and sensitive DOM access",
"positive": "If remote script is trusted broadly, review supply-chain and CSP exposure",
"otherwise": "If restricted, inspect update workflow"
},
{
"id": "12-02",
"family": "12",
"if": "A Content-Security-Policy header exists",
"inspect": "Evaluate script, object, frame, base, connect and reporting directives against app behavior",
"positive": "If dangerously permissive, map to actual XSS effects",
"otherwise": "If strict, inspect report collection and violations"
},
{
"id": "12-03",
"family": "12",
"if": "A page uses localStorage, IndexedDB or sessionStorage",
"inspect": "Classify stored tokens, PII and secrets; review XSS consequences",
"positive": "If sensitive data accessible to scripts, evaluate alternatives",
"otherwise": "If non-sensitive, confirm retention and logout cleanup"
},
{
"id": "12-04",
"family": "12",
"if": "A browser message event exists",
"inspect": "Verify event.origin, source, schema, and authorized target origin",
"positive": "If wildcard/unvalidated cross-origin messages change state, validate with fixtures",
"otherwise": "If allowlisted, review embedded frame trust"
},
{
"id": "12-05",
"family": "12",
"if": "A service worker or PWA exists",
"inspect": "Check cache scope, update, logout cleanup, response interception and stale versions",
"positive": "If private data persists across users, prioritize privacy",
"otherwise": "If isolated, verify offline error behavior"
},
{
"id": "12-06",
"family": "12",
"if": "An iframe or embedding flow exists",
"inspect": "Review sandbox, frame-ancestors and clickjacking exposure",
"positive": "If sensitive actions can be embedded by untrusted origins, assess UI redress",
"otherwise": "If blocked, test legitimate integrations"
},
{
"id": "12-07",
"family": "12",
"if": "DOM is updated using untrusted content",
"inspect": "Check dangerous HTML insertion, URL protocols, inline event execution",
"positive": "If browser executes attacker-supplied script, assess XSS",
"otherwise": "If safely rendered, keep inspecting server auth"
},
{
"id": "12-08",
"family": "12",
"if": "A page loads WebAssembly",
"inspect": "Review memory safety assumptions, host imports, permissions, untrusted inputs, resource exhaustion",
"positive": "If external data reaches sensitive native/runtime code, obtain specialist review",
"otherwise": "If sandboxed and bounded, close branch with evidence"
},
{
"id": "12-09",
"family": "12",
"if": "A browser extension or companion client is involved",
"inspect": "Review extension permissions, message passing, storage and update authenticity",
"positive": "If overly privileged, map information access blast radius",
"otherwise": "If restricted, inspect cross-origin sharing"
},
{
"id": "13-01",
"family": "13",
"if": "A user can upload a file",
"inspect": "Review authorization, allowed types, actual content signatures, limits, filename/path and scanning policy",
"positive": "If executable or dangerous content can become active, sandbox evaluation",
"otherwise": "If contained, test metadata and retrieval controls"
},
{
"id": "13-02",
"family": "13",
"if": "A user can download files or reports",
"inspect": "Check ownership, predictable identifiers, signed URL scope, expiry and caching",
"positive": "If other user files accessible, verify with controlled fixtures",
"otherwise": "If correctly protected, inspect link forwarding and revocation"
},
{
"id": "13-03",
"family": "13",
"if": "An archive, image, PDF or media parser is used",
"inspect": "Review patching, recursion, decompression limits and isolation",
"positive": "If untrusted content triggers parser error, test only in sandbox",
"otherwise": "If resilient, check resource limits and timeouts"
},
{
"id": "13-04",
"family": "13",
"if": "Object storage exists",
"inspect": "Review public access, IAM policies, origin bindings, presigned URLs, bucket/object policies and access logs",
"positive": "If public exposure unintended, escalate with minimal proof",
"otherwise": "If private, inspect delegated access and token lifetime"
},
{
"id": "13-05",
"family": "13",
"if": "A database holds sensitive records",
"inspect": "Review encryption, schema authorization, tenant separation, backups, audit and retention",
"positive": "If direct database access is not authorized, do not inspect contents",
"otherwise": "If approved, use fixtures and masked data"
},
{
"id": "13-06",
"family": "13",
"if": "A database backup, snapshot or export exists",
"inspect": "Check who can create, access, download, share and delete it",
"positive": "If backups are public or long-lived, prioritize data exposure",
"otherwise": "If protected, test restoration controls and retention"
},
{
"id": "13-07",
"family": "13",
"if": "Logs contain user input or credentials",
"inspect": "Review structured logging, redaction, access roles, retention and cross-tenant access",
"positive": "If secrets logged, redact evidence and rotate compromised tokens",
"otherwise": "If clean, test incident traceability"
},
{
"id": "13-08",
"family": "13",
"if": "A cache/CDN stores personalized content",
"inspect": "Inspect key separation, Cache-Control, Authorization/Cookie variation and purge",
"positive": "If cross-user cache leak confirmed, escalate",
"otherwise": "If private, verify stale logout and permission changes"
},
{
"id": "13-09",
"family": "13",
"if": "A dataset has classification/legal retention requirements",
"inspect": "Track collection purpose, consent, access, geography, deletion and subject rights",
"positive": "If inappropriate collection or retention, document privacy control issue",
"otherwise": "If compliant for scope, assess breach response and audit"
},
{
"id": "13-10",
"family": "13",
"if": "A search index or analytics pipeline copies data",
"inspect": "Map replication, secondary stores and access control equivalence",
"positive": "If data is accessible through weaker index, assess unintended exposure",
"otherwise": "If equivalent, inspect retention and deletion propagation"
},
{
"id": "14-01",
"family": "14",
"if": "Hosting is identified as AWS, Azure, GCP, or another cloud",
"inspect": "Map account/subscription/project ownership and allowed cloud-control-plane evidence",
"positive": "If owner grants access, review configuration and policies",
"otherwise": "Without credentials, external domain view cannot establish internal cloud IAM security"
},
{
"id": "14-02",
"family": "14",
"if": "A public cloud object store is found",
"inspect": "Review bucket ACL/policy, public access restrictions, presigned/SAS URLs and cross-account delegation",
"positive": "If unintended access, collect non-sensitive proof only",
"otherwise": "If intentionally public, assess permitted content and change control"
},
{
"id": "14-03",
"family": "14",
"if": "A compute instance, VM, or serverless function is used",
"inspect": "Check network identity, outbound restrictions, secrets, patching and execution role",
"positive": "If broadly privileged, model blast radius",
"otherwise": "If limited, review runtime and data access"
},
{
"id": "14-04",
"family": "14",
"if": "An IAM role, service principal, or workload identity exists",
"inspect": "Analyze trust policy, permissions, session duration, keys and resource conditions",
"positive": "If wildcards or cross-account trust excessive, tighten least privilege",
"otherwise": "If narrowly scoped, test revocation and policy drift"
},
{
"id": "14-05",
"family": "14",
"if": "A Kubernetes cluster is present",
"inspect": "Review API exposure, RBAC, namespaces, admission controls, pod security, secret handling and network policy",
"positive": "If cluster-admin access too broad, prioritize governance",
"otherwise": "If restricted, assess workload isolation"
},
{
"id": "14-06",
"family": "14",
"if": "A container image is deployed",
"inspect": "Check base image provenance, patch age, root user, file permissions and injected secrets",
"positive": "If vulnerable component is exploitable in context, open supply-chain finding",
"otherwise": "If clean, check runtime policies"
},
{
"id": "14-07",
"family": "14",
"if": "Cloud networking is configured",
"inspect": "Review security groups, firewalls, load balancers, private endpoints and origin protections",
"positive": "If sensitive backend public unexpectedly, review network exposure",
"otherwise": "If private, inspect lateral movement access controls with permission"
},
{
"id": "14-08",
"family": "14",
"if": "An infrastructure-as-code repository exists",
"inspect": "Compare declared policies and actual deployed state, secret hygiene and approvals",
"positive": "If drift permits unexpected exposure, investigate change process",
"otherwise": "If matched, review default configurations"
},
{
"id": "14-09",
"family": "14",
"if": "CI/CD uses cloud deployment credentials",
"inspect": "Check short-lived tokens, OIDC trust, secrets handling, environment separation and manual approvals",
"positive": "If build can deploy with broad production powers, minimize privilege",
"otherwise": "If restricted, inspect artifact signing and rollback"
},
{
"id": "14-10",
"family": "14",
"if": "A secret manager or KMS is used",
"inspect": "Review secret access policy, rotation, key use, auditing, encryption contexts and recovery",
"positive": "If workload shares broad secret access, evaluate blast radius",
"otherwise": "If restricted, test break-glass procedures"
},
{
"id": "14-11",
"family": "14",
"if": "A CDN/WAF fronts cloud workloads",
"inspect": "Confirm origin authentication, private connectivity and rule coverage across hosts",
"positive": "If bypass is observable, review config with owner",
"otherwise": "If covered, ensure APIs and admin paths use equal protections"
},
{
"id": "15-01",
"family": "15",
"if": "A framework/server/library is identified",
"inspect": "Inventory exact version and deployment context",
"positive": "If advisory applies, verify reachability and mitigation rather than trusting CVE match alone",
"otherwise": "If unsupported/EOL, evaluate maintenance risk separately"
},
{
"id": "15-02",
"family": "15",
"if": "A public or owner-provided repository exists",
"inspect": "Review secrets, dependencies, code ownership, protected branches and test coverage",
"positive": "If exposed credential found, rotate without using it",
"otherwise": "If clean, inspect CI and build output"
},
{
"id": "15-03",
"family": "15",
"if": "A manifest/lockfile exists",
"inspect": "Build dependency tree including transitive packages and sources",
"positive": "If vulnerable reachable package appears, prioritize vendor fix or mitigation",
"otherwise": "If not, continue provenance checks"
},
{
"id": "15-04",
"family": "15",
"if": "Packages are installed from registries or mirrors",
"inspect": "Review package provenance, pinned versions, integrity, typosquatting and build script trust",
"positive": "If untrusted source can change, assess compromise path",
"otherwise": "If controlled, inspect update policy"
},
{
"id": "15-05",
"family": "15",
"if": "A build/release pipeline exists",
"inspect": "Review triggers, required reviews, isolation, secrets, artifact immutability and environment approvals",
"positive": "If untrusted contributor can affect release, map threat",
"otherwise": "If protected, inspect emergency-release process"
},
{
"id": "15-06",
"family": "15",
"if": "An SBOM or artifact attestation exists",
"inspect": "Compare it to deployed reality and release signature",
"positive": "If mismatch, investigate tampering/configuration drift",
"otherwise": "If consistent, track through updates"
},
{
"id": "15-07",
"family": "15",
"if": "A public release contains source maps, debug endpoints or test credentials",
"inspect": "Determine intended disclosure and whether secrets/privileged capabilities are exposed",
"positive": "If actual secret, redact/rotate via owner process",
"otherwise": "If harmless source, avoid treating source visibility itself as exploit"
},
{
"id": "15-08",
"family": "15",
"if": "An auto-update mechanism exists",
"inspect": "Check signed updates, rollback prevention, channel separation and trust anchors",
"positive": "If update authenticity is not enforced, assess supply-chain impact",
"otherwise": "If signed, check key custody and revocation"
},
{
"id": "15-09",
"family": "15",
"if": "A third-party SaaS integration exists",
"inspect": "Map OAuth grants, SSO, webhooks, vendor data sharing, contractual boundaries",
"positive": "If unnecessary scope is granted, reduce permission",
"otherwise": "Do not probe vendor systems without permission"
},
{
"id": "16-01",
"family": "16",
"if": "A domain sends email",
"inspect": "Inventory SPF, DKIM, DMARC, provider alignment and legitimate sender inventory",
"positive": "If misaligned, review spoofing/deliverability impact",
"otherwise": "If aligned, inspect outbound credential security"
},
{
"id": "16-02",
"family": "16",
"if": "Inbound email services exist",
"inspect": "Review MX, TLS, account policy, anti-relay and mailbox security",
"positive": "If unauthenticated relay is suspected, use vendor-approved non-delivery test only",
"otherwise": "If protected, check phishing controls"
},
{
"id": "16-03",
"family": "16",
"if": "A support/contact form sends messages",
"inspect": "Review abuse limits, header injection protections, recipient restrictions and data handling",
"positive": "If arbitrary destination or unlimited sending, reduce abuse surface",
"otherwise": "If safe, test account notifications"
},
{
"id": "16-04",
"family": "16",
"if": "A mobile/SMS or push notification service exists",
"inspect": "Review callback signing, account binding, token expiry and delivery permissions",
"positive": "If notification can leak authentication data, investigate",
"otherwise": "If safe, document third-party dependency"
},
{
"id": "16-05",
"family": "16",
"if": "A third-party identity/payment/analytics script is embedded",
"inspect": "Map data shared across origins and compromise impact",
"positive": "If unnecessary data shared, reduce scope",
"otherwise": "If required, check consent/security controls"
},
{
"id": "16-06",
"family": "16",
"if": "An external domain is mentioned in config or page",
"inspect": "Classify it as asset, supplier, analytics, redirect or reference",
"positive": "If confirmed owned and in scope, enqueue as root",
"otherwise": "Otherwise stop active investigation at link boundary"
},
{
"id": "17-01",
"family": "17",
"if": "Security-relevant action occurs",
"inspect": "Verify logs capture actor, action, target, result and correlation identifiers without storing secrets",
"positive": "If missing, add audit coverage",
"otherwise": "If recorded, inspect access and retention"
},
{
"id": "17-02",
"family": "17",
"if": "Suspicious traffic or unusual account activity occurs",
"inspect": "Review detection rules, alert routing, triage owner and escalation SLAs",
"positive": "If no reliable alert, document monitoring gap",
"otherwise": "If detection works, assess false-positive burden and response"
},
{
"id": "17-03",
"family": "17",
"if": "An access credential or secret is compromised",
"inspect": "Review revocation, token/session invalidation, rotation and affected service tracing",
"positive": "If exposure spreads, invoke incident process",
"otherwise": "If contained, confirm restoration and forensic evidence"
},
{
"id": "17-04",
"family": "17",
"if": "An outage or denial-of-service risk exists",
"inspect": "Review rate limiting, queue bounds, circuit breakers, autoscaling and fail-closed semantics",
"positive": "If failure can cascade, propose containment test in staging",
"otherwise": "If resilient, test recovery/visibility"
},
{
"id": "17-05",
"family": "17",
"if": "Backups or disaster recovery are documented",
"inspect": "Verify isolation, restoration ability, credentials, integrity and recovery objectives",
"positive": "If restore untested, schedule non-production exercise",
"otherwise": "If successful, keep evidence and retention plan"
},
{
"id": "17-06",
"family": "17",
"if": "A security vulnerability is patched",
"inspect": "Retest original issue and adjacent functionality, including alternate URLs and versions",
"positive": "If issue recurs, reopen with causal trace",
"otherwise": "If resolved in tested scope, label verified and monitor regressions"
},
{
"id": "17-07",
"family": "17",
"if": "A privileged configuration change occurs",
"inspect": "Check approval, time, provenance, drift detection and alerting",
"positive": "If untracked, prioritize change governance",
"otherwise": "If tracked, verify rollback works"
},
{
"id": "18-01",
"family": "18",
"if": "A candidate weakness is observed",
"inspect": "Record affected asset, condition, reproduction evidence, scope, time, affected role, and observed outcome",
"positive": "If safely repeatable and within scope, test controls and impact",
"otherwise": "If unverified, explicitly retain hypothesis state"
},
{
"id": "18-02",
"family": "18",
"if": "A version matches a published CVE",
"inspect": "Confirm product identity, affected version/configuration, exposure, mitigations and reachability",
"positive": "If applicability validated, prioritize remediation using actual risk",
"otherwise": "If not, mark not applicable/unknown rather than confirmed"
},
{
"id": "18-03",
"family": "18",
"if": "A potential issue is reachable only after another issue",
"inspect": "Model prerequisite dependency as directed edge, not equal severity assertion",
"positive": "If full chain is verified within authorization, explain compound impact",
"otherwise": "If chain untested, keep hypothetical edge"
},
{
"id": "18-04",
"family": "18",
"if": "A finding has multiple possible root causes",
"inspect": "Record alternatives, choose safe discriminating tests and update confidence",
"positive": "If evidence isolates cause, recommend narrow correction",
"otherwise": "If not, avoid claiming root cause certainty"
},
{
"id": "18-05",
"family": "18",
"if": "A fix is proposed",
"inspect": "Name owner, exact control change, dependencies, rollback route and acceptance test",
"positive": "If change is deployed, run targeted and regression tests",
"otherwise": "If not yet verified, label proposed/implemented not resolved"
},
{
"id": "18-06",
"family": "18",
"if": "A test passes",
"inspect": "Record test identities, environment, version and conditions",
"positive": "If that single scenario passed, close that test only",
"otherwise": "Do not infer global safety across unseen branches"
},
{
"id": "18-07",
"family": "18",
"if": "All known in-scope assets and applicable tests have reached a disposition",
"inspect": "Report coverage percentages, exclusions, untested items and residual unknowns",
"positive": "If new evidence appears, reopen affected branches",
"otherwise": "Otherwise stop this run; never claim total knowledge of all possible assets"
},
{
"id": "18-08",
"family": "18",
"if": "A branch hits missing authorization, credentials, time, budget, or data",
"inspect": "Record exact blocker and needed evidence",
"positive": "If permissions/evidence later supplied, resume appropriate branch",
"otherwise": "Otherwise mark not tested; do not quietly treat as passed"
},
{
"id": "18-09",
"family": "18",
"if": "An asset has no new unresolved children after deduplication",
"inspect": "Mark local traversal complete at current time",
"positive": "If technology or configuration changes, revisit",
"otherwise": "Completion is versioned and conditional, not permanent"
}
];
