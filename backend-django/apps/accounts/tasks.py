from datetime import datetime, timedelta

from celery import shared_task
from django.utils import timezone

from .models import OtpChallenge, Session


def purge(now: "datetime | None" = None) -> int:
    """Expired refresh sessions and sign-in codes older than a day (they only matter for limits)."""
    now = now or timezone.now()
    sessions, _ = Session.objects.filter(expires_at__lt=now).delete()
    codes, _ = OtpChallenge.objects.filter(created_at__lt=now - timedelta(days=1)).delete()
    return sessions + codes


@shared_task(name="accounts.purge", ignore_result=True)
def purge_task() -> int:
    """Celery Beat (daily)."""
    return purge()
