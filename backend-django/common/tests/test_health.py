from typing import Any

import pytest
from rest_framework.test import APIClient

from common import health


class FakeRedis:
    def __init__(self, up: bool) -> None:
        self.up = up

    def ping(self) -> bool:
        if not self.up:
            raise ConnectionError("down")
        return True


@pytest.fixture
def deps(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    state: dict[str, Any] = {"redis": True, "workers": [{"celery@w1": {"ok": "pong"}}]}
    monkeypatch.setattr(health, "redis_client", lambda: FakeRedis(state["redis"]))
    monkeypatch.setattr(health.celery_app.control, "ping", lambda timeout: state["workers"])
    return state


@pytest.mark.django_db
def test_healthy(api: APIClient, deps: dict[str, Any]) -> None:
    response = api.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["message"] == "BiteBox API is healthy"
    data = body["data"]
    assert data["status"] == "ok"
    assert data["database"] == "connected"
    assert data["redis"] == "connected"
    assert data["workers"] == 1
    assert isinstance(data["uptimeSeconds"], int)
    assert data["timestamp"].endswith("Z")
    assert response["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_no_workers_is_degraded_but_serving(api: APIClient, deps: dict[str, Any]) -> None:
    deps["workers"] = []
    response = api.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "degraded"
    assert response.json()["message"] == "BiteBox API is degraded"


@pytest.mark.django_db
def test_redis_down_is_503_without_waiting_for_workers(
    api: APIClient, deps: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    deps["redis"] = False

    def must_not_ping(timeout: float) -> None:
        raise AssertionError("pinged workers although the broker (Redis) is down")

    monkeypatch.setattr(health.celery_app.control, "ping", must_not_ping)
    response = api.get("/api/v1/health")
    assert response.status_code == 503
    assert response.json()["success"] is False
    assert response.json()["data"]["redis"] == "unreachable"


def test_database_down_is_503(
    api: APIClient, deps: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(health, "check_database", lambda: "unreachable")
    response = api.get("/api/v1/health")
    assert response.status_code == 503
    assert response.json()["data"]["database"] == "unreachable"


def test_broker_error_counts_as_no_workers(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(timeout: float) -> None:
        raise OSError("broker down")

    monkeypatch.setattr(health.celery_app.control, "ping", broken)
    assert health.check_workers() == 0


def test_live_needs_nothing(api: APIClient) -> None:
    response = api.get("/api/v1/health/live")
    assert response.status_code == 200
    assert response.json()["data"] == {"status": "alive"}


@pytest.mark.django_db
def test_ready(api: APIClient, deps: dict[str, Any]) -> None:
    assert api.get("/api/v1/health/ready").status_code == 200
    deps["redis"] = False
    response = api.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json()["data"] == {"status": "not_ready"}
