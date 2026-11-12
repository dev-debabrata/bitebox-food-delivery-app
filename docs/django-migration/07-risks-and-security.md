# 7. Risk assessment and security plan

Phase 1 deliverable J.

## 7.1 Risks

Likelihood (L) and impact (I): H = high, M = medium, L = low.

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | **Behaviour drift** between the Node and Django backends (subtle rules in pricing, dispatch, coins) | H | H | Port the ~350 Node tests first and treat them as the acceptance gate. Golden tests that compare cart quotes and settlements for a fixed set of fixtures run against both backends. |
| R2 | **Socket.IO → WebSocket** breaks live updates (reconnects, auth expiry, proxies) | M | H | Keep the client's public API. Fake-socket unit tests. nginx `Upgrade` config tested in staging. The REST polling fallback (`liveRefresh`) already covers gaps. |
| R3 | **Data migration** loses or corrupts money or ledger data | M | H | Dry-run on copies, count and sum verification, idempotent re-runs, keep MongoDB read-only for 30 days after cut-over. If there is no production data (Q1), the risk drops to low. |
| R4 | **Race conditions** in PostgreSQL that MongoDB patterns hid (CAS on embedded fields) | M | H | Conditional `UPDATE … WHERE` + `select_for_update`, unique partial indexes for "one live assignment" and "one default address", and threaded concurrency tests with `transaction=True`. |
| R5 | **NexPrime 0.x** gaps or breaking changes; no programmatic dialog | H | M | CDK Dialog facade, exact version pin, screenshot suite on upgrade, wrappers isolating NexPrime APIs in `shared/`. |
| R6 | **Public OSM services** throttle or ban production traffic | H | M | Self-host or contract providers before launch. Cache, merge identical requests and rate-limit. UI degrades to straight-line distance. |
| R7 | **SMS OTP** delayed by DLT registration (India) | H | M | OTP login is in release 2. Email + password stays available. Console adapter in development. |
| R8 | **Scope size** (24 weeks) vs. expectations | M | H | MVP-first ordering. Each phase is shippable and approved separately. Node remains production until cut-over. |
| R9 | **Dual running** confusion (two APIs, two databases) | M | M | Only one is ever the source of truth. Staging runs Django only. Production switch-over is a single, reversible nginx change. |
| R10 | **Vercel backend deploy** can't run sweeps or sockets today (and can't for Django either) | H | M | Document the Docker or VM deployment as the only supported backend target. Remove `backend/vercel.json` at cut-over. |
| R11 | **Legal/compliance** assumptions (GST on commissions and food, DPDP consent, FSSAI listing rules) | M | H | Flagged for professional review before launch. Rules are configurable (tax basis points, invoice series). |
| R12 | **Argon2 vs. imported bcrypt hashes** | L | M | Django bcrypt hasher as a fallback, re-hash on login, test with real hash fixtures generated from the Node seed. |

## 7.2 Rollback strategy

1. Cut-over is an nginx upstream change from `api-node` to `api-django`, plus the frontend build that speaks native WebSocket.
2. The frontend build is backwards-compatible for one release: the realtime client falls back to polling if `/ws/` is unavailable, so the new frontend can run against Node.
3. If Django fails within the rollback window (7 days): switch nginx back. **Data written to PostgreSQL after cut-over must be replayed to MongoDB.** To keep that feasible, the cut-over happens in a low-traffic window, and a `export_since --to-mongo` command is built and tested in phase 14. If that's judged too costly, the rollback window is limited to the first hours, and the decision point is documented in the runbook.
4. Database migrations are forward-only. Every release is tested to run against the previous release's schema (expand → migrate → contract), so the application can be rolled back without rolling back the schema.

## 7.3 Security plan

