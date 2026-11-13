"""
Calls to free public services (Nominatim, OSRM), shared by every API process (Node:
utils/upstream.js, which did this in one process's memory):

- results are cached (Redis in production) so repeated lookups never reach the provider;
- identical requests already in flight are merged: one process fetches, the others wait for the
  cached result;
- requests to each provider are spaced (about 1 per second), as the usage policies require.
"""

import hashlib
import json
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from django.conf import settings
from django.core.cache import cache

LOCK_SECONDS = 15


def fetch_json(
    url: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 8,
) -> Any:
    """GET a JSON document. Replaced in tests: the real providers are never called there."""
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, "")})
    target = f"{url}?{query}" if query else url
    if not target.startswith(("https://", "http://")):
        raise ValueError("Only http(s) URLs")
    request = urllib.request.Request(target, headers=headers or {})  # noqa: S310 (scheme checked above)
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        if response.status >= 400:
            raise OSError(f"HTTP {response.status}")
        return json.loads(response.read())


def _wait_for_slot(provider: str) -> None:
    """At most one request per `UPSTREAM_MIN_GAP_SECONDS` to a provider, across all processes."""
    gap = float(settings.UPSTREAM_MIN_GAP_SECONDS)
    if gap <= 0:
        return
    deadline = time.monotonic() + 10
    while not cache.add(f"upstream:slot:{provider}", 1, timeout=gap):
        if time.monotonic() > deadline:
            raise TimeoutError(f"{provider} is busy")
        time.sleep(0.1)


def cached(provider: str, key: str, ttl_seconds: int, load: Callable[[], Any]) -> Any:
    # The key holds user input (search text): hashed, so it is always a valid, short cache key.
    cache_key = f"upstream:{provider}:{hashlib.sha256(key.encode()).hexdigest()}"
    hit = cache.get(cache_key)
    if hit is not None:
        return hit
    lock = f"{cache_key}:lock"
    if not cache.add(lock, 1, timeout=LOCK_SECONDS):
        # Someone else is fetching the same thing: wait for their result.
        deadline = time.monotonic() + LOCK_SECONDS
        while time.monotonic() < deadline:
            time.sleep(0.1)
            hit = cache.get(cache_key)
            if hit is not None:
                return hit
            if cache.get(lock) is None:
                break  # they failed; try ourselves
    try:
        _wait_for_slot(provider)
        value = load()
        cache.set(cache_key, value, timeout=ttl_seconds)
        return value
    finally:
        cache.delete(lock)
