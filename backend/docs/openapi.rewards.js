import { COIN_SOURCES, COIN_TXN_TYPES } from "../config/rewards.js";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (data, description = "Success") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { success: { const: true }, message: { type: "string" }, data },
      },
    },
  },
});
const err = (description) => ({
  description,
  content: { "application/json": { schema: ref("Error") } },
});
const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const bearer = [{ bearerAuth: [] }];
const idParam = { in: "path", name: "id", required: true, schema: { type: "string" } };
const paging = [
  { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
  { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
];
const q = (name, schema) => ({ in: "query", name, schema });
const list = (item) => ({
  type: "object",
  properties: { items: { type: "array", items: item }, pagination: ref("Pagination") },
});
const obj = (properties) => ({ type: "object", properties });
const forbidden = { 401: err("Not signed in"), 403: err("Not allowed") };

export const rewardsTags = [
  {
    name: "Coins",
    description:
      "Customer coin wallet. Coins are earned from delivered orders, reviews, referrals and campaigns, and redeemed at checkout (PUT /cart/coins). Balances change only on the server; every change is an immutable ledger row.",
  },
  { name: "Referrals", description: "Refer & earn: the customer's code, statistics and history." },
  { name: "Special rewards", description: "Welcome and birthday bonuses, festival and promotional campaigns." },
  { name: "Newsletter", description: "Marketing email sign-up from the site footer." },
  { name: "Admin - Rewards", description: "Coins & Rewards management. Reading needs rewards:view; changes need rewards:manage (super admin) and are audited." },
];

export const rewardsSchemas = {
  CoinWallet: obj({
    available: { type: "integer" },
    reserved: { type: "integer", description: "Held for unpaid online orders" },
    totalEarned: { type: "integer" },
    totalRedeemed: { type: "integer" },
    totalExpired: { type: "integer" },
    totalReversed: { type: "integer" },
    valuePaise: { type: "integer" },
    expiring: obj({
      enabled: { type: "boolean" },
      withinDays: { type: "integer" },
      coins: { type: "integer" },
      next: { type: ["object", "null"] },
      upcoming: { type: "array", items: obj({ date: { type: "string" }, coins: { type: "integer" } }) },
    }),
  }),
  CoinTransaction: obj({
    id: { type: "string" },
    type: { type: "string", enum: Object.values(COIN_TXN_TYPES) },
    source: { type: "string", enum: Object.values(COIN_SOURCES) },
    coins: { type: "integer" },
    availableChange: { type: "integer" },
    reservedChange: { type: "integer" },
    balanceAfter: { type: "integer" },
    description: { type: ["string", "null"] },
    orderId: { type: ["string", "null"] },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
  }),
  CoinQuote: obj({
    enabled: { type: "boolean" },
    available: { type: "integer" },
    requested: { type: "integer" },
    applied: { type: "integer" },
    discountPaise: { type: "integer" },
    maxRedeemable: { type: "integer" },
    minCoins: { type: "integer" },
    paymentMethods: { type: "array", items: { type: "string" } },
    message: { type: ["string", "null"] },
  }),
  RewardCampaign: obj({
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    type: { type: "string", enum: ["FESTIVAL", "PROMOTIONAL"] },
    trigger: { type: "string", enum: ["CLAIM", "ORDER"] },
    rewardCoins: { type: "integer" },
    startAt: { type: "string", format: "date-time" },
    endAt: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "EXPIRED", "COMPLETED"] },
    conditions: { type: "object" },
    limits: { type: "object" },
    stats: obj({ claims: { type: "integer" }, coins: { type: "integer" } }),
  }),
  RewardCampaignInput: {
    type: "object",
    required: ["name", "type", "rewardCoins", "startAt", "endAt"],
    properties: {
      name: { type: "string", minLength: 3, maxLength: 80 },
      description: { type: "string", maxLength: 500 },
      type: { type: "string", enum: ["FESTIVAL", "PROMOTIONAL"] },
      trigger: { type: "string", enum: ["CLAIM", "ORDER"], default: "CLAIM" },
      rewardCoins: { type: "integer", minimum: 1 },
      startAt: { type: "string", format: "date-time" },
      endAt: { type: "string", format: "date-time" },
      conditions: obj({
        customerGroup: { type: "string", enum: ["ALL", "NEW", "EXISTING", "INACTIVE"] },
        inactiveDays: { type: "integer" },
        minOrderPaise: { type: "integer" },
        firstOrderOnly: { type: "boolean" },
        restaurants: { type: "array", items: { type: "string" } },
      }),
      limits: obj({
        maxClaimsPerCustomer: { type: "integer", minimum: 1 },
        maxTotalClaims: { type: ["integer", "null"] },
        maxTotalCoins: { type: ["integer", "null"] },
      }),
    },
  },
  RewardClaim: obj({
    id: { type: "string" },
    rewardType: { type: "string", enum: ["WELCOME", "BIRTHDAY", "FESTIVAL", "PROMOTIONAL"] },
    coins: { type: "integer" },
    status: { type: "string", enum: ["PENDING", "ISSUED"] },
    campaign: { type: ["object", "null"] },
    claimedAt: { type: "string", format: "date-time" },
  }),
  RewardConfiguration: {
    type: "object",
    description: "Global reward settings (see backend/config/rewards.js for every field and default). `version` must be sent back when saving.",
    additionalProperties: true,
  },
};

