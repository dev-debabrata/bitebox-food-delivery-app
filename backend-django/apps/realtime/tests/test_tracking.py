"""
Port of the Node API's tests/realtime.test.js and the socket part of tests/tracking.test.js.

- Who hears what: events go through the real channel layer (in-memory in tests); a test channel
  joins the groups a socket would join and reads what arrives after the commit.
- Tracking rules (`track:join`, rider state, persistence) are tested against the database
  directly. The consumer's wiring is tested with those database calls swapped out, because
  Channels' database wrapper closes the connection that holds the test's transaction.
"""

import itertools
from collections.abc import AsyncIterator, Callable
from types import SimpleNamespace
from typing import Any

import pytest
from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.db import connections
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.accounts.tests.test_auth import register
from apps.delivery.models import DeliveryPartner
from apps.orders.tests.test_orders import NEAR, World
from apps.realtime import consumers, tracking
from apps.realtime.events import ADMINS, order_group, restaurant_group, user_group
from apps.realtime.tracking import LIMITS, RiderLimiter, initial_groups, join, parse_fix
from apps.restaurants.models import Restaurant
from config.asgi import application

pytestmark = pytest.mark.django_db


@pytest.fixture
def w() -> World:
    return World()


def user(world_user: dict[str, Any]) -> User:
    return User.objects.get(pk=world_user["user"]["id"])


class Feed:
    """A test channel subscribed to the groups a signed-in socket would join."""

    def __init__(self, groups: list[str]) -> None:
        self.layer = get_channel_layer()
        self.channel = async_to_sync(self.layer.new_channel)()
        for group in groups:
            async_to_sync(self.layer.group_add)(group, self.channel)

    def events(self, kind: str = "order:updated") -> list[dict[str, Any]]:
        out = []
        while True:
            try:
                message = async_to_sync(self._receive)()
            except TimeoutError:
                return [m["data"] for m in out if m.get("event") == kind]
            out.append(message)

    async def _receive(self) -> dict[str, Any]:
        import asyncio

        return await asyncio.wait_for(self.layer.receive(self.channel), 0.05)


def feed_for(u: User) -> Feed:
    return Feed(initial_groups(u))


def assigned_order(w: World) -> str:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    assert w.accept(w.r, order_id).status_code == 200
    return order_id


# --- who hears what (realtime.test.js) ----------------------------------------------------------


def test_rooms_come_from_the_server_side_identity(w: World) -> None:
    owner = user(w.owner)
    restaurant = Restaurant.objects.get(owner=owner)
    assert initial_groups(owner) == [user_group(owner.pk), restaurant_group(restaurant.pk)]
    customer = user(w.customer)
    assert initial_groups(customer) == [user_group(customer.pk)]
    admin = User.objects.get(email="support@bitebox.test")  # support admins have orders:view
    assert ADMINS in initial_groups(admin)
    finance = User.objects.get(email="finance@bitebox.test")
    assert ADMINS not in initial_groups(finance)


def test_delivers_order_events_only_to_the_people_involved(
    w: World, django_capture_on_commit_callbacks: Callable[..., Any]
) -> None:
    restaurant_feed = feed_for(user(w.owner))
    customer_feed = feed_for(user(w.customer))
    res, _ = register(APIClient())
    stranger_feed = feed_for(User.objects.get(pk=res.json()["data"]["user"]["id"]))
    res, _ = register(APIClient(), role="restaurant")
    other_owner_feed = feed_for(User.objects.get(pk=res.json()["data"]["user"]["id"]))

    with django_capture_on_commit_callbacks(execute=True):
        order_id = w.place_order()
    assert [(e["id"], e["status"]) for e in restaurant_feed.events()] == [(order_id, "pending")]

    with django_capture_on_commit_callbacks(execute=True):
        w.restaurant_set(order_id, "confirmed")
    events = customer_feed.events()
    assert events[-1]["status"] == "confirmed"  # the customer sees it live
    assert sorted(events[0]) == ["id", "orderNumber", "status", "updatedAt"]  # no details
    assert stranger_feed.events() == []
    assert other_owner_feed.events() == []


def test_riders_hear_about_their_offers_and_notifications_arrive_live(
    w: World, django_capture_on_commit_callbacks: Callable[..., Any]
) -> None:
    rider_feed = feed_for(user(w.rider))
    w.go_online(w.r, NEAR)
    order_id = w.place_order()
    for status in ("confirmed", "preparing"):
        w.restaurant_set(order_id, status)
    with django_capture_on_commit_callbacks(execute=True):
        w.restaurant_set(order_id, "ready_for_pickup")
    assert order_id in [e["id"] for e in rider_feed.events()]

    customer_feed = feed_for(user(w.customer))
    with django_capture_on_commit_callbacks(execute=True):
        w.accept(w.r, order_id)
    notes = customer_feed.events("notification:new")
    assert [n["title"] for n in notes] == ["A rider is on the way to the restaurant"]
    assert notes[0]["order"] == order_id
    assert notes[0]["readAt"] is None


