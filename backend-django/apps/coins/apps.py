from typing import Any

from django.apps import AppConfig


class CoinsConfig(AppConfig):
    name = "apps.coins"
    label = "coins"

    def ready(self) -> None:
        # Sign-up reaches the rewards programme through the accounts hooks (Node:
        # auth.service.js#register → referral.resolveCode, rewardEvents.customerRegistered).
        from apps.accounts import services as accounts

        if _check_referral_code not in accounts.registration_checks:
            accounts.registration_checks.append(_check_referral_code)
        if _customer_registered not in accounts.registration_hooks:
            accounts.registration_hooks.append(_customer_registered)


def _check_referral_code(data: dict[str, Any]) -> None:
    """A referral code is checked before the account exists: a bad code refuses the sign-up."""
    from apps.rbac.roles import Role

    from .referrals import resolve_code

    if data.get("referral_code") and (data.get("role") or Role.CUSTOMER) == Role.CUSTOMER:
        data["_referral"] = resolve_code(data["referral_code"])


def _customer_registered(user: Any, data: dict[str, Any], meta: Any) -> None:
    from apps.rbac.roles import Role

    from .events import customer_registered

    if user.role == Role.CUSTOMER:
        customer_registered(user, data.get("_referral"), getattr(meta, "ip", None))
