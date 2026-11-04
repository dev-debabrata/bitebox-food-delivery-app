import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const testOutbox = [];

let transporter;
const smtpConfigured = () =>
  Boolean(env.smtp.host && env.smtp.user && env.smtp.pass);

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  if (env.isTest) {
    testOutbox.push({ to, subject, text, html });
    return;
  }

  if (!smtpConfigured()) {
    if (env.isProduction) throw new Error("SMTP is not configured");
    logger.warn(
      { to, subject, text },
      "SMTP not configured - email logged instead of sent (development only)",
    );
    return;
  }

  await getTransporter().sendMail({
    from: env.smtp.from,
    to,
    subject,
    text,
    html,
  });
}
