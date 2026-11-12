# BiteBox troubleshooting guide

Problems you may hit while developing, testing or deploying BiteBox, and how to fix them.
Each entry is **symptom → cause → fix**. Start with the health checks:

- API: `GET /api/v1/health` → `{"status":"ok","database":"connected"}`
- Web (production build): `GET /healthz` → `{"status":"ok"}`
- API logs are JSON (pino); every request has an id, and errors are logged with their stack.

---

## Setup and configuration

| Symptom | Cause | Fix |
|---|---|---|
| API exits with `Missing required environment variable` or `JWT_SECRET must be at least 32 characters` | `backend/.env` is missing or incomplete | Copy `backend/.env.example` to `.env` and fill it in. Generate a secret with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `Could not connect to MongoDB` | Wrong `MONGO_URI`, or Atlas blocks your IP | Check the URI. On Atlas, add your IP under *Network Access*. |
| A change in `backend/.env` has no effect | nodemon only watches `src/` | Type `rs` in the nodemon terminal (or restart `npm run dev`). |
| Browser console shows CORS errors | The page's origin isn't allowed | Add the exact origin (scheme, host and port) to `CLIENT_URL` and restart the API. |
| Signed out after every reload | The refresh cookie isn't stored or sent | Use `http://localhost:4200`, not `127.0.0.1` (the app and API must be same-site). In production the cookie is `Secure`: serve the site over **HTTPS** (localhost is exempt). For different sites, set `COOKIE_SAMESITE=none` (HTTPS only). |
| `429 Too many attempts` | Auth endpoints are rate-limited (20 per 15 min per IP) | Wait, or restart the API in development. Behind a proxy, set `TRUST_PROXY=1` so limits use the real client IP. |

## Frontend development

| Symptom | Cause | Fix |
|---|---|---|
| `ng serve` stays on **"Building..."** (or `Tried writing to closed dispatcher`) | The native Dart Sass process gets killed on some machines | Use `npm start` / `npm run build` (they set `NG_BUILD_SASS_EMBEDDED=0`), or `export NG_BUILD_SASS_EMBEDDED=0` in your shell profile. |
| `ERR_OUTDATED_OPTIMIZED_DEP`, `There is a new version of the pre-bundle`, or `AbortError: Request … was aborted` | Vite re-bundled its dependencies after a new package was installed, while pages were loading | Harmless and one-time. If it persists: stop the dev server, `rm -rf frontend/.angular/cache`, `npm start`. |
| Map shows no pins or zoom buttons | Leaflet's CSS isn't loaded (the dev server reads `angular.json` only at start) | Restart `npm start`. |
| An icon is blank | The NexPrime icon name doesn't exist | Use a file name from `node_modules/nexprime/icons` (e.g. `chef-hat`). Material names in data go through `| npIcon` (`shared/icons/np-icon-name.ts`). |

## Tests

