import { Router } from "express";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { audited } from "../services/audit.service.js";
import * as finance from "../services/finance.service.js";
import { rupees } from "../services/order-notifications.js";
import { download, respond } from "../utils/api-response.js";
import { Payout } from "../models/payout.model.js";
import { ApiError } from "../utils/api-error.js";
import * as ledger from "../services/ledger.service.js";
import { payoutStatement } from "../services/invoice.service.js";
import { parsePagination } from "../utils/pagination.js";
import * as rules from "../validators/finance.validators.js";
import { daysRules } from "../validators/payment.validators.js";

const P = PERMISSIONS;

/**
 * /api/v1/admin/finance: dashboard, transaction details, payouts, refunds and commission.
 * The transaction list, refund retry and the financial report are the existing
 * /admin/payments and /admin/reports endpoints (finance permissions).
 */
export const adminFinanceRouter = Router()
  .use(authenticate, can(P.FINANCE_VIEW))
  .get(
    "/dashboard",
    validate(daysRules),
    respond((req) => finance.dashboard(req.validatedQuery.days ?? 30)),
  )
  .get(
    "/transactions/:id",
    validate(rules.transactionRules),
    respond(async (req) => ({ transaction: await finance.transaction(req.params.id) })),
  )
  .get(
    "/commission",
    validate(daysRules),
    respond((req) => finance.commission(req.validatedQuery.days ?? 30)),
  )
  .get(
    "/refunds",
    validate(rules.refundListRules),
    respond((req) =>
      finance.refunds(req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .get(
    "/payouts/due",
    can(P.PAYOUTS_MANAGE),
    validate(rules.dueRules),
    respond((req) => finance.payoutsDue(req.validatedQuery.type)),
  )
  .get(
    "/payouts",
    can(P.PAYOUTS_MANAGE),
    validate(rules.listPayoutRules),
    respond((req) =>
      finance.listPayouts(req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .post(
    "/payouts",
    can(P.PAYOUTS_MANAGE),
    validate(rules.createPayoutRules),
    audited("payout.create", "payout", (req) =>
      `Created a ${req.body.type} payout of ${rupees(req.payoutAmount ?? 0)} for ${req.payoutName ?? "a payee"}`,
    ),
    respond(
      async (req) => {
        const payout = await finance.createPayout(
          req.user,
          req.body.type,
          req.body.payeeId,
          req.body.note,
        );
        Object.assign(req, {
          auditResourceId: payout.id,
          payoutAmount: payout.amountPaise,
          payoutName: payout.payeeName,
        });
        return { payout };
      },
      "Payout created",
      201,
    ),
  )
  .post(
    "/payouts/:id/paid",
    can(P.PAYOUTS_MANAGE),
    validate(rules.payPayoutRules),
    audited("payout.paid", "payout", (req) => `Marked payout as paid (ref ${req.body.reference})`),
    respond(
      async (req) => ({
        payout: await finance.markPayoutPaid(req.user, req.params.id, req.body.reference),
      }),
      "Payout marked as paid",
    ),
  )
  .post(
    "/payouts/:id/cancel",
    can(P.PAYOUTS_MANAGE),
    validate(rules.cancelPayoutRules),
    audited("payout.cancel", "payout", (req) =>
      ["Cancelled payout", req.body.note].filter(Boolean).join(": "),
    ),
    respond(
      async (req) => ({ payout: await finance.cancelPayout(req.params.id, req.body.note) }),
      "Payout cancelled",
    ),
  )
  // Commission rules: the global rate and per-restaurant overrides (changing them: payouts:manage).
  .get("/commission/rules", respond(() => finance.commissionRules()))
  .put(
    "/commission/rules",
    can(P.PAYOUTS_MANAGE),
    validate(rules.commissionRuleRules),
    audited("commission.set", "commission", (req) =>
      `Set commission to ${req.body.basisPoints / 100}%${req.body.restaurantId ? " for a restaurant" : " (global)"}`,
    ),
    respond(
      (req) =>
        finance.setCommission(req.user, req.body.restaurantId ?? null, req.body.basisPoints, req.body.note),
      "Commission saved",
    ),
  )
  .delete(
    "/commission/rules/:id",
    can(P.PAYOUTS_MANAGE),
    validate([rules.idParam()]),
    audited("commission.clear", "restaurant", () => "Removed a restaurant's own commission"),
    respond((req) => finance.clearCommission(req.params.id), "The global commission applies again"),
  )
  .get(
    "/payouts/:id/statement",
    validate([rules.idParam()]),
    download(async (req) => {
      const payout = await Payout.findById(req.params.id);
      if (!payout) throw ApiError.notFound("Payout not found");
      const { name, pdf } = await payoutStatement(payout);
      return { name, body: pdf, type: "application/pdf" };
    }),
  )
  .get(
    "/ledger",
    validate([...daysRules, ...rules.pageRules]),
    respond((req) =>
      ledger.summary(req.validatedQuery.days ?? 30, parsePagination(req.validatedQuery)),
    ),
  )
  .get(
    "/settlements.csv",
    validate(rules.csvRules),
    download(async (req) => ({
      name: "BiteBox-settlements.csv",
      body: await finance.settlementsCsv(req.validatedQuery),
      type: "text/csv; charset=utf-8",
    })),
  );
