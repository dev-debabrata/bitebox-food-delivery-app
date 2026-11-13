import { body } from "express-validator";
import { ALL_ROLES, SELF_REGISTER_ROLES } from "../models/user.model.js";

export const email = () =>
  body("email")
    .isString()
    .withMessage("Email is required")
    .bail()
    .trim()
    .isEmail()
    .withMessage("Enter a valid email address")
    .bail()
    .isLength({ max: 254 })
    .normalizeEmail({
      gmail_remove_dots: false,
      gmail_remove_subaddress: false,
    });

export const newPassword = (field = "password") =>
  body(field)
    .isString()
    .withMessage("Password is required")
    .bail()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .custom((value) => Buffer.byteLength(value, "utf8") <= 72)
    .withMessage("Password is too long")
    .matches(/[A-Za-z]/)
    .withMessage("Password must contain a letter")
    .matches(/[0-9]/)
    .withMessage("Password must contain a number");

export const name = () =>
  body("name")
    .isString()
    .withMessage("Name is required")
    .bail()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage("Name must be 2-80 characters");

export const phone = () =>
  body("phone")
    .optional({ values: "falsy" })
    .isString()
    .bail()
    .trim()
    .matches(/^\+?[0-9]{10,15}$/)
    .withMessage("Enter a valid phone number (10-15 digits)");

export const registerRules = [
  name(),
  email(),
  phone(),
  newPassword(),
  body("role").optional().isIn(SELF_REGISTER_ROLES).withMessage("Invalid role"),
  body("referralCode")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9-]{4,40}$/)
    .withMessage("Enter a valid referral code"),
  // The SMS code from POST /auth/register/code (needed while signupNeedsCode()).
  body("code").optional().isString().bail().matches(/^\d{6}$/).withMessage("Enter the 6-digit code"),
];

export const loginRules = [
  email(),
  body("password")
    .isString()
    .withMessage("Password is required")
    .bail()
    .isLength({ min: 1, max: 128 }),
  body("portal").optional().isIn(ALL_ROLES).withMessage("Invalid portal"),
];

export const forgotPasswordRules = [email()];

export const resetPasswordRules = [
  body("token")
    .isString()
    .withMessage("Reset token is required")
    .bail()
    .isLength({ min: 20, max: 200 }),
  newPassword(),
];

export const changePasswordRules = [
  body("currentPassword")
    .isString()
    .withMessage("Current password is required")
    .bail()
    .isLength({ min: 1, max: 128 }),
  newPassword("newPassword"),
];

export const updateProfileRules = [
  name().optional(),
  body("phone")
    .optional({ values: "null" })
    .isString()
    .bail()
    .trim()
    .custom((value) => value === "" || /^\+?[0-9]{10,15}$/.test(value))
    .withMessage("Enter a valid phone number (10-15 digits)"),
  // null or "" removes the photo.
  body("avatarUrl")
    .optional()
    .custom((v) => v === null || v === "" || (typeof v === "string" && v.length <= 500 && /^https?:\/\//.test(v)))
    .withMessage("Enter a valid photo URL"),
];

const requiredPhone = () =>
  body("phone")
    .isString()
    .withMessage("Enter your mobile number")
    .bail()
    .trim()
    .matches(/^\+?[0-9]{10,15}$/)
    .withMessage("Enter a valid phone number (10-15 digits)");
const otpCode = () =>
  body("code").isString().bail().matches(/^\d{6}$/).withMessage("Enter the 6-digit code");

export const otpRequestRules = [requiredPhone()];
export const signupCodeRules = [email(), requiredPhone()];
export const otpLoginRules = [
  requiredPhone(),
  otpCode(),
  body("portal").optional().isIn(ALL_ROLES).withMessage("Invalid portal"),
];
export const otpCodeRules = [otpCode()];
export const emailVerifyRules = [
  body("token").isString().bail().isLength({ min: 20, max: 200 }).withMessage("Verification token is required"),
];
