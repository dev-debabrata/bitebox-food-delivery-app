from typing import Any

import pytest
from rest_framework.test import APIClient

from apps.geo import upstream


@pytest.fixture
def api() -> APIClient:
    return APIClient()


@pytest.fixture(autouse=True)
def _no_real_geo_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never call Nominatim or OSRM: the upstream is "down" unless a test fakes it."""

    def offline(url: str, *args: Any, **kwargs: Any) -> Any:
        raise OSError(f"no network in tests: {url}")

    monkeypatch.setattr(upstream, "fetch_json", offline)
