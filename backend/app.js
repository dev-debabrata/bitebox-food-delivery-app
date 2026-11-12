import path from "node:path";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { openApiDocument } from "./docs/openapi.js";
import { errorHandler, notFound } from "./middleware/error.middleware.js";
import {
  isAllowedOrigin,
  mongoSanitize,
} from "./middleware/security.middleware.js";
import adminCatalogRoutes from "./routes/admin-catalog.routes.js";
import adminUsersRoutes from "./routes/admin-users.routes.js";
import { createAuthRouter } from "./routes/auth.routes.js";
import {
  categoriesRouter,
  foodsRouter,
  restaurantsRouter,
} from "./routes/catalog.routes.js";
import {
  addressesRouter,
  adminCouponsRouter,
  cartRouter,
  couponsRouter,
  ordersRouter,
} from "./routes/checkout.routes.js";
import {
  adminDeliveryPartnersRouter,
  adminOrdersRouter,
  adminPaymentsRouter,
  adminRefundsRouter,
  adminReportsRouter,
} from "./routes/admin-orders.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import {
  paymentsRouter,
  razorpayWebhookRouter,
} from "./routes/payment.routes.js";
import deliveryRoutes from "./routes/delivery.routes.js";
import geoRoutes from "./routes/geo.routes.js";
import healthRoutes from "./routes/health.routes.js";
import myRestaurantRoutes from "./routes/my-restaurant.routes.js";
import {
  adminReviewsRouter,
  reviewsRouter,
} from "./routes/review.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import { coinsRouter } from "./routes/coins.routes.js";
import { referralsRouter } from "./routes/referral.routes.js";
import { rewardsRouter } from "./routes/rewards.routes.js";
import { adminRewardsRouter } from "./routes/admin-rewards.routes.js";
import { newsletterRouter } from "./routes/newsletter.routes.js";
import { adminPushRouter, pushRouter } from "./routes/push.routes.js";
import { adminFinanceRouter } from "./routes/admin-finance.routes.js";
import {
  adminDashboardRouter,
  adminOperationsRouter,
} from "./routes/admin-operations.routes.js";
import { adminAuditRouter, adminStaffRouter } from "./routes/admin-staff.routes.js";
import { adminSupportRouter, supportRouter } from "./routes/support.routes.js";

export function createApp(options = {}) {
  const app = express();

  if (process.env.TRUST_PROXY)
    app.set(
      "trust proxy",
      Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY,
    );
  app.disable("x-powered-by");

  app.use(pinoHttp({ logger, autoLogging: process.env.LOG_HTTP === "true" }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Idempotency-Key",
      ],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(compression());
  // Signed gateway webhooks need the raw body, so they are mounted before the JSON parser.
  app.use("/api/v1/payments/webhooks/razorpay", razorpayWebhookRouter);
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(cookieParser());
  app.use(mongoSanitize);

  app.get("/", (_req, res) =>
    res.json({
      success: true,
      message: "BiteBox API",
      data: { docs: "/api/docs", health: "/api/v1/health" },
    }),
  );

  app.use(
    "/uploads",
    express.static(path.resolve(env.uploadDir), {
      index: false,
      dotfiles: "deny",
      maxAge: "7d",
      setHeaders: (res) => {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'");
      },
    }),
  );

  app.get("/api/docs.json", (_req, res) => res.json(openApiDocument));
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, { customSiteTitle: "BiteBox API Docs" }),
  );

  app.use("/api/v1/health", healthRoutes);
  app.use("/api/v1/auth", createAuthRouter(options.rateLimits));
  app.use("/api/v1/admin/users", adminUsersRoutes);
  app.use("/api/v1/admin/coupons", adminCouponsRouter);
  app.use("/api/v1/admin/orders", adminOrdersRouter);
  app.use("/api/v1/admin/delivery-partners", adminDeliveryPartnersRouter);
  app.use("/api/v1/admin/payments", adminPaymentsRouter);
  app.use("/api/v1/admin/refunds", adminRefundsRouter);
  app.use("/api/v1/admin/reports", adminReportsRouter);
  app.use("/api/v1/admin/reviews", adminReviewsRouter);
  app.use("/api/v1/admin/admins", adminStaffRouter);
  app.use("/api/v1/admin/audit-logs", adminAuditRouter);
  app.use("/api/v1/admin/operations", adminOperationsRouter);
  app.use("/api/v1/admin/dashboard", adminDashboardRouter);
  app.use("/api/v1/admin/finance", adminFinanceRouter);
  app.use("/api/v1/admin/support", adminSupportRouter);
  app.use("/api/v1/admin/rewards", adminRewardsRouter);
  app.use("/api/v1/admin/push", adminPushRouter);
  app.use("/api/v1/admin", adminCatalogRoutes);
  app.use("/api/v1/restaurants", restaurantsRouter);
  app.use("/api/v1/categories", categoriesRouter);
  app.use("/api/v1/foods", foodsRouter);
  app.use("/api/v1/my/restaurant", myRestaurantRoutes);
  app.use("/api/v1/uploads", uploadsRoutes);
  app.use("/api/v1/cart", cartRouter);
  app.use("/api/v1/addresses", addressesRouter);
  app.use("/api/v1/orders", ordersRouter);
  app.use("/api/v1/coupons", couponsRouter);
  app.use("/api/v1/delivery", deliveryRoutes);
  app.use("/api/v1/payments", paymentsRouter);
  app.use("/api/v1/notifications", notificationRoutes);
  app.use("/api/v1/push", pushRouter);
  app.use("/api/v1/reviews", reviewsRouter);
  app.use("/api/v1/support", supportRouter);
  app.use("/api/v1/coins", coinsRouter);
  app.use("/api/v1/referrals", referralsRouter);
  app.use("/api/v1/rewards", rewardsRouter);
  app.use("/api/v1/newsletter", newsletterRouter);
  app.use("/api/v1/geo", geoRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
