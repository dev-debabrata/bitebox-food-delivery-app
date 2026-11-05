import { Router } from "express";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { audited } from "../services/audit.service.js";
import * as referrals from "../services/referral.service.js";
import { getRewardConfig, updateRewardConfig } from "../services/reward-config.service.js";
import * as admin from "../services/rewards-admin.service.js";
import * as special from "../services/special-rewards.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import { daysRules } from "../validators/payment.validators.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/rewards.validators.js";

const P = PERMISSIONS;
const manage = can(P.REWARDS_MANAGE);
const page = (req) => parsePagination(req.validatedQuery);

/**
 * /api/v1/admin/rewards: Coins & Rewards management. Reading needs rewards:view; changing
 * settings, campaigns, referrals or balances needs rewards:manage (super admin) and is audited.
 */
export const adminRewardsRouter = Router()
  .use(authenticate, can(P.REWARDS_VIEW, P.REWARDS_MANAGE))
  // Configuration
  .get("/configuration", respond(async () => ({ configuration: await getRewardConfig({ fresh: true }) })))
  .put(
    "/configuration",
    manage,
    validate(rules.updateConfigRules),
    audited("rewards.configure", "reward_configuration", (req) =>
      `Updated reward settings: ${Object.keys(req.body).filter((k) => k !== "version").join(", ") || "no changes"}`,
    ),
    respond(async (req) => {
      const { version, ...patch } = req.body;
      return { configuration: await updateRewardConfig(req.user, patch, version) };
    }, "Reward settings saved"),
  )
  // Campaigns
  .get("/campaigns", validate(rules.campaignListRules), respond((req) => special.adminList(req.validatedQuery, page(req))))
  .post(
    "/campaigns",
    manage,
    validate(rules.createCampaignRules),
    audited("rewards.campaign.create", "reward_campaign", (req) => `Created campaign "${req.body.name}"`),
    respond(async (req) => {
      const campaign = await special.adminCreate(req.user, req.body);
      req.auditResourceId = campaign.id;
      return { campaign };
    }, "Campaign created", 201),
  )
  .get("/campaigns/:id", validate([mongoIdParam()]), respond((req) => special.adminGet(req.params.id)))
  .put(
    "/campaigns/:id",
    manage,
    validate(rules.updateCampaignRules),
    audited("rewards.campaign.update", "reward_campaign", (req) => `Edited campaign: ${Object.keys(req.body).join(", ")}`),
    respond(async (req) => ({ campaign: await special.adminUpdate(req.user, req.params.id, req.body) }), "Campaign saved"),
  )
  .patch(
    "/campaigns/:id/status",
    manage,
    validate(rules.campaignStatusRules),
    audited("rewards.campaign.status", "reward_campaign", (req) => `Campaign ${req.body.action}`),
    respond(
      async (req) => ({ campaign: await special.adminSetStatus(req.user, req.params.id, req.body.action) }),
      "Campaign updated",
    ),
  )
  .get("/claims", validate(rules.claimListRules), respond((req) => special.adminClaims(req.validatedQuery, page(req))))
  // Ledger
  .get(
    "/transactions",
    validate(rules.adminTransactionListRules),
    respond((req) => admin.listTransactions(req.validatedQuery, page(req))),
  )
  .get("/transactions/:id", validate([mongoIdParam()]), respond((req) => admin.getTransaction(req.params.id)))
  .post(
    "/transactions/:id/reverse",
    manage,
    validate(rules.reverseTransactionRules),
    audited("rewards.reverse", "coin_transaction", (req) =>
      `Reversed ${req.body.coins ?? "all remaining"} coins: ${req.body.reason}`,
    ),
    respond(
      (req) => admin.reverseTransaction(req.user, req.params.id, req.body, req.get("idempotency-key")),
      "Reward reversed",
    ),
  )
  .get("/wallets/:id", validate([mongoIdParam()]), respond((req) => admin.walletDetail(req.params.id)))
  // Reports
  .get("/reports", validate(daysRules), respond((req) => admin.reports(req.validatedQuery.days ?? 30)))
  // Referrals
  .get("/referrals", validate(rules.adminReferralListRules), respond((req) => referrals.adminList(req.validatedQuery, page(req))))
  .get("/referrals/:id", validate([mongoIdParam()]), respond(async (req) => ({ referral: await referrals.adminGet(req.params.id) })))
  .post(
    "/referrals/:id/approve",
    manage,
    validate(rules.referralDecisionRules(false)),
    audited("rewards.referral.approve", "referral", (req) => ["Approved a held referral", req.body.note].filter(Boolean).join(": ")),
    respond(async (req) => ({ referral: await referrals.approve(req.user, req.params.id, req.body.note) }), "Referral approved"),
  )
  .post(
    "/referrals/:id/reject",
    manage,
    validate(rules.referralDecisionRules(true)),
    audited("rewards.referral.reject", "referral", (req) => `Rejected a referral: ${req.body.note}`),
    respond(async (req) => ({ referral: await referrals.reject(req.user, req.params.id, req.body.note) }), "Referral rejected"),
  );
