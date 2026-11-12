# 5. Frontend plan (Angular 22 + NexPrime + Signal Forms)

Phase 1 deliverables G (frontend changes), L (Signal Forms strategy) and N (NexPrime strategy).

## 5.1 Workspace decision: keep the single app

The master prompt sketches `projects/customer-app`, `restaurant-panel`, `delivery-app`, `admin-panel` and shared libraries. **Recommendation: keep the current single application.**

| | Single app (today) | Multi-project workspace |
|---|---|---|
| Code splitting | Already lazy per panel (`features/*/…routes.ts`). A customer never downloads admin code. | Same result |
| Shared auth, session, realtime, PWA | One instance. One login for users with several roles in testing. | Duplicated bootstraps, or libraries plus build configuration |
| Deployment | One SSR server, one service worker | Four builds, four service workers, cross-origin auth cookies |
| Cost to change | none | Large refactor with no user-visible benefit |

Revisit when native rider apps start (release 3). Even then, the rider app would likely be Capacitor wrapping the same routes.

Existing structure stays as it is: `core/` (auth, interceptors, services), `features/<area>`, `shared/` (components, forms, icons, list), `layout/`.

## 5.2 Changes required by the Django backend

| File or area | Change |
|---|---|
| `core/services/realtime.service.ts` | Replace `socket.io-client` with a native `WebSocket` client: auth frame, `ping`/`pong`, backoff reconnection (1, 2, 4… up to 30 s, with jitter), token refresh on close 4401, request-id acks for `track:join`, duplicate filtering by event `id`. **Keep the public API** (`orderUpdates$`, `inbox$`, `track(orderId)`, `sendRiderLocation()`) so feature code doesn't change. SSR: connect only in the browser. |
| `package.json` | Remove `socket.io-client` |
| Proxy config (`proxy.conf` / dev server) | `/api` → `:8000` and `/ws` → `ws://localhost:8000` with `ws: true` |
| `deploy/nginx.conf` | Add `location /ws/ { proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; … }`. Remove `/socket.io`. |
| Delivery panel | Arrival button, OTP entry before "Delivered", failure report dialog, KYC gate before going online |
| Customer order detail | Shows the OTP card during `picked_up`/`on_the_way`, the refunds list and a reorder button |
| Cart and food dialog | Variant selector, add-on groups with min/max, instructions. Lines addressed by `lineId`. |
| `core/models` / `Permission` type | Add `kyc:review`, `settings:manage`, `disputes:manage`, `incentives:manage`. Order status `arrived_at_restaurant`, payment status `partially_refunded`. |
| `order-status-chip`, labels in `checkout.models.ts` | Labels for the new statuses |

Old and new status values coexist safely: the frontend treats unknown statuses as "in progress", so a deploy order of backend first, then frontend is safe.

## 5.3 New screens

| Panel | Screen | Route |
|---|---|---|
| Auth | Phone login (number → OTP) | `/login/phone` (prerendered shell) |
| Auth | Verify email landing | `/verify-email` |
| Customer | Favourites | `/account/favourites` |
| Customer | Payment history | `/account/payments` |
| Restaurant | KYC and documents, bank account | `/restaurant/kyc` |
| Restaurant | Hours and holidays | `/restaurant/hours` |
| Restaurant | Add-on groups | `/restaurant/menu/addons` |
| Restaurant | Settlements and invoices | `/restaurant/settlements` |
| Rider | KYC and documents, bank account | `/delivery/kyc` |
| Rider | Payouts | `/delivery/payouts` |
| Admin | KYC review queue and document viewer | `/admin/kyc` (`kyc:review`) |
| Admin | Settings (pricing, dispatch, earnings, delivery, COD) with history | `/admin/settings` (`settings:manage`) |
| Admin | Commission rules | `/admin/finance/commission` (extend the existing page) |
| Admin | Reconciliation | `/admin/finance/reconciliation` |
| Admin | Banners, feature flags | `/admin/banners`, `/admin/flags` |
| Admin | Order: manual assign, partial refund, mark delivered | extend `/admin/orders/:id` |

