"""
Health endpoints.

- GET /api/v1/health: database, Redis and Celery workers. Same envelope and fields as the Node API
  (`status`, `database`, `uptimeSeconds`, `timestamp`) plus `redis` and `workers`. HTTP 503 when
  the database or Redis is down (the API can't serve requests); `status` is "degraded" when no
  Celery worker answers (requests still work, background jobs wait).
- GET /api/v1/health/live: the process is up (no dependencies; for restart decisions).
- GET /api/v1/health/ready: database and Redis reachable (for load-balancer routing).
"""

import time
from datetime import UTC, datetime
from typing import Any

import redis
from django.conf import settings
from django.db import connection
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from config.celery import app as celery_app

from .api import ok

STARTED_AT = time.monotonic()
# One named enum in the OpenAPI schema (SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]).
CONNECTION_STATES = ["connected", "unreachable"]
HEALTH_STATES = ["ok", "degraded"]
CHECK_TIMEOUT_SECONDS = 1.0


def check_database() -> str:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        return "unreachable"
    return "connected"


def redis_client() -> redis.Redis:
    """Replaced in tests."""
    return redis.Redis.from_url(
        settings.REDIS_URL,
        socket_connect_timeout=CHECK_TIMEOUT_SECONDS,
        socket_timeout=CHECK_TIMEOUT_SECONDS,
    )


def check_redis() -> str:
    try:
        redis_client().ping()
    except Exception:
        return "unreachable"
    return "connected"


def check_workers() -> int:
    """Number of Celery workers that answered a ping (0 if none or the broker is down)."""
    try:
        replies = celery_app.control.ping(timeout=CHECK_TIMEOUT_SECONDS) or []
    except Exception:
        return 0
    return len(replies)


def _envelope(name: str, data_fields: dict[str, Any]) -> Any:
    return inline_serializer(
        name=name,
        fields={
            "success": serializers.BooleanField(),
            "message": serializers.CharField(),
            "data": inline_serializer(name=f"{name}Data", fields=data_fields),
        },
    )


HEALTH_FIELDS = {
    "status": serializers.ChoiceField(choices=HEALTH_STATES),
    "database": serializers.ChoiceField(choices=CONNECTION_STATES),
    "redis": serializers.ChoiceField(choices=CONNECTION_STATES),
    "workers": serializers.IntegerField(help_text="Celery workers that answered a ping"),
    "uptime_seconds": serializers.IntegerField(),
    "timestamp": serializers.DateTimeField(),
}


class HealthView(APIView):
    @extend_schema(
        tags=["Health"],
        summary="API, database, Redis and worker health",
        responses={
            200: _envelope("Health", HEALTH_FIELDS),
            503: _envelope("HealthDown", HEALTH_FIELDS),
        },
    )
    def get(self, request: Request) -> Response:
        database = check_database()
        redis_state = check_redis()
        # Redis is the Celery broker: if it's down no worker can answer, and pinging would only
        # wait for the broker's connection retries.
        workers = check_workers() if redis_state == "connected" else 0
        serving = database == "connected" and redis_state == "connected"
        healthy = serving and workers > 0
        response = ok(
            {
                "status": "ok" if healthy else "degraded",
                "database": database,
                "redis": redis_state,
                "workers": workers,
                "uptime_seconds": round(time.monotonic() - STARTED_AT),
                "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
            message="BiteBox API is healthy" if healthy else "BiteBox API is degraded",
            status=200 if serving else 503,
        )
        if not serving:
            response.data["success"] = False
        response["Cache-Control"] = "no-store"
        return response


class LiveView(APIView):
    @extend_schema(
        tags=["Health"],
        summary="Process is running",
        responses={200: _envelope("Live", {"status": serializers.CharField()})},
    )
    def get(self, request: Request) -> Response:
        return ok({"status": "alive"})


class ReadyView(APIView):
    @extend_schema(
        tags=["Health"],
        summary="Ready to serve (database and Redis reachable)",
        responses={
            200: _envelope("Ready", {"status": serializers.CharField()}),
            503: _envelope("NotReady", {"status": serializers.CharField()}),
        },
    )
    def get(self, request: Request) -> Response:
        ready = check_database() == "connected" and check_redis() == "connected"
        response = ok({"status": "ready" if ready else "not_ready"}, status=200 if ready else 503)
        if not ready:
            response.data["success"] = False
        response["Cache-Control"] = "no-store"
        return response
