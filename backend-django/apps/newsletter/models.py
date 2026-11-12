"""Newsletter sign-ups (Node: models/newsletter-subscription.model.js)."""

from django.db import models
from django.db.models.functions import Lower

from common.models import BaseModel, one_of


class SubscriptionStatus(models.TextChoices):
    SUBSCRIBED = "subscribed"
    UNSUBSCRIBED = "unsubscribed"


class NewsletterSubscription(BaseModel):
    email = models.EmailField(max_length=254)
    status = models.CharField(
        max_length=12, choices=SubscriptionStatus.choices, default=SubscriptionStatus.SUBSCRIBED
    )
    source = models.CharField(max_length=40, default="footer")
    subscribed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "newsletter_subscriptions"
        constraints = [
            models.UniqueConstraint(Lower("email"), name="newsletter_email_unique_ci"),
            one_of("status", SubscriptionStatus, "newsletter_status_valid"),
        ]