| Area | Control | Verified by |
|---|---|---|
| Passwords | Argon2id (Django `Argon2PasswordHasher` first), `AUTH_PASSWORD_VALIDATORS` (min 8, common, similarity), bcrypt verify-only | Unit tests |
| Tokens | Access JWT 15 min (HS256 with a 32+ byte key, `iss`/`aud`/`ver` claims). Refresh: random 256-bit token in an HttpOnly Secure cookie, scoped to `/api/v1/auth`, stored hashed, rotated each use. Reuse revokes the family. `token_version` checked every request. | Ported auth tests + reuse test |
| CSRF | Refresh and logout need `X-Requested-With: BiteBox` + an Origin check (today's rule). Other endpoints use bearer tokens, so they are not CSRF-prone. Django CSRF stays enabled for Django admin. | Tests |
| OTP | 6 digits from `secrets`, HMAC-hashed, 5 min expiry, 5 attempts, 30 s resend cooldown, 5 per hour per destination, 20 per hour per IP, identical responses for unknown numbers | Tests |
| Authorization | Role + permission classes on every view (a test enumerates all URL patterns and fails if a non-public view has no explicit permission). Object scope always from `request.user` in selectors. Role-specific output serializers (no customer phone for restaurants; address only while the rider carries the order). | Access-control matrix test (every role × every endpoint) |
| Input | DRF serializers with explicit fields (`extra fields ignored`), max lengths, numeric bounds. ORM only. Raw SQL only for PostGIS expressions with parameters. | Lint rule banning `.raw(`/`extra(` without review |
| Output / XSS | JSON API only. Angular escapes by default. User HTML is never rendered. Email templates autoescape. CSV export guard against formula injection. | Tests |
| Uploads | Magic-byte type check, size limits, Pillow re-encode for images (strips EXIF/GPS), random keys, private bucket + 5-minute signed URLs for KYC and invoices, content-disposition attachment for documents | Tests |
| Sensitive data | Bank account and document numbers encrypted at the field level (key in a secret manager, rotation supported). Only last-4 shown. Logs scrub `password`, `token`, `otp`, `accountNumber`, `authorization`. | Log scrub test |
| Payments | Signature verified on confirm and webhook (raw body, constant-time compare). Amount and currency taken from the DB, not the client. Unique webhook event ids. Refunds capped at paid minus refunded. No card data handled. Mock provider refused when `ENV=production`. | Payment tests |
| Rate limiting | DRF throttles in Redis + nginx `limit_req` on `/api/v1/auth` and `/ws/` | Tests |
| Transport and headers | HTTPS only, HSTS (preload after stable), `SECURE_*` settings, CSP on the SSR server (existing), CORS allow-list only, `X-Frame-Options DENY` | `manage.py check --deploy` in CI |
| SSRF | Push endpoints restricted to `PUSH_ALLOWED_HOSTS` (existing). Geo adapters only call configured base URLs. No user-supplied URLs are fetched. | Tests |
| WebSockets | Auth frame within 5 s, origin check (`AllowedHostsOriginValidator`), per-connection message rate limit, group membership only via server-side checks, location only to authorised viewers | Consumer tests |
| Secrets | Environment or secret manager only. `.env.example` without values. Never printed (CLAUDE.md rule). Separate keys per environment. | `gitleaks` in CI |
| Dependencies | `pip-audit`, `npm audit --omit=dev`, Dependabot, pinned versions | CI |
| Audit | Every admin write audited (`@audited`). KYC document views audited. Settings changes versioned. Login history kept. | Tests |
| Session revocation | Suspension or password change bumps `token_version` and revokes sessions. WebSocket connections of that user are closed (via the group `user.<id>` → `force_logout`). | Tests |
| Backups | Managed PostgreSQL PITR + nightly logical dump to separate-account object storage (encrypted), 30-day retention. Monthly restore drill, timed against the RTO. | Runbook + drill log |
| Monitoring | Sentry (backend, frontend, Celery) with PII scrubbing, Prometheus metrics (request latency, Celery queue depth, WS connections, dispatch wait time), Grafana alerts (5xx rate, queue backlog, sweep lag, webhook failures) | Staging alert test |

## 7.4 Security testing plan (phase 15)

- Automated: access-control matrix, IDOR tests (customer A reading B's order, address, ticket; restaurant reading another restaurant's orders; rider reading an order not assigned), injection payloads on search and filter parameters, rate-limit tests, JWT tampering (alg none, wrong key, old `ver`), webhook signature forgery, oversize and polyglot uploads.
- Tools: OWASP ZAP baseline scan against staging, `bandit` on Python, `npm audit`, `pip-audit`, `gitleaks`.
- Manual: threat-model review of payments, dispatch, KYC document access and WebSocket rooms. Findings tracked to closure before production.
