"""
Celery app. Workers: `celery -A config worker`; schedules: `celery -A config beat` (exactly one).
Periodic tasks (dispatch sweep, payment window, rewards, purges) are added to `beat_schedule`
by the phases that own them (docs/django-migration/06 §6.3).
"""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.development")

app = Celery("bitebox")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
app.conf.beat_schedule = {
    # Expire rider offers, re-dispatch waiting orders, apply the order timeouts.
    "dispatch-sweep": {
        "task": "dispatch.sweep",
        "schedule": 15.0,  # apps/dispatch/config.py DISPATCH["sweep_interval_seconds"]
        "options": {"expires": 14},  # a backlog never runs stale sweeps
    },
    # Payments and refunds the browser and the webhooks missed (apps/payments/services.py).
    "payments-reconcile": {
        "task": "payments.reconcile",
        "schedule": 300.0,
        "options": {"expires": 290},
    },
}
