import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

const { cloudName, apiKey, apiSecret } = env.cloudinary;

export const cloudinaryEnabled = Boolean(cloudName && apiKey && apiSecret);

if (cloudinaryEnabled)
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

export default cloudinary;
