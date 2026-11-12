from celery import shared_task

from .services import reconcile


@shared_task(name="payments.reconcile")
def reconcile_task() -> dict[str, int]:
    """Celery Beat: settle payments and refunds the browser and the webhooks missed."""
    return reconcile()
