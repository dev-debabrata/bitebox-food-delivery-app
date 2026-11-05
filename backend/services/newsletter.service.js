import { NewsletterSubscription } from "../models/newsletter-subscription.model.js";

/**
 * Adds an email to the newsletter list. Repeating it is harmless: an existing subscriber gets
 * `alreadySubscribed: true`, and someone who unsubscribed earlier is subscribed again.
 */
export async function subscribe(email, source = "footer") {
  const now = new Date();
  try {
    const before = await NewsletterSubscription.findOneAndUpdate(
      { email },
      {
        $set: { status: "subscribed" },
        $setOnInsert: { email, source, subscribedAt: now },
      },
      { upsert: true, returnDocument: "before", runValidators: true },
    );
    return { subscribed: true, alreadySubscribed: before?.status === "subscribed" };
  } catch (error) {
    // Two identical requests at the same moment: the other one created it.
    if (error?.code === 11000) return { subscribed: true, alreadySubscribed: true };
    throw error;
  }
}
