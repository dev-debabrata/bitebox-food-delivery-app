import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { ApiError } from "../utils/api-error.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Detects the real image type from the file's first bytes. The browser's
 * Content-Type and the file name are attacker-controlled, so they are ignored.
 */
export function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

/**
 * Local-disk storage. Files get random names (never the client's name) and
 * are served from /uploads. Swap this object for a cloud provider (e.g.
 * Cloudinary or S3) in production deployments with ephemeral disks.
 */
const localStorage = {
  async save(buffer, extension) {
    const dir = path.join(env.uploadDir, "images");
    await fs.mkdir(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${extension}`;
    await fs.writeFile(path.join(dir, name), buffer, { flag: "wx" });
    return `${env.publicBaseUrl}/uploads/images/${name}`;
  },
};

export async function saveImage(file) {
  if (!file) throw ApiError.badRequest("Choose an image to upload");
  const type = detectImageType(file.buffer);
  if (!type) throw new ApiError(415, "Only JPEG, PNG or WebP images are allowed", { code: "UNSUPPORTED_MEDIA_TYPE" });
  return { url: await localStorage.save(file.buffer, type), bytes: file.size, type };
}
