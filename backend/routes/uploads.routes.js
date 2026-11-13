import { Router } from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { ALL_ROLES } from "../config/roles.js";
import { ROLES } from "../models/user.model.js";
import { MAX_IMAGE_BYTES, saveImage } from "../services/upload.service.js";
import { ApiError } from "../utils/api-error.js";
import { sendSuccess } from "../utils/api-response.js";

// Files are kept in memory (max 2 MB) so their bytes can be checked before anything touches disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
});

const singleImage = (req, res, next) =>
  upload.single("image")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "Image must be 2 MB or smaller"
          : 'Upload a single image in the "image" field';
      return next(
        new ApiError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, message, {
          code: error.code,
        }),
      );
    }
    next(error);
  });

/** One image per request, checked by its bytes, for the given roles and hourly limit. */
const imageRoute = (roles, limit, noun) => [
  authenticate,
  authorize(...roles),
  createRateLimiter({
    windowMs: 60 * 60_000,
    limit: env.isTest ? 1000 : limit,
    message: `Too many ${noun.toLowerCase()} uploads. Try again later.`,
  }),
  singleImage,
  async (req, res) => {
    const image = await saveImage(req.file);
    sendSuccess(res, { statusCode: 201, message: `${noun} uploaded`, data: image });
  },
];

const router = Router();
router.post("/images", ...imageRoute([ROLES.RESTAURANT, ROLES.ADMIN], 60, "Image"));
// Customers attach photos to reviews, with their own, tighter limit.
router.post("/review-images", ...imageRoute([ROLES.CUSTOMER], 30, "Photo"));
// A profile photo, for anyone signed in (saved with PATCH /auth/me avatarUrl).
router.post("/avatars", ...imageRoute(ALL_ROLES, 30, "Photo"));

export default router;
