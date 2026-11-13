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
    # Notification deliveries whose retry time has come, and inbox rows past 90 days.
    "notifications-retry": {
        "task": "notifications.retry",
        "schedule": 60.0,
        "options": {"expires": 55},
    },
    "notifications-purge": {"task": "notifications.purge", "schedule": 24 * 60 * 60.0},
    # Tracking points past their retention period (apps/tracking/services.py).
    "tracking-purge": {"task": "tracking.purge", "schedule": 24 * 60 * 60.0},
    # Expired refresh sessions and old sign-in codes (apps/accounts/tasks.py).
    "accounts-purge": {"task": "accounts.purge", "schedule": 24 * 60 * 60.0},
    # Payments and refunds the browser and the webhooks missed (apps/payments/services.py).
    "payments-reconcile": {
        "task": "payments.reconcile",
        "schedule": 300.0,
        "options": {"expires": 290},
    },
    # Coin expiry, unclosed coin holds, referral windows, campaign dates, birthdays
    # (apps/coins/tasks.py; Node REWARDS_JOBS.sweepIntervalMs).
    "coins-rewards-sweep": {
        "task": "coins.rewards_sweep",
        "schedule": 120.0,
        "options": {"expires": 110},
    },
}
