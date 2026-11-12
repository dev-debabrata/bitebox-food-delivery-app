from celery import shared_task


@shared_task(name="common.ping")
def ping() -> str:
    """Round trip through the broker and a worker (used by smoke tests and runbooks)."""
    return "pong"
