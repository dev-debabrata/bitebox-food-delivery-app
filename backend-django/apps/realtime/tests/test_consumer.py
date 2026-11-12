from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.db import connections

from apps.realtime import consumers
from config.asgi import application

ORIGIN = [(b"origin", b"http://localhost")]

# Channels may touch the database connection in its worker thread; allow it, and close that
# thread's connection afterwards so the test database can be dropped at the end of the run.
pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
async def _close_worker_connections(db: None) -> AsyncIterator[None]:
    yield
    await database_sync_to_async(connections.close_all)()


async def connect() -> WebsocketCommunicator:
    communicator = WebsocketCommunicator(application, "/ws/", headers=ORIGIN)
    connected, _ = await communicator.connect()
    assert connected
    return communicator


async def test_ping_pong_before_auth() -> None:
    ws = await connect()
    await ws.send_json_to({"type": "ping"})
    reply: dict[str, Any] = await ws.receive_json_from()
    assert reply["type"] == "pong"
    assert reply["at"].endswith("Z")
    await ws.disconnect()


async def test_bad_token_closes_4401() -> None:
    ws = await connect()
    await ws.send_json_to({"type": "auth", "token": "forged"})
    assert (await ws.receive_output())["code"] == 4401


async def test_messages_before_auth_close_4401() -> None:
    ws = await connect()
    await ws.send_json_to({"type": "track:join", "orderId": "o1"})
    assert (await ws.receive_output())["code"] == 4401


async def test_no_auth_frame_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(consumers, "AUTH_TIMEOUT_SECONDS", 0.05)
    ws = await connect()
    assert (await ws.receive_output(timeout=1))["code"] == 4401


async def test_valid_token_is_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    async def accept_all(token: Any) -> object:
        return SimpleNamespace(pk="u1", role="customer"), 0

    async def no_groups(user: Any) -> list[str]:
        return []

    monkeypatch.setattr(consumers, "session_from_token", accept_all)
    monkeypatch.setattr(consumers, "initial_groups", no_groups)
    ws = await connect()
    await ws.send_json_to({"type": "auth", "token": "t"})
    assert (await ws.receive_json_from())["type"] == "ready"
    await ws.send_json_to({"type": "mystery"})
    assert (await ws.receive_json_from())["code"] == "UNKNOWN_TYPE"
    await ws.disconnect()


async def test_foreign_origin_is_rejected() -> None:
    communicator = WebsocketCommunicator(
        application, "/ws/", headers=[(b"origin", b"https://evil.example")]
    )
    connected, _ = await communicator.connect()
    assert not connected
