export const REVIEW_POLICY = Object.freeze({
  submitWindowDays: 30,
  editWindowDays: 30,
  commentMaxLength: 1000,
  responseMaxLength: 1000,
  reportNoteMaxLength: 300,
  moderationReasonMaxLength: 300,
  maxImages: 5,
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
