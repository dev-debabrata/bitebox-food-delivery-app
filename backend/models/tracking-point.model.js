import mongoose from "mongoose";
import { env } from "../config/env.js";

/**
 * The path a rider took while carrying an order. Sampled at most every
 * env.tracking.sampleSeconds per rider, only while they carry an order (never while just online).
 * MongoDB deletes points after env.tracking.retentionDays (TTL index).
 */
const trackingPointSchema = new mongoose.Schema({
  rider: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  accuracy: { type: Number, default: null },
  recordedAt: { type: Date, required: true },
});

trackingPointSchema.index({ order: 1, recordedAt: -1 });
trackingPointSchema.index({ rider: 1, recordedAt: -1 });
trackingPointSchema.index(
  { recordedAt: 1 },
  { expireAfterSeconds: env.tracking.retentionDays * 86_400 },
);

export const TrackingPoint = mongoose.model("TrackingPoint", trackingPointSchema);