## 5.4 Angular Material → NexPrime migration inventory

Material is imported in 107 non-spec files: admin 39, shared/components 16, restaurant-panel 9, orders 4, auth 4, support 3, delivery-panel 3, core/services 3, and 1 to 2 each in rewards, restaurants, food, errors, customer, checkout, shared/list, layout, profile and notifications.

| Material module | Files | Replacement | Notes |
|---|---|---|---|
| `button` (`mat-button`, `mat-flat-button`, `mat-icon-button`) | 88 | `np-button` | Mostly mechanical. A shared `bb-icon-button` wrapper is needed only if `np-button` has no icon-only variant (check its inputs first). Keep `type="submit"` behaviour for `[formRoot]` forms. |
| `dialog` (`MatDialog.open`, `MAT_DIALOG_DATA`, `MatDialogRef`) | 68 (23 dialog components, 14 openers) | **`@angular/cdk/dialog`** (`Dialog`, `DIALOG_DATA`, `DialogRef`) with the panel styled by NexPrime tokens. Content uses `np-card`/NexPrime controls. | NexPrime 0.1.5 has only template-driven `np-dialog`/`np-modal` and **no programmatic open service**. CDK is not Angular Material, so it satisfies the "no Material" rule while keeping `confirmed(dialog, data)` and the existing dialog components almost unchanged. Rider screens can use `np-bottom-sheet` where a sheet suits the mobile UX. |
| `paginator` | 26 | `np-pagination` | Wire it through `pagedList` (one place), so most pages change only their template |
| `progress-spinner` | 9 | `np-spinner` | |
| `progress-bar` | 4 | `np-progress-bar` | The page loader in `app.html` is eager. Keep it as plain CSS to stay out of the eager bundle (PWA rule). |
| `menu` | 6 | `np-menu` / `[npMenuPopover]` | |
| `button-toggle` | 5 | `np-button-toggle` | |
| `tabs` | 3 | `np-tabs` | |
| `tooltip` | 2 | `np-tooltip` | |
| `chips` | 2 | `np-chip` / `np-tag` | |
| `table` | 1 | `np-table` | |
| `snack-bar` | 1 (`NotificationService`) | `np-toast` hosted once in the shell, with `NotificationService` keeping its API | |
| `radio` | 1 | `np-radio-group` | |
| `divider`, `list`, `toolbar` | 2, 1, 1 | Plain semantic HTML + SCSS (`<hr>`, `<ul>`, `<header>`) or `np-header` | |
| `sidenav` | 1 (`panel-shell`) | CDK `Overlay`/a custom drawer in `panel-shell` | Check the NexPrime layout components first. Otherwise use a small custom drawer with focus trap (`cdkTrapFocus`) and Escape to close. |

**Method**
1. Build replacement wrappers in `shared/` only where a pattern repeats (the dialog service facade `BbDialog`, the toast host).
2. Migrate panel by panel: customer and rider (MVP), then restaurant and admin (release 2). Each step:
   - grep for remaining `@angular/material` in that folder must be 0;
   - its unit tests pass;
   - a headless Playwright screenshot check runs at 390 px and 1280 px.
3. When the count reaches 0: remove `@angular/material` from `package.json` and Material theme SCSS from `styles.scss`, then check the bundle-size budget.
4. Before using any NexPrime component, read its inputs and outputs in `node_modules/nexprime/types/nexprime.d.ts`. Do not guess selectors or inputs.

## 5.5 NexPrime strategy