const customer = (tag, summary, extra = {}) => ({ tags: [tag], summary, security: bearer, ...extra });
const adminOp = (summary, extra = {}) => ({ tags: ["Admin - Rewards"], summary, security: bearer, ...extra });

export const rewardsPaths = {
  "/cart/coins": {
    put: {
      tags: ["Coins"],
      summary: "Pay part of the order with coins (validated and capped on the server)",
      security: bearer,
      requestBody: body({ type: "object", required: ["coins"], properties: { coins: { type: "integer", minimum: 0 } } }),
      responses: {
        200: ok(obj({ coins: ref("CoinQuote") }), "The re-priced cart"),
        422: err("COINS_BELOW_MINIMUM, COINS_NOT_REDEEMABLE or COINS_UNAVAILABLE"),
      },
    },
    delete: { tags: ["Coins"], summary: "Stop using coins on this order", security: bearer, responses: { 200: ok(obj({})) } },
  },
  "/coins/wallet": {
    get: customer("Coins", "My balances, rupee value, upcoming expiry and the redemption rules", {
      responses: { 200: ok(obj({ wallet: ref("CoinWallet"), rules: { type: "object" } })), ...forbidden },
    }),
  },
  "/coins/transactions": {
    get: customer("Coins", "My coin history, newest first", {
      parameters: [...paging, q("type", { type: "string", enum: Object.values(COIN_TXN_TYPES) }), q("source", { type: "string", enum: Object.values(COIN_SOURCES) })],
      responses: { 200: ok(list(ref("CoinTransaction"))) },
    }),
  },
  "/referrals/validate": {
    post: {
      tags: ["Referrals"],
      summary: "Check a referral code (public, rate limited; never reveals the owner)",
      requestBody: body({ type: "object", required: ["code"], properties: { code: { type: "string" } } }),
      responses: { 200: ok(obj({ valid: { type: "boolean" }, message: { type: "string" } })) },
    },
  },
  "/referrals/me": {
    get: customer("Referrals", "My code, share link, rules and statistics", { responses: { 200: ok(obj({ code: { type: "string" }, link: { type: "string" }, stats: { type: "object" } })) } }),
  },
  "/referrals/me/history": {
    get: customer("Referrals", "Friends I invited (names shortened)", {
      parameters: [...paging, q("status", { type: "string" })],
      responses: { 200: ok(list({ type: "object" })) },
    }),
  },
  "/rewards": {
    get: customer("Special rewards", "Birthday, welcome and totals", { responses: { 200: ok({ type: "object" }) } }),
  },
  "/rewards/campaigns": {
    get: customer("Special rewards", "Running and upcoming campaigns, with whether I can claim", {
      responses: { 200: ok(obj({ items: { type: "array", items: ref("RewardCampaign") } })) },
    }),
  },
  "/rewards/campaigns/{id}/claim": {
    post: customer("Special rewards", "Claim a campaign reward", {
      parameters: [idParam],
      responses: { 201: ok(obj({ claim: ref("RewardClaim") })), 404: err("Not found"), 409: err("NOT_ELIGIBLE, ALREADY_CLAIMED or CAMPAIGN_UNAVAILABLE") },
    }),
  },
  "/rewards/history": {
    get: customer("Special rewards", "Rewards I received", {
      parameters: [...paging, q("rewardType", { type: "string" })],
      responses: { 200: ok(list(ref("RewardClaim"))) },
    }),
  },
  "/rewards/birthday": {
    put: customer("Special rewards", "Save my date of birth (once)", {
      requestBody: body({ type: "object", required: ["birthDate"], properties: { birthDate: { type: "string", format: "date" } } }),
      responses: { 200: ok(obj({ birthDate: { type: "string" } })), 409: err("BIRTHDAY_SET"), 422: err("Invalid date") },
    }),
  },

  "/newsletter/subscriptions": {
    post: {
      tags: ["Newsletter"],
      summary: "Subscribe an email to the newsletter (public, rate limited; repeating it is harmless)",
      requestBody: body({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }),
      responses: {
        200: ok(obj({ subscribed: { type: "boolean" }, alreadySubscribed: { type: "boolean" } })),
        422: err("Invalid email"),
        429: err("Too many attempts"),
      },
    },
  },
  "/admin/rewards/configuration": {
    get: adminOp("Reward settings", { responses: { 200: ok(obj({ configuration: ref("RewardConfiguration") })), ...forbidden } }),
    put: adminOp("Change reward settings (super admin, audited)", {
      requestBody: body(ref("RewardConfiguration")),
      responses: { 200: ok(obj({ configuration: ref("RewardConfiguration") })), 409: err("CONFIG_CHANGED"), 422: err("Validation failed"), ...forbidden },
    }),
  },
  "/admin/rewards/campaigns": {
    get: adminOp("Campaigns", {
      parameters: [...paging, q("status", { type: "string" }), q("type", { type: "string" }), q("search", { type: "string" })],
      responses: { 200: ok(list(ref("RewardCampaign"))) },
    }),
    post: adminOp("Create a campaign (as a draft)", {
      requestBody: body(ref("RewardCampaignInput")),
      responses: { 201: ok(obj({ campaign: ref("RewardCampaign") })), 422: err("Validation failed") },
    }),
  },
  "/admin/rewards/campaigns/{id}": {
    get: adminOp("A campaign with its performance and recent claims", { parameters: [idParam], responses: { 200: ok({ type: "object" }), 404: err("Not found") } }),
    put: adminOp("Edit a campaign (running ones: name, description, end date and limits only)", {
      parameters: [idParam],
      requestBody: body(ref("RewardCampaignInput")),
      responses: { 200: ok(obj({ campaign: ref("RewardCampaign") })), 409: err("CAMPAIGN_RUNNING or CAMPAIGN_FINISHED") },
    }),
  },
  "/admin/rewards/campaigns/{id}/status": {
    patch: adminOp("Activate (schedule), pause or end a campaign", {
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["action"], properties: { action: { type: "string", enum: ["activate", "pause", "end"] } } }),
      responses: { 200: ok(obj({ campaign: ref("RewardCampaign") })), 409: err("INVALID_CAMPAIGN_MOVE") },
    }),
  },
  "/admin/rewards/claims": {
    get: adminOp("Reward distribution history", {
      parameters: [...paging, q("rewardType", { type: "string" }), q("campaign", { type: "string" })],
      responses: { 200: ok(list(ref("RewardClaim"))) },
    }),
  },
  "/admin/rewards/transactions": {
    get: adminOp("Coin ledger across all customers", {
      parameters: [...paging, q("type", { type: "string" }), q("source", { type: "string" }), q("search", { type: "string" }), q("userId", { type: "string" }), q("from", { type: "string", format: "date-time" }), q("to", { type: "string", format: "date-time" })],
      responses: { 200: ok(list(ref("CoinTransaction"))) },
    }),
  },
  "/admin/rewards/transactions/{id}": {
    get: adminOp("One ledger row and the rows that settle or undo it", { parameters: [idParam], responses: { 200: ok({ type: "object" }), 404: err("Not found") } }),
  },
  "/admin/rewards/transactions/{id}/reverse": {
    post: adminOp("Claw back an earned reward (partial allowed; never makes a balance negative)", {
      parameters: [idParam, { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } }],
      requestBody: body({ type: "object", required: ["reason"], properties: { coins: { type: "integer" }, reason: { type: "string" } } }),
      responses: { 200: ok({ type: "object" }), 409: err("NOT_REVERSIBLE, ALREADY_REVERSED or REVERSAL_TOO_LARGE") },
    }),
  },
  "/admin/rewards/wallets/{id}": {
    get: adminOp("A customer's wallet, batches, ledger check and recent history", { parameters: [idParam], responses: { 200: ok({ type: "object" }), 404: err("Not found") } }),
  },
  "/admin/rewards/reports": {
    get: adminOp("Issued, redeemed, liability, referrals, campaigns and suspicious activity", {
      parameters: [q("days", { type: "integer", minimum: 1, maximum: 365 })],
      responses: { 200: ok({ type: "object" }) },
    }),
  },
  "/admin/rewards/referrals": {
    get: adminOp("Referrals, with risk signals", {
      parameters: [...paging, q("status", { type: "string" }), q("rewardStatus", { type: "string" }), q("flagged", { type: "boolean" }), q("search", { type: "string" })],
      responses: { 200: ok(list({ type: "object" })) },
    }),
  },
  "/admin/rewards/referrals/{id}": {
    get: adminOp("One referral", { parameters: [idParam], responses: { 200: ok({ type: "object" }), 404: err("Not found") } }),
  },
  "/admin/rewards/referrals/{id}/approve": {
    post: adminOp("Approve a held referral (pays it)", {
      parameters: [idParam],
      requestBody: body({ type: "object", properties: { note: { type: "string" } } }),
      responses: { 200: ok({ type: "object" }), 409: err("NOT_HELD") },
    }),
  },
  "/admin/rewards/referrals/{id}/reject": {
    post: adminOp("Reject an unpaid referral", {
      parameters: [idParam],
      requestBody: body({ type: "object", required: ["note"], properties: { note: { type: "string" } } }),
      responses: { 200: ok({ type: "object" }), 409: err("NOT_REJECTABLE") },
    }),
  },
};
