"""
The app's single WebSocket, `/ws/` (replaces Socket.IO; docs/django-migration/02 §2.6).

Frames are JSON objects with a `type`:
- client → `{"type": "auth", "token": "<access token>"}` within AUTH_TIMEOUT_SECONDS, otherwise
  the server closes with 4401. A bad token also closes with 4401 (the client refreshes and
  reconnects). The token is never put in the URL, so it never lands in access logs. The socket
  also closes with 4401 when that token expires.
- client → `{"type": "ping"}`, server → `{"type": "pong", "at": ...}`: the heartbeat, allowed
  before auth.
- server → `{"type": "ready"}` once authenticated.
- Requests that want an answer carry an `id`; the answer is `{"type": "ack", "id", "data"}`
  (Socket.IO's acknowledgement callback):
  - `{"type": "track:join", "id", "data": {"orderId"}}` → `{ok, location, tracking}` or
    `{ok: false, error}`. Joins the order's room after a database permission check.
  - `{"type": "track:leave", "id", "data": {"orderId"}}` → `{ok: true}`.
  - `{"type": "rider:location", "id", "data": {latitude, longitude, accuracy?}}` (riders) →
    `{ok}` or `{ok: false, error: RATE_LIMITED | INVALID_LOCATION | IMPRECISE | IMPLAUSIBLE |
    OFFLINE}`. Broadcast to the active order's room as `order:location`.
- server events: `{"type": "order:updated" | "order:location" | "notification:new", "data"}`.
"""

import asyncio
import contextlib
import logging
import time
from datetime import UTC, datetime
from typing import Any

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.rbac.roles import Role

from . import tracking
from .auth import session_from_token
from .events import order_group

logger = logging.getLogger("bitebox.realtime")

AUTH_TIMEOUT_SECONDS = 5.0
CLOSE_UNAUTHORIZED = 4401