# --- tracking rules (tracking.test.js) ----------------------------------------------------------


def test_only_people_involved_may_watch_starting_from_the_last_known_position(w: World) -> None:
    order_id = assigned_order(w)
    ack, group = join(user(w.customer), order_id)
    assert ack["ok"] is True
    assert ack["tracking"] is True
    assert ack["location"]["latitude"] == NEAR["latitude"]  # from going online
    assert ack["location"]["at"]  # so the app can tell a stale position
    assert group == order_group(order_id)

    res, _ = register(APIClient())
    stranger = User.objects.get(pk=res.json()["data"]["user"]["id"])
    assert join(stranger, order_id) == ({"ok": False, "error": "NOT_FOUND"}, None)
    assert join(stranger, "not-an-id") == ({"ok": False, "error": "INVALID_ORDER"}, None)
    assert join(user(w.owner), order_id)[0]["ok"] is True  # the restaurant's own order
    assert join(user(w.rider), order_id)[0]["ok"] is True
    other_rider = w.new_rider()
    other = User.objects.get(pk=other_rider.get("/api/v1/auth/me").json()["data"]["user"]["id"])
    assert join(other, order_id)[0] == {"ok": False, "error": "NOT_FOUND"}


def test_finished_orders_are_not_tracked(w: World) -> None:
    order_id = assigned_order(w)
    for status in ("picked_up", "on_the_way", "delivered"):
        w.rider_set(w.r, order_id, status)
    assert join(user(w.customer), order_id) == (
        {"ok": True, "location": None, "tracking": False},
        None,
    )
    assert tracking.rider_state(user(w.rider)) == {"online": True, "tracked_order_id": None}


def test_rider_state_and_persisted_positions(w: World) -> None:
    order_id = assigned_order(w)
    rider = user(w.rider)
    assert tracking.rider_state(rider) == {"online": True, "tracked_order_id": order_id}
    from django.utils import timezone

    tracking.persist_location(rider, 12.9735, 77.642, 12.0, timezone.now())
    saved = DeliveryPartner.objects.get(user=rider)
    assert (saved.location.lat, saved.location.lng, saved.location_accuracy_m) == (
        12.9735,
        77.642,
        12.0,
    )


def test_rider_fixes_are_validated() -> None:
    assert parse_fix({"latitude": 200, "longitude": 0}) is None
    assert parse_fix({"latitude": "x", "longitude": 1}) is None
    assert parse_fix({"latitude": 1, "longitude": 1, "accuracy": -1}) is None
    assert parse_fix("nope") is None
    assert parse_fix({"latitude": "12.5", "longitude": 77}) == (12.5, 77.0, None)

    limiter = RiderLimiter(refilled_at=0.0)
    assert limiter.check(**NEAR, accuracy=5000, now=0) == "IMPRECISE"
    assert limiter.check(**NEAR, accuracy=None, now=0) is None
    # 50 km away a second later: not a real journey.
    assert limiter.check(13.42, 77.64, None, now=1) == "IMPLAUSIBLE"
    assert limiter.check(12.9735, 77.642, None, now=2) is None

    burst = RiderLimiter(refilled_at=0.0)
    taken = [burst.take(0.0) for _ in range(LIMITS["burst"] + 1)]
    assert taken == [True] * LIMITS["burst"] + [False]
    assert burst.take(1.0)  # refills one per second


# --- the consumer's wiring ----------------------------------------------------------------------

_ids = itertools.count(1)


@pytest.fixture
async def _close_worker_connections(db: None) -> AsyncIterator[None]:
    yield
    await database_sync_to_async(connections.close_all)()


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch, _close_worker_connections: None) -> dict[str, Any]:
    """The consumer's database calls, swapped for in-memory answers."""
    state: dict[str, Any] = {
        "users": {
            "customer-token": SimpleNamespace(pk="c1", role="customer"),
            "rider-token": SimpleNamespace(pk="r1", role="delivery"),
            "stranger-token": SimpleNamespace(pk="s1", role="customer"),
        },
        "rider": {"online": True, "tracked_order_id": "o1"},
        "persisted": [],
    }

    async def session(token: Any) -> Any:
        found = state["users"].get(token)
        return (found, 0) if found else None

    async def groups(u: Any) -> list[str]:
        return [user_group(u.pk)]

    async def join_order(u: Any, order_id: Any) -> Any:
        if u.pk == "c1" and order_id == "o1":
            return {"ok": True, "location": None, "tracking": True}, order_group("o1")
        return {"ok": False, "error": "NOT_FOUND"}, None

    async def rider_state(u: Any) -> dict[str, Any]:
        return dict(state["rider"])

    async def persist(*args: Any) -> None:
        state["persisted"].append(args[1:3])

    monkeypatch.setattr(consumers, "session_from_token", session)
    monkeypatch.setattr(consumers, "initial_groups", groups)
    monkeypatch.setattr(consumers, "join_order", join_order)
    monkeypatch.setattr(consumers, "rider_state", rider_state)
    monkeypatch.setattr(consumers, "persist_location", persist)
    return state


