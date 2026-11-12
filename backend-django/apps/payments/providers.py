"""
Payment providers (Node: services/payments/{mock,razorpay}.provider.js).

- `RazorpayProvider` is used when both Razorpay keys are set. It talks to the REST API through a
  small client (`RazorpayClient`); tests inject a fake client instead.
- `MockProvider` simulates payments for development. It is never used in production
  (`PAYMENTS_MOCK_ENABLED` is forced off there).
- `online_provider()` picks the one in use; tests swap it with `use_online_provider`.
"""

import base64
import hashlib
import hmac
import json
import secrets
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Protocol

from django.conf import settings

from .models import Provider

RAZORPAY_API = "https://api.razorpay.com/v1"

# Razorpay refund states → ours. "pending" means the bank has not confirmed it yet.
REFUND_DONE = "processed"
REFUND_FAILED = "failed"


class PaymentProvider(Protocol):
    name: str
    label: str
    simulated: bool
    key_id: str | None

    def create_order(self, amount_paise: int, receipt: str, notes: dict[str, str]) -> str:
        """Creates the gateway order; returns its id."""
        ...

    def refund(self, provider_payment_id: str, amount_paise: int, receipt: str) -> dict[str, str]:
        """Returns {"provider_refund_id", "status"} (status "processed", "pending" or "failed")."""
        ...

    def refund_status(self, provider_refund_id: str) -> str: ...

    def order_payments(self, provider_order_id: str) -> list[dict[str, Any]]:
        """Payments made against a gateway order: [{"id", "status", "amount_paise"}]."""
        ...


class MockProvider:
    name = Provider.MOCK.value
    label = "Test payment (simulated, no real money)"
    simulated = True
    key_id: str | None = None

    def create_order(self, amount_paise: int, receipt: str, notes: dict[str, str]) -> str:
        return f"mock_order_{secrets.token_hex(8)}"

    def refund(self, provider_payment_id: str, amount_paise: int, receipt: str) -> dict[str, str]:
        return {"provider_refund_id": f"mock_refund_{receipt}", "status": REFUND_DONE}

    def refund_status(self, provider_refund_id: str) -> str:
        return REFUND_DONE

    def order_payments(self, provider_order_id: str) -> list[dict[str, Any]]:
        return []  # simulated payments finish only through the test dialog


class RazorpayClient:
    """The few Razorpay REST calls we need (basic auth with the key id and secret)."""

    def __init__(self, key_id: str, key_secret: str, timeout: float = 10) -> None:
        token = base64.b64encode(f"{key_id}:{key_secret}".encode()).decode()
        self._auth = f"Basic {token}"
        self._timeout = timeout

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(  # noqa: S310 (fixed https base URL)
            f"{RAZORPAY_API}{path}",
            data=data,
            method=method,
            headers={"Authorization": self._auth, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
            return json.loads(response.read())

    def create_order(self, body: dict[str, Any]) -> dict[str, Any]:
        return dict(self._call("POST", "/orders", body))

    def fetch_payment(self, payment_id: str) -> dict[str, Any]:
        return dict(self._call("GET", f"/payments/{payment_id}"))

    def order_payments(self, order_id: str) -> list[dict[str, Any]]:
        return list(self._call("GET", f"/orders/{order_id}/payments").get("items", []))

    def refund(self, payment_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return dict(self._call("POST", f"/payments/{payment_id}/refund", body))

    def fetch_refund(self, refund_id: str) -> dict[str, Any]:
        return dict(self._call("GET", f"/refunds/{refund_id}"))


def _hmac_hex(secret: str, data: bytes) -> str:
    return hmac.new(secret.encode(), data, hashlib.sha256).hexdigest()


def _same(expected: str, given: Any) -> bool:
    return isinstance(given, str) and hmac.compare_digest(expected, given)


class RazorpayProvider:
    name = Provider.RAZORPAY.value
    label = "Pay online (UPI, cards, netbanking)"
    simulated = False

    def __init__(
        self, key_id: str, key_secret: str, webhook_secret: str, client: Any = None
    ) -> None:
        self.key_id: str | None = key_id
        self._secret = key_secret
        self._webhook_secret = webhook_secret
        self._client = client or RazorpayClient(key_id, key_secret)

    def create_order(self, amount_paise: int, receipt: str, notes: dict[str, str]) -> str:
        order = self._client.create_order(
            {"amount": amount_paise, "currency": "INR", "receipt": receipt, "notes": notes}
        )
        return str(order["id"])

    def verify_checkout_signature(
        self, provider_order_id: str, provider_payment_id: str, signature: str
    ) -> bool:
        """Checkout's handler result: "order_id|payment_id" signed with the key secret."""
        message = f"{provider_order_id}|{provider_payment_id}".encode()
        return _same(_hmac_hex(self._secret, message), signature)

    def verify_webhook_signature(self, raw_body: bytes, signature: Any) -> bool:
        """Webhooks are signed over the exact raw request body with the webhook secret."""
        return bool(self._webhook_secret) and _same(
            _hmac_hex(self._webhook_secret, raw_body), signature
        )

    def fetch_payment(self, provider_payment_id: str) -> dict[str, Any]:
        p = self._client.fetch_payment(provider_payment_id)
        return {
            "status": p.get("status"),
            "amount_paise": p.get("amount"),
            "provider_order_id": p.get("order_id"),
            "failure_reason": p.get("error_description"),
        }

    def order_payments(self, provider_order_id: str) -> list[dict[str, Any]]:
        return [
            {"id": p.get("id"), "status": p.get("status"), "amount_paise": p.get("amount")}
            for p in self._client.order_payments(provider_order_id)
        ]

    def refund(self, provider_payment_id: str, amount_paise: int, receipt: str) -> dict[str, str]:
        refund = self._client.refund(
            provider_payment_id, {"amount": amount_paise, "receipt": receipt[:40]}
        )
        return {"provider_refund_id": str(refund["id"]), "status": str(refund.get("status", ""))}

    def refund_status(self, provider_refund_id: str) -> str:
        return str(self._client.fetch_refund(provider_refund_id).get("status", ""))


_UNSET: Any = object()
_override: Any = _UNSET


def razorpay_from_settings() -> RazorpayProvider | None:
    if settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET:
        return RazorpayProvider(
            settings.RAZORPAY_KEY_ID,
            settings.RAZORPAY_KEY_SECRET,
            settings.RAZORPAY_WEBHOOK_SECRET,
        )
    return None


def online_provider() -> Any:
    """Razorpay when its keys are set, else the simulated provider outside production, else None."""
    if _override is not _UNSET:
        return _override
    return razorpay_from_settings() or (MockProvider() if settings.PAYMENTS_MOCK_ENABLED else None)


def provider_named(name: str) -> Any:
    """The provider that took a payment, for refunds (None when it is not configured any more)."""
    if name == Provider.MOCK:
        return MockProvider()
    online = online_provider()
    return online if online is not None and online.name == name else None


@contextmanager
def use_online_provider(provider: Any) -> Iterator[None]:
    """Tests: swap the online provider (None = cash only)."""
    global _override
    previous = _override
    _override = provider
    try:
        yield
    finally:
        _override = previous