# Database work, swappable in tests (Channels' DB wrapper closes the test's connection).
initial_groups = database_sync_to_async(tracking.initial_groups)
join_order = database_sync_to_async(tracking.join)
rider_state = database_sync_to_async(tracking.rider_state)
persist_location = database_sync_to_async(tracking.persist_location)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class RealtimeConsumer(AsyncJsonWebsocketConsumer):
    user: Any = None
    groups_joined: set[str]
    limiter: tracking.RiderLimiter | None = None
    _auth_deadline: asyncio.Task[None] | None = None
    _expiry: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        self.groups_joined = set()
        await self.accept()
        self._auth_deadline = asyncio.create_task(self._close_if_unauthenticated())

    async def disconnect(self, code: int) -> None:
        for task in (self._auth_deadline, self._expiry):
            if task:
                task.cancel()
        for group in list(self.groups_joined):
            await self._leave(group)

    async def _close_if_unauthenticated(self) -> None:
        await asyncio.sleep(AUTH_TIMEOUT_SECONDS)
        if self.user is None:
            await self.close(code=CLOSE_UNAUTHORIZED)

    async def _close_at(self, expires_at: float) -> None:
        await asyncio.sleep(max(0.0, expires_at - time.time()))
        await self.close(code=CLOSE_UNAUTHORIZED)

    async def _join(self, group: str) -> None:
        if group not in self.groups_joined and self.channel_layer is not None:
            await self.channel_layer.group_add(group, self.channel_name)
            self.groups_joined.add(group)

    async def _leave(self, group: str) -> None:
        if group in self.groups_joined and self.channel_layer is not None:
            await self.channel_layer.group_discard(group, self.channel_name)
            self.groups_joined.discard(group)

    async def _ack(self, content: dict[str, Any], data: dict[str, Any]) -> None:
        if content.get("id") is not None:
            await self.send_json({"type": "ack", "id": content["id"], "data": data})

    # -- client frames ---------------------------------------------------------------------
    async def receive_json(self, content: Any, **kwargs: Any) -> None:
        kind = content.get("type") if isinstance(content, dict) else None
        if kind == "ping":
            await self.send_json({"type": "pong", "at": _now()})
            return
        if kind == "auth":
            await self._authenticate(content.get("token"))
            return
        if self.user is None:
            await self.close(code=CLOSE_UNAUTHORIZED)
            return
        body = content.get("data")
        try:
            if kind == "track:join":
                await self._track_join(content, body)
            elif kind == "track:leave":
                order_id = body.get("orderId") if isinstance(body, dict) else None
                if order_id:
                    await self._leave(order_group(order_id))
                await self._ack(content, {"ok": True})
            elif kind == "rider:location" and self.user.role == Role.DELIVERY:
                await self._rider_location(content, body)
            else:
                await self.send_json({"type": "error", "code": "UNKNOWN_TYPE", "at": _now()})
        except Exception:
            logger.exception("Socket request failed", extra={"type": kind})
            await self._ack(content, {"ok": False, "error": "SERVER_ERROR"})

    async def _authenticate(self, token: Any) -> None:
        session = await session_from_token(token)
        if session is None:
            await self.close(code=CLOSE_UNAUTHORIZED)
            return
        if self.user is not None:  # a second auth frame: ignore (rooms are fixed per socket)
            await self.send_json({"type": "ready", "at": _now()})
            return
        self.user, expires_at = session
        if self._auth_deadline:
            self._auth_deadline.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._auth_deadline
        for group in await initial_groups(self.user):
            await self._join(group)
        if expires_at:
            self._expiry = asyncio.create_task(self._close_at(expires_at))
        if self.user.role == Role.DELIVERY:
            self.limiter = tracking.RiderLimiter()
        await self.send_json({"type": "ready", "at": _now()})

    async def _track_join(self, content: dict[str, Any], body: Any) -> None:
        order_id = body.get("orderId") if isinstance(body, dict) else None
        ack, group = await join_order(self.user, order_id)
        if group:
            await self._join(group)
        await self._ack(content, ack)

    async def _rider_location(self, content: dict[str, Any], body: Any) -> None:
        limiter = self.limiter or tracking.RiderLimiter()
        self.limiter = limiter
        now = time.monotonic()
        if not limiter.take(now):
            await self._ack(content, {"ok": False, "error": "RATE_LIMITED"})
            return
        fix = tracking.parse_fix(body)
        if fix is None:
            await self._ack(content, {"ok": False, "error": "INVALID_LOCATION"})
            return
        latitude, longitude, accuracy = fix
        problem = limiter.check(latitude, longitude, accuracy, now)
        if problem:
            await self._ack(content, {"ok": False, "error": problem})
            return
        if limiter.should_recheck(now):
            limiter.state = await rider_state(self.user)
            limiter.checked_at = now
        state = limiter.state or {}
        if not state.get("online"):
            await self._ack(content, {"ok": False, "error": "OFFLINE"})
            return
        at = datetime.now(UTC)
        tracked = state.get("tracked_order_id")
        if limiter.should_persist(now):
            await persist_location(self.user, latitude, longitude, accuracy, at, tracked)
        if tracked and self.channel_layer is not None:
            await self.channel_layer.group_send(
                order_group(tracked),
                {
                    "type": "relay",
                    "event": "order:location",
                    "data": {
                        "orderId": tracked,
                        "latitude": latitude,
                        "longitude": longitude,
                        "accuracy": accuracy,
                        "at": at.isoformat().replace("+00:00", "Z"),
                    },
                },
            )
        await self._ack(content, {"ok": True})

    # -- channel layer messages ------------------------------------------------------------
    async def relay(self, message: dict[str, Any]) -> None:
        """A server event for this socket's rooms (apps.realtime.events)."""
        await self.send_json({"type": message["event"], "data": message["data"]})

    async def order_closed(self, message: dict[str, Any]) -> None:
        """A finished order: sockets tracking it leave its room."""
        await self._leave(message["group"])
