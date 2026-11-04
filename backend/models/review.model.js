import mongoose from "mongoose";
import { REPORT_REASONS, REVIEW_POLICY } from "../config/reviews.js";

export const REVIEW_TARGETS = Object.freeze({
  RESTAURANT: "restaurant",
  FOOD: "food",
  RIDER: "rider",
});

export const REVIEW_STATUS = Object.freeze({
  PUBLISHED: "published",
  HIDDEN: "hidden", // by an admin, pending a decision; can be restored
  REMOVED: "removed", // by an admin for breaking the review policy
  DELETED: "deleted", // by its author; final
});

export const MODERATION_ACTIONS = Object.freeze({
  HIDE: "hide",
  REMOVE: "remove",
  RESTORE: "restore",
  DISMISS_REPORTS: "dismiss_reports",
});

const { ObjectId } = mongoose.Schema.Types;
const options = {
  timestamps: true,
  toJSON: {
    versionKey: false,
    transform: (_doc, ret) => {
      ret.id = String(ret._id);
      delete ret._id;
      return ret;
    },
  },
};
const rating = {
  type: Number,
  required: true,
  min: 1,
  max: 5,
  validate: { validator: Number.isInteger, message: "Rating must be 1 to 5" },
};

const moderationEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: Object.values(MODERATION_ACTIONS),
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: REVIEW_POLICY.moderationReasonMaxLength,
    },
    fromStatus: { type: String, enum: Object.values(REVIEW_STATUS) },
    toStatus: { type: String, enum: Object.values(REVIEW_STATUS) },
    by: { type: ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const reviewSchema = new mongoose.Schema(
  {
    target: {
      type: String,
      enum: Object.values(REVIEW_TARGETS),
      required: true,
    },
    customer: { type: ObjectId, ref: "User", required: true },
    // Snapshot of the author's name at posting time, shown shortened ("Asha C.").
    customerName: { type: String, required: true, maxlength: 80 },
    order: { type: ObjectId, ref: "Order", required: true },
    orderNumber: { type: String, required: true },
    // Always the order's restaurant, so a restaurant can list every review of its food and service.
    restaurant: { type: ObjectId, ref: "Restaurant", required: true },
    // The order line (orders hold one line per dish) for food reviews.
    foodItem: { type: ObjectId, ref: "FoodItem", default: null },
    foodName: { type: String, maxlength: 100 },
    // The rider's User id for rider reviews.
    deliveryPartner: { type: ObjectId, ref: "User", default: null },

    rating,
    comment: {
      type: String,
      trim: true,
      maxlength: REVIEW_POLICY.commentMaxLength,
      default: "",
    },
    images: {
      type: [{ type: String, maxlength: 500 }],
      default: [],
      validate: {
        validator: (v) => v.length <= REVIEW_POLICY.maxImages,
        message: `At most ${REVIEW_POLICY.maxImages} photos`,
      },
    },
    status: {
      type: String,
      enum: Object.values(REVIEW_STATUS),
      default: REVIEW_STATUS.PUBLISHED,
    },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    // Earlier versions, kept for moderation; customers edit, nobody rewrites history.
    edits: {
      type: [
        {
          _id: false,
          rating,
          comment: String,
          images: [String],
          replacedAt: { type: Date, required: true },
        },
      ],
      select: false,
    },

    response: {
      text: {
        type: String,
        trim: true,
        maxlength: REVIEW_POLICY.responseMaxLength,
      },
      respondedAt: Date,
      updatedAt: Date,
    },

    openReports: { type: Number, default: 0, min: 0 },
    moderation: {
      action: { type: String, enum: Object.values(MODERATION_ACTIONS) },
      reason: String,
      at: Date,
    },
    moderationLog: { type: [moderationEntrySchema], select: false },
  },
  options,
);

// One review per order and subject: the restaurant, each dish (by food item) and the rider.
reviewSchema.index(
  { order: 1, target: 1, foodItem: 1 },
  { unique: true, name: "one_review_per_order_subject" },
);
reviewSchema.index({ customer: 1, createdAt: -1 });
reviewSchema.index({ target: 1, restaurant: 1, status: 1, createdAt: -1 });
reviewSchema.index({ target: 1, restaurant: 1, status: 1, rating: 1 });
reviewSchema.index({ foodItem: 1, status: 1, createdAt: -1 });
reviewSchema.index({ deliveryPartner: 1, status: 1, createdAt: -1 });
// The "Reported" queue and its badge.
reviewSchema.index({ openReports: 1, status: 1 });
reviewSchema.index({ createdAt: -1 });

export const Review = mongoose.model("Review", reviewSchema);

export const REPORT_STATUS = Object.freeze({
  OPEN: "open",
  ACTIONED: "actioned", // the review was hidden or removed
  DISMISSED: "dismissed", // looked at, no action needed
});

const reviewReportSchema = new mongoose.Schema(
  {
    review: { type: ObjectId, ref: "Review", required: true },
    reporter: { type: ObjectId, ref: "User", required: true },
    reporterRole: { type: String, required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: {
      type: String,
      trim: true,
      maxlength: REVIEW_POLICY.reportNoteMaxLength,
    },
    status: {
      type: String,
      enum: Object.values(REPORT_STATUS),
      default: REPORT_STATUS.OPEN,
    },
    resolvedAt: Date,
    resolvedBy: { type: ObjectId, ref: "User" },
  },
  options,
);

reviewReportSchema.index({ review: 1, reporter: 1 }, { unique: true });
reviewReportSchema.index({ review: 1, status: 1 });
reviewReportSchema.index({ status: 1, createdAt: -1 });

export const ReviewReport = mongoose.model("ReviewReport", reviewReportSchema);
