import { body, query } from "express-validator";
import { REPORT_REASONS, REVIEW_POLICY } from "../config/reviews.js";
import { MODERATION_MOVES } from "../services/review-moderation.service.js";
import {
  REVIEW_STATUS,
  REVIEW_TARGETS,
} from "../models/review.model.js";
import { isUploadedImageUrl } from "../services/upload.service.js";
import {
  booleanQuery,
  mongoIdParam,
  paginationRules,
  searchQuery,
} from "./common.validators.js";

const T = REVIEW_TARGETS;
const P = REVIEW_POLICY;

const ratingOf = (field, optional = true) =>
  (optional ? body(field).optional() : body(field))
    .isInt({ min: 1, max: 5 })
    .withMessage("Choose a rating from 1 to 5 stars")
    .toInt();
const commentBody = () =>
  body("comment")
    .optional({ values: "null" })
    .isString()
    .withMessage("Comment must be text")
    .trim()
    .isLength({ max: P.commentMaxLength })
    .withMessage(`Keep the review under ${P.commentMaxLength} characters`);
const imagesBody = (field = "images") => [
  body(field)
    .optional()
    .isArray({ max: P.maxImages })
    .withMessage(`Add up to ${P.maxImages} photos`),
  body(`${field}.*`)
    .isString()
    .custom(isUploadedImageUrl)
    .withMessage("Upload photos through BiteBox"),
];
const reasonBody = (max, message = "Give a reason") =>
  body("reason")
    .exists({ values: "falsy" })
    .withMessage(message)
    .bail()
    .isString()
    .trim()
    .isLength({ min: 3, max })
    .withMessage(`The reason must be 3 to ${max} characters`);

const ratingQuery = () =>
  query("rating").optional().isInt({ min: 1, max: 5 }).toInt();
const sortQuery = () =>
  query("sort").optional().isIn(["newest", "oldest", "highest", "lowest"]);

export const publicListRules = [ratingQuery(), sortQuery(), ...paginationRules];
export const publicFoodListRules = [mongoIdParam(), ...publicListRules];

// Customer
export const createRules = [
  body("orderId").isMongoId().withMessage("Invalid order"),
  body("target")
    .isIn(Object.values(T))
    .withMessage("Review the restaurant, a dish or the rider"),
  body("foodItemId")
    .if(body("target").equals(T.FOOD))
    .isMongoId()
    .withMessage("Choose the dish you are reviewing"),
  ratingOf("rating", false),
  commentBody(),
  ...imagesBody(),
  body("images")
    .if(body("target").equals(T.RIDER))
    .not()
    .exists()
    .withMessage("Delivery ratings don't take photos"),
];
export const updateRules = [
  mongoIdParam(),
  ratingOf("rating"),
  commentBody(),
  ...imagesBody(),
  body().custom((value) => {
    if (
      value?.rating === undefined &&
      value?.comment === undefined &&
      value?.images === undefined
    )
      throw new Error("Change the rating, the comment or the photos");
    return true;
  }),
];
/** One "Rate your experience" submission: restaurant, food quality and delivery, plus words and photos. */
export const orderReviewRules = [
  mongoIdParam(),
  ratingOf("restaurant"),
  ratingOf("food"),
  ratingOf("rider"),
  commentBody(),
  ...imagesBody(),
  body().custom((value) => {
    const { restaurant, food, rider, comment, images } = value ?? {};
    if (restaurant === undefined && food === undefined && rider === undefined)
      throw new Error("Rate at least one part of the order");
    if ((comment || images?.length) && restaurant === undefined)
      throw new Error("Rate the restaurant to add a review or photos");
    return true;
  }),
];
export const mineRules = [
  query("target").optional().isIn(Object.values(T)),
  sortQuery(),
  ...paginationRules,
];
export const reportRules = [
  mongoIdParam(),
  body("reason")
    .isIn(REPORT_REASONS)
    .withMessage(`Reason must be one of: ${REPORT_REASONS.join(", ")}`),
  body("note")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .isLength({ max: P.reportNoteMaxLength })
    .withMessage(`Keep the note under ${P.reportNoteMaxLength} characters`),
];

// Restaurant
export const restaurantListRules = [
  query("target").optional().isIn([T.RESTAURANT, T.FOOD]),
  query("foodItemId").optional().isMongoId(),
  ratingQuery(),
  booleanQuery("responded"),
  sortQuery(),
  ...paginationRules,
];
export const responseRules = [
  mongoIdParam(),
  body("text")
    .isString()
    .withMessage("Write a reply")
    .trim()
    .isLength({ min: 2, max: P.responseMaxLength })
    .withMessage(`The reply must be 2 to ${P.responseMaxLength} characters`),
];

// Rider
export const riderListRules = [ratingQuery(), sortQuery(), ...paginationRules];

// Admin
export const adminListRules = [
  query("target").optional().isIn(Object.values(T)),
  query("status").optional().isIn(Object.values(REVIEW_STATUS)),
  query("restaurantId").optional().isMongoId(),
  booleanQuery("reported"),
  ratingQuery(),
  searchQuery(),
  ...paginationRules,
];
export const moderateRules = [
  mongoIdParam(),
  body("action")
    .isIn(Object.keys(MODERATION_MOVES))
    .withMessage("Action must be hide, remove or restore"),
  reasonBody(P.moderationReasonMaxLength, "Record why (customers see this)"),
];
export const dismissRules = [
  mongoIdParam(),
  reasonBody(P.moderationReasonMaxLength),
];