- **Version:** `nexprime@0.1.5`, with its Angular peers pinned by `overrides` (already in place). It is a 0.x package, so pin the exact version and upgrade deliberately with the screenshot suite.
- **Theme:** import `nexprime/styles/theme.css` once in `styles.scss` (if not already). Map the `--ui-*` tokens to the `--bb-*` brand tokens (today's approach).
- **Dark mode:**
  - Add a dark token set under `[data-theme="dark"]` for both `--bb-*` and `--ui-*`.
  - A `ThemeService` (`core/services/theme.service.ts`) resolves the theme from the stored preference, falling back to `prefers-color-scheme`, and sets `data-theme` on `<html>` (browser only).
  - An inline script in `index.html` sets the attribute before first paint to avoid a flash and layout shift.
  - Update `color-scheme: light` to `color-scheme: light dark`.
  - Leaflet tiles: optionally use a dark tile style or a CSS filter on the tile pane.
- **Bundle rule (unchanged):** NexPrime does not tree-shake (about 270 kB). Never import it from `app.ts`, eager routes or root services. Wrappers live in lazy feature or shared chunks only.
- **Icons:** keep `<np-icon>` + the `npIcon` pipe convention.
- **Gaps:** where NexPrime lacks a component (programmatic dialog, drawer), use `@angular/cdk` primitives + SCSS. Document each gap in `docs/DOCUMENTATION.md §7`.

## 5.6 Signal Forms strategy

The project already follows the target pattern: `form(model, schema, { submission: { action } })`, `[formRoot]`, `[formField]`, `NP_FORM_FIELDS`, `shownError()`, `serverErrors()`. New forms follow the same rules.

| Need | Approach |
|---|---|
| Reusable rules | Add to `shared/forms/form-rules.ts`: `indianMobile()`, `otpCode(len)`, `gstin()` (format + checksum), `fssai()`, `ifsc()`, `accountNumber()`, `futureDate()`, `timeRange(open, close)` |
| Cross-field | Schema-level `validate()` with the error attached to the relevant field: password confirmation (exists), `closesAt ≠ opensAt`, non-overlapping hour slots, `minSelect ≤ maxSelect`, account number confirmation, coupon `validFrom < validUntil` |
| Dynamic fields (variants, add-ons, hour slots) | The model holds arrays (`variants: Variant[]`). Use `applyEach(path.variants, variantSchema)` for per-item rules. The UI renders with `@for (v of f.variants; track $index)`. Add and remove by updating the model signal immutably. |
| Variant and add-on choice in the food dialog | A small form whose schema is built from the item's add-on groups: one array field per group, with a `validate()` enforcing that the count is between min and max. Errors show under each group. |
| OTP input | `np-input-otp` bound to a single string field (if it supports `[formField]`; otherwise a tiny adapter directive implementing `FormValueControl<string>`). Auto-submit when complete. The resend button has a countdown `signal`. |
| File uploads (KYC) | Upload outside the form via `UploadService` with progress. The form stores only the returned document id or status, and its validity requires each required document to be uploaded. |
| Async rules (e.g. GSTIN already used) | Validate on the server and surface it with `serverErrors()`. No client-side async uniqueness checks. |
| Submission state | `form().submitting()` disables the button and shows `np-spinner`. Errors from 422 responses are mapped with `serverErrors()`, and others with the toast. |
| Tests | Vitest specs per form: required, format, cross-field, dynamic add/remove, server error mapping. No Reactive Forms anywhere, including test helpers. |

Rule: never use `FormGroup`, `FormControl`, `FormBuilder`, `FormArray` or `ReactiveFormsModule`. Add an ESLint `no-restricted-imports` rule on `@angular/forms` for those symbols, and on `@angular/material` once the migration finishes.

## 5.7 Frontend testing additions

- Specs for the WebSocket client using a fake socket: auth frame, reconnect, 4401 refresh, ack timeout, duplicate drop.
- Guard and interceptor specs exist. Extend them with the new permissions.
- Playwright E2E (throwaway Django API with a test database, per CLAUDE.md): order flow end to end through all four panels, delivery OTP, partial refund, reassignment.
