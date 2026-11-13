# Security audit (Phase 16)

Audit of the Django API (`backend-django/`), the Node API (`backend/`) and the Angular app (`frontend/`), done on 13 November 2026 against the security plan in [django-migration/07-risks-and-security.md](django-migration/07-risks-and-security.md) (§7.3 controls, §7.4 testing plan).

## How to rerun it

| Check | Command | Runs in CI |
|---|---|---|
| Access-control matrix (every role × every endpoint) | Django `pytest tests/test_access_control.py`; Node `node --test tests/security-access.test.js` | Yes |
| Tokens, IDOR, data exposure, headers, uploads, CSV, logs | Django `pytest tests/test_security.py`; Node `node --test tests/security.test.js` | Yes |
| Hostile query parameters on every GET route | Django `pytest tests/test_input_fuzzing.py`; Node `tests/security.test.js` | Yes |
| Python static analysis (bandit rules) | `ruff check .` (rule set `S`) | Yes |
| Dependencies | `pip-audit -r requirements/base.txt -r requirements/prod.txt`; `npm audit --omit=dev --audit-level=moderate` in `backend/` and `frontend/` | Yes |
| Django production settings | `manage.py check --deploy --fail-level WARNING` | Yes |
| Auth interceptor (token only to the API, cookies only to `/auth`, one refresh) | `frontend/src/app/core/interceptors/auth.interceptor.spec.ts` | Yes |

The matrix tests read each route's own guards (Django permission classes; Node `authenticate`, `authorize(...)`, `can(...)`) and call the API as every role: a role without access must get 403 and an anonymous caller 401. The routes anyone may call are listed in `PUBLIC` in both test files, so a new public endpoint is always a deliberate change.

## Findings

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | `backend-django/.gitignore` had `uploads/`, which also matched the source app `apps/uploads`: the image upload code was never committed, so a clean checkout or CI build would not start. It was also skipped by ruff. | Pattern anchored to `/uploads/` (the local image folder). `apps/uploads` now appears as new files to commit. |
| 2 | High | Django: the default DRF permission was `AllowAny`, so a view that forgot `permission_classes` was public. | Deny by default (`IsSignedIn`); the 21 public views say `permission_classes = PUBLIC`. |
| 3 | Medium | Review and menu photos were stored with their EXIF data: phone photos carry GPS position, device and time, and review photos are public. | Both APIs strip metadata before storing (`apps/uploads/metadata.py`, `utils/image-metadata.js`), keeping only the JPEG orientation. Malformed files are refused (415). |
| 4 | Medium | Settlements CSV: a partner-chosen restaurant name such as `=HYPERLINK(...)` ran as a formula when finance opened the file. | Text starting with `= + - @`, tab or CR gets a leading `'` (`spreadsheet_safe` / `spreadsheetSafe`). |
| 5 | Medium | The SSR web server sent no Content-Security-Policy (the plan said it did). | Per-request nonce: `script-src 'nonce-…' 'strict-dynamic'`, plus `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'` (`frontend/src/server.ts`; placeholders in `index.html`). Checked in a browser on server-rendered, prerendered and client-rendered pages: no violations. |
| 6 | Medium | Node: a NUL character in a search box (e.g. `?search=a%00b`) caused a 500 on 16 endpoints, 2 of them public (MongoDB refuses NUL in regular expressions). | Requests with NUL in the query or JSON body get 400 (`middleware/security.middleware.js`). |
| 7 | Low | Django: geo search answered 500 instead of 503 when the map service was down, because user text went into the cache key. | Upstream cache keys are hashed (`apps/geo/upstream.py`). |
| 8 | Low | Django: rider tokens were accepted on `/my/restaurant/payouts` and restaurant tokens on `/delivery/payouts` (each still saw only their own data). | Each prefix is limited to its own role, as in Node. |
| 9 | Low | Django logs had no redaction; Node redacted only some fields. | Django `common/log_redaction.py` (tokens, JWTs, `password=`, `otp`… in messages and tracebacks); Node also redacts `accessToken`, `otp`, `secret`, `accountNumber`. |
| 10 | Low | Django tests could call the real Nominatim service. | A root `conftest.py` fixture blocks upstream calls unless a test fakes them. |

## Verified, no change needed

- Access tokens: HS256 only (`none` and other algorithms refused), issuer, audience and expiry checked, role read from the database, old tokens dead after a password change or suspension (`tokenVersion`).
- Every route that takes an id was called with another customer's, restaurant's or rider's id by each partner role: all answered 403/404 and nothing changed.
- No response carries a password hash, token version or refresh token. API responses send `nosniff` and a frame policy.
- MongoDB operators in JSON bodies (`{"$gt": ""}`) are stripped or rejected; Express 5 does not turn `search[$ne]=` into an object.
- Uploads: type from the bytes, 2 MB limit (3 MB at nginx), random names, `nosniff`, local files served only by a strict name pattern.
- The Angular app has no `innerHTML`, `bypassSecurityTrust…` or `eval`.
- Django `check --deploy` passes (HSTS preload is off on purpose until HTTPS is stable everywhere).
- bandit findings (via ruff `S`): five, all reviewed false positives (URL opens with fixed http(s) bases, a bound SQL parameter with a constant table name, a revoke reason named `password-change`).

## Accepted risks

| Risk | Why accepted | Revisit |
|---|---|---|
| `quill` 2.0.3 (low, XSS in its HTML export), pulled in by NexPrime | BiteBox never uses the editor or `getSemanticHTML`; no fixed Quill release exists | When Quill or NexPrime ships a fix |
| Static HTML served by the service worker or `express.static` gets the CSP without a nonce (no `script-src` limit) | The service worker caches `index.csr.html`; server-rendered and prerendered pages are protected | With a hash-based policy for the CSR shell |
| `GET /api/docs` (Swagger) is public in both APIs | Lists routes only; every route enforces its own access | Hide in production if wanted |

## Not covered in this phase

- OWASP ZAP baseline scan, which needs the staging environment (Phase 17).
- Load tests (checkout, dispatch, WebSockets) and query plans (Phase 19).
- Field encryption for bank account and document numbers, and OTP controls: those features do not exist yet (restaurant KYC, OTP login).
- Secret scanning of the git history (gitleaks is not installed here; add it to CI with the deployment work).
