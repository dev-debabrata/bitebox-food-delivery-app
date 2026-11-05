import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as wallet from "../services/coin-wallet.service.js";
import { customerRules } from "../services/coins.service.js";
import { getRewardConfig } from "../services/reward-config.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import * as rules from "../validators/rewards.validators.js";

/**
 * /api/v1/coins: the signed-in customer's own wallet. Read-only: balances change only through
 * orders, reviews, referrals and campaigns on the server, never by a client request.
 */
export const coinsRouter = Router()
  .use(authenticate, authorize(ROLES.CUSTOMER))
  .get(
    "/wallet",
    respond(async (req) => ({
      wallet: await wallet.walletSummary(req.user._id),
      rules: customerRules(await getRewardConfig()),
    })),
  )
  .get(
    "/transactions",
    validate(rules.coinTransactionListRules),
    respond((req) =>
      wallet.listTransactions(
        req.user._id,
        req.validatedQuery,
        parsePagination(req.validatedQuery),
      ),
    ),
  );
