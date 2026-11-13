"""Notification jobs: one delivery attempt, the retry sweep, the daily purge, promotions."""

from celery import shared_task

from . import services


@shared_task(name="notifications.deliver", ignore_result=True)
def deliver(delivery_id: str) -> str | None:
    """One attempt at one delivery; a failure is retried later by `notifications.retry`."""
    return services.attempt(delivery_id)


@shared_task(name="notifications.retry", ignore_result=True)
def retry_due() -> int:
    return services.retry_due()


@shared_task(name="notifications.purge", ignore_result=True)
def purge() -> int:
    return services.purge()


@shared_task(name="notifications.promotion", ignore_result=True)
def push_promotion(user_ids: list[str], title: str, body: str, link: str) -> int:
    return services.deliver_promotion(user_ids, title, body, link)
