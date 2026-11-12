"""Port of the Node API's tests/geo.test.js, plus routing. The real providers are never called."""

from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login
from apps.geo import upstream

pytestmark = pytest.mark.django_db


class FakeHttp:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.reply: Callable[[str], Any] = lambda url: []

    def __call__(
        self,
        url: str,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 8,
    ) -> Any:
        self.calls.append({"url": url, "params": params or {}, "headers": headers or {}})
        return self.reply(url)


@pytest.fixture
def http(monkeypatch: pytest.MonkeyPatch) -> FakeHttp:
    cache.clear()
    fake = FakeHttp()
    monkeypatch.setattr(upstream, "fetch_json", fake)
    return fake


def test_search_returns_short_labels_and_identifies_itself(http: FakeHttp) -> None:
    http.reply = lambda url: [
        {
            "lat": "11.5",
            "lon": "21.5",
            "display_name": "Sample Area, Sample City, Test State",
            "address": {
                "suburb": "Sample Area",
                "city": "Sample City",
                "state": "Test State",
                "postcode": "100002",
            },
        }
    ]
    res = APIClient().get("/api/v1/geo/search?q=topsia")
    assert res.status_code == 200
    assert res.json()["data"]["places"][0] == {
        "label": "Sample Area, Sample City",
        "displayName": "Sample Area, Sample City, Test State",
        "latitude": 11.5,
        "longitude": 21.5,
        "area": "Sample Area",
        "city": "Sample City",
        "state": "Test State",
        "postalCode": "100002",
    }
    assert "BiteBox" in http.calls[0]["headers"]["User-Agent"]
    assert http.calls[0]["params"]["countrycodes"] == "in"


def test_repeated_lookups_are_cached(http: FakeHttp) -> None:
    http.reply = lambda url: {
        "lat": "10.5",
        "lon": "20.5",
        "display_name": "Test Area",
        "address": {"suburb": "Test Area", "city": "Test City"},
    }
    APIClient().get("/api/v1/geo/reverse?lat=10.500000&lng=20.500000")
    second = APIClient().get("/api/v1/geo/reverse?lat=10.5&lng=20.5")
    assert len(http.calls) == 1
    assert second.json()["data"]["place"]["label"] == "Test Area, Test City"


def test_validates_input_and_reports_outages_as_503(http: FakeHttp) -> None:
    assert APIClient().get("/api/v1/geo/search?q=ab").status_code == 422
    assert APIClient().get("/api/v1/geo/reverse?lat=200&lng=1").status_code == 422

    def down(url: str) -> Any:
        raise OSError("HTTP 500")

    http.reply = down
    res = APIClient().get("/api/v1/geo/search?q=kolkata")
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "GEOCODER_UNAVAILABLE"
    hosts = [urlparse(c["url"]).hostname for c in http.calls]
    assert hosts == ["nominatim.openstreetmap.org", "photon.komoot.io"], (
        "falls back before giving up"
    )


def test_routes_need_sign_in_and_are_labelled_estimates(http: FakeHttp) -> None:
    query = "fromLat=12.9719&fromLng=77.6412&toLat=12.9352&toLng=77.6271"
    assert APIClient().get(f"/api/v1/geo/route?{query}").status_code == 401

    http.reply = lambda url: {
        "code": "Ok",
        "routes": [
            {
                "distance": 5321.4,
                "duration": 905.6,
                "geometry": {"coordinates": [[77.6412, 12.9719], [77.6271, 12.9352]]},
            }
        ],
    }
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {create_and_login('customer')['token']}")
    route = client.get(f"/api/v1/geo/route?{query}").json()["data"]["route"]
    assert (
        route["distanceMeters"],
        route["durationSeconds"],
        route["estimate"],
        route["provider"],
    ) == (5321, 906, True, "osrm")
    assert 4_200 < route["straightLineMeters"] < 4_500
    assert route["path"][0] == {"latitude": 12.9719, "longitude": 77.6412}
    assert "/route/v1/driving/77.6412,12.9719;77.6271,12.9352" in http.calls[0]["url"]

    far = client.get("/api/v1/geo/route?fromLat=12.97&fromLng=77.64&toLat=19.07&toLng=72.87")
    assert far.status_code == 400

    cache.clear()
    http.reply = lambda url: {"code": "NoRoute", "routes": []}
    down = client.get(f"/api/v1/geo/route?{query}")
    assert down.status_code == 503
    assert down.json()["error"]["code"] == "ROUTING_UNAVAILABLE"
