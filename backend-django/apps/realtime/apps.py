from django.apps import AppConfig


class RealtimeConfig(AppConfig):
    name = "apps.realtime"
    label = "realtime"

    def ready(self) -> None:
        from apps.notifications.services import delivery_hooks

        from .events import emit_notifications

        if emit_notifications not in delivery_hooks:
            delivery_hooks.append(emit_notifications)