async def signed_in(token: str) -> WebsocketCommunicator:
    ws = WebsocketCommunicator(application, "/ws/", headers=[(b"origin", b"http://localhost")])
    connected, _ = await ws.connect()
    assert connected
    await ws.send_json_to({"type": "auth", "token": token})
    assert (await ws.receive_json_from())["type"] == "ready"
    return ws


async def ask(ws: WebsocketCommunicator, kind: str, data: Any) -> Any:
    request_id = next(_ids)
    await ws.send_json_to({"type": kind, "id": request_id, "data": data})
    while True:
        frame = await ws.receive_json_from(timeout=2)
        if frame["type"] == "ack" and frame["id"] == request_id:
            return frame["data"]


async def test_socket_streams_positions_to_the_orders_viewers_only(fake_db: dict[str, Any]) -> None:
    viewer = await signed_in("customer-token")
    assert (await ask(viewer, "track:join", {"orderId": "o1"}))["tracking"] is True
    bystander = await signed_in("stranger-token")
    assert await ask(bystander, "track:join", {"orderId": "o1"}) == {
        "ok": False,
        "error": "NOT_FOUND",
    }
    rider = await signed_in("rider-token")

    moved = {"latitude": 12.9735, "longitude": 77.642, "accuracy": 12}
    assert await ask(rider, "rider:location", moved) == {"ok": True}
    frame = await viewer.receive_json_from(timeout=2)
    assert frame["type"] == "order:location"
    assert frame["data"]["orderId"] == "o1"
    assert frame["data"]["latitude"] == moved["latitude"]
    assert await bystander.receive_nothing(timeout=0.1)
    assert fake_db["persisted"] == [(12.9735, 77.642)]

    # Persisted at most every few seconds; still broadcast every time.
    assert await ask(rider, "rider:location", moved) == {"ok": True}
    assert len(fake_db["persisted"]) == 1
    assert (await viewer.receive_json_from(timeout=2))["type"] == "order:location"

    # A finished order: the viewer's socket leaves the room.
    layer = get_channel_layer()
    await layer.group_send(order_group("o1"), {"type": "order.closed", "group": order_group("o1")})
    await layer.group_send(
        user_group("c1"),
        {"type": "relay", "event": "order:updated", "data": {"id": "o1", "status": "delivered"}},
    )
    assert (await viewer.receive_json_from(timeout=2))["data"]["status"] == "delivered"
    assert await ask(rider, "rider:location", moved) == {"ok": True}
    assert await viewer.receive_nothing(timeout=0.1)
    for ws in (viewer, bystander, rider):
        await ws.disconnect()


async def test_socket_rejects_bad_updates_offline_riders_and_non_riders(
    fake_db: dict[str, Any],
) -> None:
    rider = await signed_in("rider-token")
    assert (await ask(rider, "rider:location", {"latitude": 200, "longitude": 0}))["error"] == (
        "INVALID_LOCATION"
    )
    assert (await ask(rider, "rider:location", {**NEAR, "accuracy": 5000}))["error"] == "IMPRECISE"
    results = [(await ask(rider, "rider:location", NEAR)).get("error") for _ in range(6)]
    assert "RATE_LIMITED" in results  # bursts beyond the bucket are refused
    await rider.disconnect()

    fake_db["rider"] = {"online": False, "tracked_order_id": None}
    offline = await signed_in("rider-token")
    assert (await ask(offline, "rider:location", NEAR))["error"] == "OFFLINE"
    await offline.disconnect()

    customer = await signed_in("customer-token")
    await customer.send_json_to({"type": "rider:location", "id": 1, "data": NEAR})
    assert (await customer.receive_json_from())["code"] == "UNKNOWN_TYPE"  # not for customers
    await customer.disconnect()


async def test_socket_closes_when_its_token_expires(
    fake_db: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    async def expiring(token: Any) -> Any:
        return SimpleNamespace(pk="c1", role="customer"), time.time() + 0.1

    monkeypatch.setattr(consumers, "session_from_token", expiring)
    ws = await signed_in("customer-token")
    assert (await ws.receive_output(timeout=2))["code"] == consumers.CLOSE_UNAUTHORIZED
