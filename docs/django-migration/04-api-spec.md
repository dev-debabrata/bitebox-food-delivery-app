# 4. API specification

Phase 1 deliverable F.

- **Base:** `/api/v1`.
- **Envelope:** `{ "success": true, "message": "…", "data": … }`. Errors: `{ "success": false, "message": "…", "error": { "code": "…", "details": [ { "field": "a.b", "message": "…" } ] } }` (`details` only on 422). This is the Node shape, checked in Phase 3.
- **Auth:** `Authorization: Bearer <access>`. The refresh cookie `bb_refresh` (HttpOnly, Secure in production, SameSite=Strict, Path=`/api/v1/auth`), as in Node.
- **JSON** is camelCase. Money is in paise (integers). Times are ISO 8601 UTC.
- **Lists:** `?page=1&limit=20` (clamped, maximum 100) returns `{ items, pagination: { page, limit, total, totalPages } }`.

## 4.1 Existing endpoints: unchanged contract

Every endpoint in [DOCUMENTATION.md §14](../DOCUMENTATION.md#14-api-reference) is reimplemented with **the same method, path, access rule, request and response shape**. The table shows which Django app owns each group. The parity test suite (ported from `backend/tests`) is the acceptance check.

| Path group | Django app | Notes on the port |
|---|---|---|
| `/health` | `common` | Adds `redis` and `celery` checks. `/health/live` and `/health/ready` added for orchestrators. |
| `/auth/*` | `accounts` | Same refresh-cookie and `X-Requested-With: BiteBox` CSRF header rule on refresh/logout |
| `/admin/users`, `/admin/admins`, `/admin/audit-logs` | `accounts`, `rbac`, `audit` | |
| `/restaurants*`, `/categories`, `/foods*` | `restaurants`, `menus` | Search uses PostGIS + `pg_trgm` |
| `/my/restaurant*` | `restaurants`, `menus`, `orders` | Scope from `request.user` |
| `/admin/restaurants*`, `/admin/categories*`, `/admin/foods*`, `/admin/coupons*` | same | |
| `/uploads/images`, `/uploads/review-images` | `uploads` | Magic-byte check (`filetype`/`python-magic`), 2 MB limit, re-encoded with Pillow to strip metadata |
| `/geo/search`, `/geo/reverse`, `/geo/route` | `geo` | |
| `/cart*`, `/addresses*`, `/coupons/available` | `cart`, `customers`, `coupons` | See 4.3 for the cart line change |
| `/orders*` | `orders` | |
| `/my/restaurant/orders*`, `/my/restaurant/earnings` | `orders`, `finance` | |
| `/delivery/*` | `delivery`, `dispatch`, `tracking`, `finance` | `PATCH /delivery/orders/{id}/status` also accepts `arrived_at_restaurant` and requires `otp` for `delivered` (4.3) |
| `/admin/orders*`, `/admin/delivery-partners*`, `/admin/payments*`, `/admin/reports` | `orders`, `delivery`, `payments`, `analytics` | |
| `/payments/*` | `payments` | Webhook view is `csrf_exempt`, reads `request.body` raw, verifies the HMAC before parsing |
| `/admin/operations/*`, `/admin/finance/*`, `/admin/support/*`, `/support/tickets*` | `analytics`, `finance`, `support` | |
| `/reviews*`, `/orders/{id}/reviews`, `/my/restaurant/reviews*`, `/delivery/reviews`, `/admin/reviews*` | `reviews` | |
| `/coins/*`, `/referrals/*`, `/rewards*`, `/admin/rewards/*` | `coins` | |
| `/notifications*`, `/push/*`, `/admin/push/promotions`, `/newsletter/subscriptions` | `notifications`, `newsletter` | |

Error codes are kept: `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_TRANSITION`, `ORDER_CHANGED`, `PRICE_CHANGED`, `RATE_LIMITED`, `ROUTING_UNAVAILABLE`, `PUSH_UNAVAILABLE`.
New codes: `OTP_INVALID`, `OTP_EXPIRED`, `OTP_LOCKED` (423), `KYC_REQUIRED`, `OUT_OF_STOCK`, `VARIANT_REQUIRED`, `ADDON_SELECTION_INVALID`, `REFUND_EXCEEDS_PAID`, `OUTSIDE_DELIVERY_RADIUS`, `RESTAURANT_CLOSED`.

## 4.2 Real-time endpoint

| | |
|---|---|
| URL | `wss://<host>/ws/` |
| Auth | First frame `{"type":"auth","token":"<access>"}`. Failure closes with 4401. |
| Server → client | `order:updated {orderId, status, paymentStatus}`, `order:location {orderId, lat, lng, accuracy, at}`, `notification:new {…}`, `offer:new {orderId, expiresAt}`, `pong` |
| Client → server | `track:join {orderId}` → ack `{ok, error?}`, `track:leave {orderId}`, `rider:location {lat, lng, accuracy, heading?, speed?}`, `ping` |

Socket.IO's `emitWithAck` is replaced by a request id: the client sends `{"type":"track:join","rid":"r1","data":{…}}` and the server replies `{"type":"ack","rid":"r1","data":{ok:true}}`.

## 4.3 New and changed endpoints

Each entry lists the method and path, access, request, response (`data`), validation, and success and error statuses. Example payloads are fictional.

### Auth: OTP and verification (`accounts`)

**POST `/auth/otp/send`**: public, throttled (5 per hour per destination, 20 per hour per IP)
```json
{ "phone": "+919800000001", "purpose": "login" }
```
- Purpose is `login`, `register` or `verify_phone`.
- Responds 200 `{ "resendAfterSeconds": 30, "expiresInSeconds": 300 }`, **the same response whether or not the number exists**.
- Errors: 422, 429.

**POST `/auth/otp/verify`**: public, throttled
```json
{ "phone": "+919800000001", "code": "482913", "purpose": "login", "name": "Asha Verma" }
```
- `name` is required only for `register`.
- Responds 200 `{ accessToken, user }` and sets the refresh cookie, same as `/auth/login`.
- Errors: 422 `OTP_INVALID` (with `attemptsLeft`), 410 `OTP_EXPIRED`, 423 `OTP_LOCKED`, 403 if the account is suspended.

**POST `/auth/email/send-verification`**: signed in, throttled (3 per hour). Responds 202.

**POST `/auth/email/verify`**: public. Body `{ "token": "…" }`. Responds 200 `{ user }`. Errors: 400 invalid or expired.

**PATCH `/auth/me`**: now also accepts `phone`. Changing it clears `phoneVerifiedAt`, and the response includes `phoneVerificationRequired: true`.

**GET `/auth/me/logins`**: signed in. Paged `{ items: [{ method, success, ip, userAgent, at }] }` for the user's own last 180 days.

**GET `/admin/users/{id}/logins`**: `users:manage`. Same shape.

### Restaurant KYC, hours and settings (`restaurants`)

**GET `/my/restaurant/kyc`**: restaurant
```json
{ "kycStatus": "needs_resubmission",
  "gstin": "29ABCDE1234F1Z5", "fssaiNumber": "12345678901234", "fssaiExpiresOn": "2028-03-31", "legalName": "Spice Route Kitchen LLP",
  "documents": [ { "id": "…", "docType": "fssai_licence", "status": "rejected", "reviewNote": "Image is blurred", "numberLast4": "1234", "expiresOn": "2028-03-31", "uploadedAt": "…" } ],
  "bankAccount": { "holderName": "Spice Route Kitchen LLP", "accountLast4": "4321", "ifsc": "HDFC0001234", "verified": false },
  "requiredDocuments": ["fssai_licence", "pan", "cancelled_cheque", "shop_photo"] }
```

**PUT `/my/restaurant/kyc`**: restaurant. Body `{ gstin?, fssaiNumber, fssaiExpiresOn, legalName }`.
- Validation: GSTIN format and checksum, FSSAI 14 digits, expiry in the future.
- Responds 200 with the KYC object.

**POST `/my/restaurant/kyc/documents`**: restaurant, multipart `file`, `docType`, `number?`, `expiresOn?`.
- PDF, JPEG, PNG or WebP up to 5 MB, checked by magic bytes. Replaces the earlier document of the same type.
- Responds 201 with the document.

**PUT `/my/restaurant/bank-account`**: restaurant. Body `{ holderName, accountNumber, ifsc }`. Responds 200 with the masked account. The account number is never returned.

**POST `/my/restaurant/kyc/submit`**: restaurant. Moves the status to `pending`. Errors: 422 with the list of missing documents.

**GET, PUT `/my/restaurant/hours`**: restaurant
```json
{ "timezone": "Asia/Kolkata", "slots": [ { "weekday": 0, "opensAt": "11:00", "closesAt": "15:00" }, { "weekday": 0, "opensAt": "18:30", "closesAt": "23:30" } ] }
```
At most 3 slots per day. Slots must not overlap.

**GET, POST `/my/restaurant/holidays`** and **DELETE `/my/restaurant/holidays/{id}`**: body `{ date, reason }`. The date must be today or later.

**PATCH `/my/restaurant`**: now also accepts `deliveryRadiusM` (1000 to the platform maximum), `avgPrepTimeMinutes`, `minOrderPaise`, `logoUrl`, `coverUrl`.

**GET `/admin/kyc/queue?type=restaurant|rider&status=pending`**: `kyc:review`. Paged.

**GET `/admin/kyc/documents/{id}/file`**: `kyc:review`. Responds 302 to a 5-minute signed URL. The access is audited.

**POST `/admin/kyc/documents/{id}/review`**: `kyc:review`, audited. Body `{ "decision": "accepted" | "rejected", "note"? }`. A note is required when rejecting.

**PATCH `/admin/restaurants/{id}/status`**: also accepts `needs_resubmission` with `reason`. Approval requires every required document to be `accepted` (error 422 `KYC_REQUIRED`).

### Menu: variants, add-ons, stock, images (`menus`)

**POST `/my/restaurant/foods`** and **PATCH `/my/restaurant/foods/{id}`**: extended body
```json
{ "name": "Paneer Tikka", "categoryId": "…", "pricePaise": 24000, "isVeg": true,
  "variants": [ { "id": null, "name": "Half", "pricePaise": 24000, "isDefault": true }, { "name": "Full", "pricePaise": 42000 } ],
  "addonGroupIds": ["…"], "stockQuantity": null, "imageUrls": ["…", "…"] }
```
Variants are replaced as a set: rows not listed are removed if no cart uses them, otherwise marked unavailable.

**GET, POST `/my/restaurant/addon-groups`**; **PATCH, DELETE `/my/restaurant/addon-groups/{id}`**
```json
{ "name": "Extra toppings", "minSelect": 0, "maxSelect": 3, "addons": [ { "name": "Cheese", "pricePaise": 3000, "isVeg": true } ] }
```

**PATCH `/my/restaurant/foods/{id}/stock`**: body `{ "stockQuantity": 25 }`, or `null` for unlimited. Placing an order decrements stock atomically. At 0 the item is reported as `isAvailable: false` in the menu.

**GET `/restaurants/{slugOrId}/menu`** and **GET `/foods/{id}`**: items now include `variants[]`, `addonGroups[{ id, name, minSelect, maxSelect, addons[] }]`, `images[]` and `inStock`. Existing fields are unchanged, so old clients keep working.

### Cart and orders (`cart`, `orders`)

**POST `/cart/items`**
```json
{ "foodItemId": "…", "variantId": "…", "addonIds": ["…"], "quantity": 2, "instructions": "Less spicy" }
```
- Responds 200 with the quote. Each line has a `lineId`.
- Errors: 422 `VARIANT_REQUIRED`, `ADDON_SELECTION_INVALID`; 409 `OUT_OF_STOCK`, `RESTAURANT_CLOSED`.

**PATCH, DELETE `/cart/items/{lineId}`**: `{ quantity }`, where 0 removes the line.
- **Compatibility:** a dish id is accepted when that dish has exactly one line in the cart.

**POST `/orders/{id}/reorder`**: customer. Replaces the cart with the still-available lines.
- Responds 200 `{ quote, skipped: [{ name, reason: "unavailable" | "price_changed" | "variant_removed" }] }`.

**GET `/orders/{id}`** (customer): adds `deliveryOtp` (plain text, **only for the customer, and only while the order is `picked_up` or `on_the_way`**), `refunds: [{ amountPaise, status, processedAt }]` and the order lines with variants and add-ons.

**GET `/payments/mine`**: customer. Paged `{ orderNumber, amountPaise, method, status, refundedPaise, paidAt }`.

**GET, POST `/favorites`** and **DELETE `/favorites/{id}`**: customer. Body `{ restaurantId }` or `{ foodItemId }` (exactly one). GET returns `{ restaurants: [...cards], foods: [...cards] }`.

**GET `/me/recent-orders`**: customer. The last 5 distinct restaurants, with the reorder ability.

**GET `/banners`**: public, cached. Active banners for the home page.

### Delivery (`delivery`, `dispatch`, `tracking`)

**GET, PUT `/delivery/me/kyc`**; **POST `/delivery/me/kyc/documents`**; **PUT `/delivery/me/bank-account`**; **POST `/delivery/me/kyc/submit`**: same shapes as the restaurant KYC endpoints.

**PATCH `/delivery/me/availability`** `{ online: true }`: also fails with 403 `KYC_REQUIRED` unless approved, or within the migration grace period.

**PATCH `/delivery/orders/{id}/status`**
```json
{ "status": "arrived_at_restaurant" }
{ "status": "delivered", "otp": "4821" }
```
- Errors: 422 `OTP_INVALID` (with `attemptsLeft`), 423 `OTP_LOCKED`, 409 `INVALID_TRANSITION`/`ORDER_CHANGED`.
- An arrival more than 200 m from the restaurant is allowed but flagged (`arrivalDistanceM` is stored).

**POST `/delivery/orders/{id}/report-failure`**: rider. Body `{ reasonCode: "customer_unreachable" | "address_not_found" | "customer_refused" | "other", note }`.
- Opens a `delivery`-type support ticket with high priority and notifies `operations:view` admins.
- Responds 201 `{ ticketNumber }`.

**GET `/delivery/payouts`**: rider. Paged payouts with `incentivePaise`.

**GET `/tracking/orders/{id}`**: customer of the order, rider of the order, or `orders:view`.
- Returns `{ lastPoint, stale: bool, ageSeconds, recentPath: [ [lat,lng], … ] }` (path only while the order is active).
- This lets the tracking screen restore its state after reconnecting.

### Admin (`orders`, `payments`, `finance`, `system_settings`, `support`)

**POST `/admin/orders/{id}/assign`**: `orders:manage`, audited. Body `{ "partnerId": "…" }`.
- The rider must be eligible (online, approved, free). The admin can override the distance check (`force: true`).
- Creates an `accepted` assignment directly.

**POST `/admin/orders/{id}/mark-delivered`**: `orders:manage`, audited. Body `{ reason }`. For OTP lockouts.

**POST `/admin/payments/{id}/refunds`**: `refunds:manage`, audited
```json
{ "amountPaise": 12000, "reasonCode": "missing_item", "reason": "Raita missing from order BB-24-000183" }
```
- Responds 201 with the refund (`pending`).
- Errors: 422 `REFUND_EXCEEDS_PAID`; 409 if another refund is in progress.
- The existing **POST `/admin/payments/{id}/refund`** (retry a failed full refund) remains.

**GET `/admin/finance/reconciliation?from=&to=`**: `finance:view`.
- Returns `{ matched, mismatches: [{ paymentId, ours: {status, amountPaise}, gateway: {status, amountPaise} }], missingAtGateway, missingLocally }`.
- Produced by a nightly Celery job plus on-demand runs (`POST …/reconciliation/run`, `payouts:manage`).

**GET, POST `/admin/finance/commission-rules`** and **PATCH `/admin/finance/commission-rules/{id}`**: `settings:manage`.
- Body `{ restaurantId: null | "…", basisPoints: 1500, effectiveFrom }`. A new rule closes the previous one.

**GET, PUT `/admin/settings/{key}`**: `settings:manage`, audited. The key is `pricing`, `dispatch`, `earnings`, `delivery`, `kyc` or `cod`.
- Validated per key, e.g. `pricing`: `{ deliveryBaseFeePaise, deliveryBaseKm, deliveryPerKmPaise, deliveryMaxFeePaise, freeDeliveryThresholdPaise, maxDeliveryDistanceKm, platformFeePaise, foodTaxBasisPoints }`.
- Responds 200 `{ key, value, revision }`. **GET `/admin/settings/{key}/history`** returns the revisions.

**GET, PUT `/admin/feature-flags`**: `settings:manage`.

**GET, POST `/admin/banners`** and **PATCH, DELETE `/admin/banners/{id}`**: `catalog:manage`.

**GET `/my/restaurant/invoices`** and **GET `/my/restaurant/invoices/{id}/file`**: restaurant. The file is a signed URL.

**GET `/orders/{id}/invoice`**: customer. Delivered orders only. Generated on demand and cached.

**GET `/my/restaurant/settlements`**: restaurant. Paged `{ period, orders, grossPaise, commissionPaise, refundAdjustmentsPaise, netPaise, payoutStatus, reference }`.

**GET `/my/restaurant/reports/sales.csv?from=&to=`**: restaurant. CSV stream with a formula-injection guard (values starting with `= + - @` are prefixed with `'`).

**Disputes:** support tickets with `type: "dispute"` use the existing support endpoints, and admins act with the refund endpoint above. Permission `disputes:manage` (granted to support and finance) can open refunds up to a setting-defined cap without `refunds:manage`.

## 4.4 Permissions matrix (new permissions)

| Permission | super | operations | finance | support |
|---|---|---|---|---|
| `kyc:review` | ✓ | ✓ | | |
| `settings:manage` | ✓ | | ✓ (commission and pricing only) | |
| `disputes:manage` | ✓ | | ✓ | ✓ |
| `incentives:manage` | ✓ | ✓ | | |

Existing permissions and their mapping are unchanged (MASTER_PROMPT §A2). The frontend `Permission` type gets the same additions.

## 4.5 Documentation

drf-spectacular generates `/api/docs.json`, served with Swagger UI at `/api/docs`. Each view has `@extend_schema(summary, tags, request, responses={200: …, 422: ErrorEnvelope, …}, examples=[…])`. A test (`test_openapi.py`) fails if any URL is missing from the schema or if the schema doesn't validate. This replaces `tests/docs.test.js`.
