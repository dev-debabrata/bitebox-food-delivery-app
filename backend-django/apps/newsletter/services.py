"""Newsletter sign-ups (Node: services/newsletter.service.js)."""

from typing import Any

from django.db import IntegrityError, transaction

from .models import NewsletterSubscription, SubscriptionStatus

S = SubscriptionStatus


def subscribe(email: str, source: str = "footer") -> dict[str, Any]:
    """
    Adds an email to the newsletter list. Repeating it is harmless: an existing subscriber gets
    `alreadySubscribed: true`, and someone who unsubscribed earlier is subscribed again.
    """
    try:
        with transaction.atomic():
            row = NewsletterSubscription.objects.select_for_update().filter(email__iexact=email)
            existing = row.first()
            if existing is None:
                NewsletterSubscription.objects.create(email=email, source=source)
                return {"subscribed": True, "alreadySubscribed": False}
            if existing.status == S.SUBSCRIBED:
                return {"subscribed": True, "alreadySubscribed": True}
            existing.status = S.SUBSCRIBED
            existing.save(update_fields=["status", "updated_at"])
            return {"subscribed": True, "alreadySubscribed": False}
    except IntegrityError:
        # Two identical requests at the same moment: the other one created it.
        return {"subscribed": True, "alreadySubscribed": True}
