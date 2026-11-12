"""Periodic dispatch work (Node ran it on a setInterval in server.js; here Celery Beat does)."""

from typing import Any

from celery import shared_task

from . import services


@shared_task(name="dispatch.sweep", ignore_result=True)
def dispatch_sweep() -> dict[str, Any]:
    """Every step is a compare-and-set, so an overlapping run cannot double-apply anything."""
    return services.sweep()
