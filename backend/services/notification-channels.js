import fs from "node:fs";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DeviceToken } from "../models/device-token.model.js";
import { CHANNELS } from "../models/notification-delivery.model.js";
import { sendMail } from "./mail.service.js";
import { categoryOf, isPushEnabled, pushToUser } from "./push.service.js";

/**
 * What each notification type sends where, how it reads on email and SMS, and the channel
 * senders (same rules as backend-django/apps/notifications/{content,senders}.py).
 *
 * Web Push and FCM carry every type the person allows; email and SMS only the types below. A
 * sender resolves once sent, throws `Skip` when there is nothing to send to, `PermanentFailure`
 * when a retry cannot help, and any other error for a temporary failure (retried with back-off).
 */

export const EMAIL_TYPES = new Set([
  "account.welcome",
  "order.placed",
  "order.rejected",
  "order.cancelled",
  "order.delivered",
  "payment.failed",
  "payment.refund_started",
  "payment.refunded",
  "payment.refund_failed",
]);
export const SMS_TYPES = new Set([
  "order.picked_up", // carries the delivery code
  "order.delivery_code",
  "order.approaching",
  "order.cancelled",
  "order.rejected",
]);
const SMS_MAX = 160;

export class Skip extends Error {}
export class PermanentFailure extends Error {}

/** The external channels this type may use (preferences and targets decide the rest). */
export function channelsFor(type) {
  const channels = [CHANNELS.PUSH, CHANNELS.FCM];
  if (EMAIL_TYPES.has(type)) channels.push(CHANNELS.EMAIL);
  if (SMS_TYPES.has(type)) channels.push(CHANNELS.SMS);
  return channels;
}

export { categoryOf };

const absoluteLink = (link) => {
  const path = typeof link === "string" && link.startsWith("/") && !link.startsWith("//") ? link : "/";
  return `${env.clientUrls[0].replace(/\/$/, "")}${path}`;
};
const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** { subject, text, html } in BiteBox's simple email layout. */
export function renderEmail({ title, body, link }, name) {
  const url = absoluteLink(link);
  const footer =
    "You get this email because of your BiteBox account. Change which emails you get in Account, Notifications.";
  return {
    subject: `${title} | BiteBox`,
    text: [`Hi ${name},`, "", title, ...(body ? ["", body] : []), "", `Open BiteBox: ${url}`, "", footer].join("\n"),
    html: `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f6f3f8;font-family:Arial,Helvetica,sans-serif;color:#2e1a3d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px">
<tr><td style="padding:24px 28px 8px"><strong style="font-size:20px">BiteBox</strong></td></tr>
<tr><td style="padding:8px 28px 24px;font-size:15px;line-height:1.5">
<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
<h1 style="margin:0 0 8px;font-size:20px">${escapeHtml(title)}</h1>
${body ? `<p style="margin:0 0 20px">${escapeHtml(body)}</p>` : ""}
<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#2e1a3d;color:#ffffff;text-decoration:none;font-weight:bold">Open BiteBox</a>
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;color:#6b5a78;border-top:1px solid #eee6f2">${footer}</td></tr>
</table></body></html>`,
  };
}

export function renderSms({ title, body }) {
  const text = `BiteBox: ${title}. ${body ?? ""}`.trim();
  return text.length <= SMS_MAX ? text : `${text.slice(0, SMS_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// Senders. Each gets (notification, user).
// ---------------------------------------------------------------------------

async function sendPush(notification, user) {
  const { browsers, sent } = await pushToUser(user._id, notification);
  if (!sent) {
    if (!browsers) throw new Skip("No subscribed browser");
    throw new Error("No browser accepted the push");
  }
}

let fcmToken = { token: null, expires: 0 };
async function fcmAccessToken(account) {
  if (fcmToken.expires > Date.now() + 60_000) return fcmToken.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
  const res = await fetch(account.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM token request failed (${res.status})`);
  const data = await res.json();
  fcmToken = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return fcmToken.token;
}

async function sendFcm(notification, user) {
  const devices = await DeviceToken.find({ user: user._id });
  if (!devices.length) throw new Skip("No app installed");
  const account = JSON.parse(fs.readFileSync(env.notifications.fcmCredentialsFile, "utf8"));
  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const headers = { Authorization: `Bearer ${await fcmAccessToken(account)}`, "Content-Type": "application/json" };
  let sent = 0;
  for (const device of devices) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: {
          token: device.token,
          notification: { title: notification.title, body: notification.body ?? "" },
          data: { type: notification.type, url: notification.link ?? "/" },
        },
      }),
    });
    if (res.ok) {
      sent += 1;
      await DeviceToken.updateOne({ _id: device._id }, { $set: { failures: 0, lastSuccessAt: new Date() } });
    } else if ([400, 404].includes(res.status) && (await res.text()).includes("UNREGISTERED")) {
      await DeviceToken.deleteOne({ _id: device._id }); // the app was uninstalled
    } else {
      await DeviceToken.updateOne({ _id: device._id }, { $inc: { failures: 1 } });
    }
  }
  if (!sent) throw new Error("No device accepted the message");
}

async function sendEmail(notification, user) {
  if (!user.email) throw new Skip("No email address");
  await sendMail({ to: user.email, ...renderEmail(notification, user.name) });
}

/** The "test" SMS provider (tests only). */
export const testSmsOutbox = [];

async function sendSms(notification, user) {
  if (!user.phone) throw new Skip("No phone number");
  await deliverSms(user.phone, renderSms(notification));
}

/** One SMS through the configured provider (notifications and sign-in codes). */
export async function deliverSms(phone, text, templateId) {
  switch (smsProvider()) {
    case "test":
      testSmsOutbox.push({ to: phone, text });
      return;
    case "console":
      // Development only: the text is shown so sign-in codes can be read from the log.
      logger.info(`SMS to ...${phone.slice(-4)} (console provider, not sent): ${text}`);
      return;
    case "msg91": {
      const res = await fetch("https://control.msg91.com/api/v5/flow", {
        method: "POST",
        headers: { authkey: env.notifications.msg91AuthKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: templateId || env.notifications.msg91TemplateId,
          short_url: "0",
          recipients: [{ mobiles: phone.replace(/^\+/, ""), message: text }],
        }),
      });
      if ([400, 401, 403].includes(res.status))
        throw new PermanentFailure(`MSG91 refused the message (${res.status})`);
      if (!res.ok) throw new Error(`MSG91 failed (${res.status})`);
      return;
    }
    default:
      throw new Skip("SMS is off");
  }
}

// ---------------------------------------------------------------------------
// Registry (tests swap senders and switch channels on)
// ---------------------------------------------------------------------------

const SENDERS = { push: sendPush, fcm: sendFcm, email: sendEmail, sms: sendSms };
const overrides = new Map();
const smsProvider = () => overrides.get("smsProvider") ?? env.notifications.smsProvider;

export const senderFor = (channel) => overrides.get(channel) ?? SENDERS[channel];

export function channelEnabled(channel) {
  if (channel === CHANNELS.PUSH) return isPushEnabled();
  if (channel === CHANNELS.FCM) return overrides.has(CHANNELS.FCM) || Boolean(env.notifications.fcmCredentialsFile);
  if (channel === CHANNELS.SMS) {
    const provider = smsProvider();
    return provider === "msg91" ? Boolean(env.notifications.msg91AuthKey) : ["console", "test"].includes(provider);
  }
  return env.notifications.emails;
}

/** Tests: replace a channel's sender (null restores it), or set "smsProvider". */
export function useChannel(name, value) {
  if (value == null) overrides.delete(name);
  else overrides.set(name, value);
}
