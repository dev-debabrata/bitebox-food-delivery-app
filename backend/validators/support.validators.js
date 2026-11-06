import { body, query } from "express-validator";
import {
  REQUESTER_ROLES,
  TICKET_PRIORITY,
  TICKET_STATUS,
  TICKET_TYPES,
} from "../models/support-ticket.model.js";
import { mongoIdParam, paginationRules } from "./common.validators.js";

const message = (field = "message") =>
  body(field)
    .isString()
    .withMessage("Write a message")
    .bail()
    .trim()
    .isLength({ min: 2, max: 2000 })
    .withMessage("Message must be 2-2000 characters");

export const createTicketRules = [
  body("type").isIn(Object.values(TICKET_TYPES)).withMessage("Choose what this is about"),
  body("subject")
    .isString()
    .withMessage("Add a subject")
    .bail()
    .trim()
    .isLength({ min: 5, max: 120 })
    .withMessage("Subject must be 5-120 characters"),
  message(),
  body("orderNumber")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .matches(/^BB-\d{6}-[A-Z0-9]{6}$/i)
    .withMessage("Order numbers look like BB-261105-ABC123"),
];
export const myTicketListRules = [
  ...paginationRules,
  query("status").optional().isIn(["open", "closed"]),
];
export const replyRules = [mongoIdParam(), message("body")];

export const staffListRules = [
  ...paginationRules,
  query("status").optional().isIn([...Object.values(TICKET_STATUS), "active"]),
  query("priority").optional().isIn(Object.values(TICKET_PRIORITY)),
  query("requesterRole").optional().isIn(REQUESTER_ROLES),
  query("type").optional().isIn(Object.values(TICKET_TYPES)),
  query("assignee").optional().isIn(["me", "unassigned"]),
  query("search").optional().isString().trim().isLength({ max: 100 }),
];
export const updateTicketRules = [
  mongoIdParam(),
  body("status").optional().isIn(Object.values(TICKET_STATUS)),
  body("priority").optional().isIn(Object.values(TICKET_PRIORITY)),
  // null or "" unassigns, so it must not be treated as "not sent" (validate drops those).
  body("assigneeId")
    .optional()
    .custom((v) => v === null || v === "" || /^[a-f\d]{24}$/i.test(v))
    .withMessage("Invalid assignee"),
  body("note").optional().isString().trim().isLength({ max: 500 }),
];
export const staffMessageRules = [
  mongoIdParam(),
  message("body"),
  body("internal").optional().isBoolean().toBoolean(),
];
export const escalateRules = [
  mongoIdParam(),
  body("note")
    .isString()
    .trim()
    .isLength({ min: 5, max: 500 })
    .withMessage("Explain what finance should check (5-500 characters)"),
];
