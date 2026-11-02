import { Router } from "express";
import multer from "multer";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/security.middleware.js";
import { ROLES } from "../models/user.model.js";
import { MAX_IMAGE_BYTES, saveImage } from "../services/upload.service.js";
import { ApiError } from "../utils/api-error.js";
import { sendSuccess } from "../utils/api-response.js";

// Files are kept in memory (max 2 MB) so their bytes can be checked before anything touches disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } });

const singleImage = (req, res, next) =>
  upload.single("image")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "Image must be 2 MB or smaller" : "Upload a single image in the \"image\" field";
      return next(new ApiError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, message, { code: error.code }));
    }
    next(error);
  });

const router = Router();

router.post(
  "/images",
  authenticate,
  authorize(ROLES.RESTAURANT, ROLES.ADMIN),
  createRateLimiter({ windowMs: 60 * 60_000, limit: 60, message: "Too many uploads. Try again later." }),
  singleImage,
  async (req, res) => {
    const image = await saveImage(req.file);
    sendSuccess(res, { statusCode: 201, message: "Image uploaded", data: image });
  },
);

export default router;
