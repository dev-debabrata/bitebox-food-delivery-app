import pytest
from asgiref.sync import async_to_sync

from apps.accounts.tokens import sign_access_token
from apps.realtime import auth
from tests import factories as make

pytestmark = pytest.mark.django_db


def check(token: str) -> object:
    """The token check the socket runs (without Channels' connection-closing wrapper, which would
    close the test's transaction; see django/channels docs on database_sync_to_async in tests)."""
    session = auth.session_for_token(token)
    return session[0] if session else None


def test_real_access_tokens_and_suspension() -> None:
    user = make.user()
    token = sign_access_token(user)
    assert check(token) == user
    assert check("forged") is None
    session = auth.session_for_token(token)
    assert session is not None
    assert session[1] > 0  # the token's expiry, for closing the socket

    user.status = "suspended"
    user.save()
    assert check(token) is None


@pytest.mark.parametrize("token", [None, "", 42, {"token": "x"}])
def test_non_string_tokens_are_rejected_without_a_lookup(token: object) -> None:
    assert async_to_sync(auth.user_from_token)(token) is None
