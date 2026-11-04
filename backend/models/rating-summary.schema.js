import mongoose from "mongoose";

/**
 * A cached rating summary, rebuilt from published reviews by review.service#refreshRating.
 * `distribution[i]` is the number of (i + 1)-star reviews.
 */
export const ratingSummarySchema = new mongoose.Schema(
  {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0, min: 0 },
    distribution: {
      type: [{ type: Number, min: 0 }],
      default: () => [0, 0, 0, 0, 0],
    },
  },
  { _id: false },
);

export const emptyRating = () => ({
  average: 0,
  count: 0,
  distribution: [0, 0, 0, 0, 0],
});
