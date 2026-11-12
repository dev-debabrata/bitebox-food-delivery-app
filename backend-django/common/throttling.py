"""
Per-IP rate limits with any window (DRF's built-in rates only go per second/minute/hour/day;
the Node API limits per 15 minutes). A view sets
`throttle_classes = [rate_limit("AUTH_RATE_LIMIT", message)]`.
Counters live in the default cache (Redis in production, so every instance shares them).
"""

from typing import Any

from django.conf import settings
from rest_framework.request import Request
from rest_framework.throttling import SimpleRateThrottle

from .api import ApiError


class WindowRateThrottle(SimpleRateThrottle):
    setting: str = ""
    message: str = "Too many requests, please try again later."

    def get_rate(self) -> str:
        return str(getattr(settings, self.setting))

    def parse_rate(self, rate: str | None) -> tuple[int | None, int | None]:
        """'20/900s' → (20, 900)."""
        if not rate:
            return None, None
        count, window = rate.split("/")
        return int(count), int(window.rstrip("s"))

    def get_cache_key(self, request: Request, view: Any) -> str:
        return f"throttle:{self.setting}:{self.get_ident(request)}"

    def allow_request(self, request: Request, view: Any) -> bool:
        # Re-read the setting on each request so tests can override it.
        self.num_requests, self.duration = self.parse_rate(self.get_rate())
        if super().allow_request(request, view):
            return True
        wait = self.wait()
        error = ApiError(429, self.message, code="RATE_LIMITED")
        error.retry_after = int(wait) if wait else None  # type: ignore[attr-defined]
        raise error


def rate_limit(setting: str, message: str) -> type[WindowRateThrottle]:
    return type(
        f"RateLimit_{setting}", (WindowRateThrottle,), {"setting": setting, "message": message}
    )