| Symptom | Cause | Fix |
|---|---|---|
| Backend tests fail with `Instance closed unexpectedly` / `mongod` killed | The in-memory MongoDB can't start in this environment | Run against a real database: `TEST_MONGO_URI='mongodb://127.0.0.1:27017/bitebox_test' npm test`. The name **must end in `_test`** (the tests wipe it). |
| `documents every API route in OpenAPI` fails | A route was added or changed without updating the docs | Add it to the matching `backend/docs/openapi.*.js` file (the test lists what's missing). |

## Orders, riders and maps

| Symptom | Cause | Fix |
|---|---|---|
| New orders become "rejected" | The restaurant didn't answer within 10 minutes | Expected. Tune `restaurantResponseMinutes` in `backend/config/dispatch.js`. |
| Ready orders become "cancelled" | No rider picked them up within 30 minutes | Expected (paid orders are refunded). Tune `pickupWindowMinutes`. |
| A rider gets no delivery requests | The rider must be online, with a vehicle and a location under 15 minutes old, within 10 km of the restaurant | Check `/admin/delivery-partners`. A rider who ignores an offer is set offline. |
| "Can't pinpoint where you are" when going online | The device location is vaguer than 1 km (desktops) | Use a phone with GPS, or Chrome DevTools → Sensors. |
| The rider marker doesn't move | No accurate fix, or jumps faster than ~250 km/h are rejected | The rider dashboard shows the reason. Move in small steps when simulating. |
| Map shows a dashed straight line instead of a road | The routing provider (OSRM) is unreachable (`503 ROUTING_UNAVAILABLE`) | Check `ROUTING_URL`. The public demo server is best-effort; self-host OSRM for production. |
| "Current location" is kilometres off | Laptops guess location from Wi-Fi/IP | Search for the area or drag the pin. |

## Payments, images and email

| Symptom | Cause | Fix |
|---|---|---|
| Checkout opens the **test payment** page instead of Razorpay | Razorpay keys aren't set | Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (test keys start with `rzp_test_`), restart the API. |
| Online payments stay "Awaiting payment" after paying | The browser closed before confirming, and no webhook is configured | Add a Razorpay webhook to `https://<your-domain>/api/v1/payments/webhooks/razorpay` (events `payment.captured`, `payment.authorized`, `payment.failed`) and set `RAZORPAY_WEBHOOK_SECRET`. Unpaid orders are cancelled after 15 minutes. |
| A refund shows "Refund failed" | The gateway refused or was unreachable | Admin → **Payments** → **Retry refund**. |
| "Could not upload the image right now" | Cloudinary refused the upload | Check the API log. `missing permissions (actions=["create"])` means the API key has no upload rights: give it upload permission in Cloudinary → Settings → API Keys, or create a new key. |
| No password-reset email arrives | SMTP isn't configured | In development the link is printed in the API console. In production set `SMTP_*` and `EMAIL_FROM`. |

## Production deployment

| Symptom | Cause | Fix |
|---|---|---|
| Every page returns `400 … Header "host" … is not allowed` | Angular's SSRF protection only allows listed hosts | Set `NG_ALLOWED_HOSTS=your.domain` for the web server (`PUBLIC_HOST` in `deploy/.env` with docker-compose). |
| The home page renders without food categories (they appear after a moment) | Server rendering can't reach the API | Set `API_INTERNAL_URL` for the web server to an address it can reach (docker-compose: `http://api:5000`). |
| Live updates don't arrive (orders only refresh every minute) | The proxy doesn't pass WebSocket upgrades for `/socket.io/` | Use the `location /socket.io/` block from `deploy/nginx.conf` (`Upgrade` / `Connection` headers, long read timeout). |
| `Transaction numbers are only allowed on a replica set` warnings, or set `DISABLE_TRANSACTIONS` | MongoDB isn't a replica set | Atlas is one already. Self-hosted: run `mongod --replSet rs0` and `rs.initiate()` (docker-compose does this). Without it the API still works using its undo fallback. |
| Uploaded images vanish after a redeploy | Images were stored on the container's disk | Configure Cloudinary, or mount a volume at `/app/uploads` (docker-compose does). |
| The test payment option is missing in production | By design | The simulated provider is never enabled when `NODE_ENV=production`. |
| No "Install" option, and DevTools > Application shows no service worker | Development server, or not HTTPS | The service worker is registered in production builds only (`npm run build`, then `npm run serve:ssr:frontend`), and only on HTTPS or `localhost`. |
| Visitors keep seeing an old version after a deploy | `ngsw-worker.js` / `ngsw.json` cached by a proxy or CDN | Serve them (and `manifest.webmanifest`) with `Cache-Control: no-cache`. The SSR server, `vercel.json` and `public/_headers` do; add the same rule to any CDN in front. Users then get the "New version available" card. |
| A deploy breaks the app for installed users until they clear site data | Emergency: a broken service worker | Copy `safety-worker.js` over `ngsw-worker.js` in the deployed files: it unregisters the worker and reloads clients. Redeploy normally afterwards. |
| "Push notifications aren't available right now" | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` not set on the API | Generate a pair once (`npx web-push generate-vapid-keys` in `backend/`) and set both. Never change them casually: every existing subscription stops working. |
| Subscribing fails with "This browser's push service is not supported" | The browser's push endpoint host isn't in `PUSH_ALLOWED_HOSTS` | Add the push service's host (suffix) to `PUSH_ALLOWED_HOSTS` on the API. |
| Push works on Android/desktop but not on iPhone | iOS only allows push in Home Screen apps (iOS 16.4+) | Add BiteBox to the Home Screen from Safari's Share menu, open it from there and turn notifications on. |
| `npm audit` reports `quill` (low) | Pulled in by NexPrime's rich-text editor, which BiteBox doesn't use | Not reachable in the app. It goes away when NexPrime updates its dependency. |
