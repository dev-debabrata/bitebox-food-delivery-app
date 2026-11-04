/**
 * The review policy. Customers review what they actually received: the restaurant, each dish
 * and the rider of a delivered order, once each. Deleting a review is final for that order.
 */
export const REVIEW_POLICY = Object.freeze({
  // Reviews can be written for this many days after the order was delivered.
  submitWindowDays: 30,
  // A review can be edited for this many days after it was first posted.
  editWindowDays: 30,
  commentMaxLength: 1000,
  responseMaxLength: 1000,
  reportNoteMaxLength: 300,
  moderationReasonMaxLength: 300,
  // Photos per review (restaurant and dish reviews only), uploaded through /uploads/review-images.
  maxImages: 5,
  // Restaurants and riders are ranked only once they have this many reviews (admin analytics).
  minReviewsToRank: 3,
});

export const REPORT_REASONS = Object.freeze([
  "spam",
  "offensive",
  "harassment",
  "personal_info",
  "irrelevant",
  "fake",
  "other",
]);
