from typing import Any

from django.apps import AppConfig

WELCOME = {
    "customer": (
        "Welcome to BiteBox, {name}!",
        "Find a restaurant near you and order in minutes.",
        "/",
    ),
    "restaurant": (
        "Welcome to BiteBox, {name}!",
        "Add your restaurant details to start receiving orders.",
        "/restaurant/details",
    ),
    "delivery": (
        "Welcome to BiteBox, {name}!",
        "Add your vehicle, go online and start earning.",
        "/delivery",
    ),
}


def welcome(user: Any, data: Any, meta: Any) -> None:
    """A registration hook: the welcome notification (in-app, and email when allowed)."""
    from .services import notify

    title, body, link = WELCOME.get(user.role, WELCOME["customer"])
    notify(
        user.pk, type="account.welcome", title=title.format(name=user.name), body=body, link=link
    )


class NotificationsConfig(AppConfig):
    name = "apps.notifications"
    label = "notifications"

    def ready(self) -> None:
        from apps.accounts.services import registration_hooks

        if welcome not in registration_hooks:
            registration_hooks.append(welcome)
