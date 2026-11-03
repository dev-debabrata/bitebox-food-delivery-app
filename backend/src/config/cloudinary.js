import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

const { cloudName, apiKey, apiSecret } = env.cloudinary;

/** True when all Cloudinary keys are set: uploaded images are then stored there. */
export const cloudinaryEnabled = Boolean(cloudName && apiKey && apiSecret);

if (cloudinaryEnabled) cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });

export default cloudinary;
