from celery import shared_task

from .services import purge


@shared_task(name="tracking.purge", ignore_result=True)
def purge_task() -> int:
    """Celery Beat (daily): drop tracking points past the retention period."""
    return purge()
