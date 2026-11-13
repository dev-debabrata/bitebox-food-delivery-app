"""Sign-in with an SMS code, phone and email verification, and the profile photo."""

import io
import re
import uuid
from datetime import timedelta
from typing import Any

import pytest
from django.conf import settings
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import OtpChallenge, User
from apps.accounts.tasks import purge
from apps.accounts.tests.test_auth import register, token_of
from apps.notifications.senders import sms_outbox
from apps.restaurants.tests.test_catalog import PNG
from apps.uploads.storage import use_image_storage

pytestmark = pytest.mark.django_db
PHONE = "9876543210"


@pytest.fixture(autouse=True)
def sms(settings: Any) -> list[dict[str, str]]:
    settings.SMS_PROVIDER = "test"
    sms_outbox.clear()
    return sms_outbox


def signed_up(api: APIClient, phone: str = PHONE) -> tuple[APIClient, dict[str, Any]]:
    res, _ = register(api, phone=phone)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_of(res)}")
    return client, res.json()["data"]["user"]


def request_code(phone: str = PHONE, **extra: Any) -> Any:
    return APIClient().post("/api/v1/auth/otp/request", {"phone": phone}, format="json", **extra)


def last_code() -> str:
    return re.search(r"\b(\d{6})\b", sms_outbox[-1]["text"]).group(1)  # type: ignore[union-attr]


def code_login(code: str, phone: str = PHONE, **body: Any) -> Any:
    return APIClient().post(
        "/api/v1/auth/otp/login", {"phone": phone, "code": code, **body}, format="json"
    )


def verification_token() -> str:
    message = [m for m in mail.outbox if m.subject == "Confirm your BiteBox email"][-1]
    return re.search(r"verify-email\?token=(\S+)", message.body).group(1)  # type: ignore[union-attr]


def wrong(code: str) -> str:
    return f"{(int(code) + 1) % 10**6:06d}"


# --- sign in with a code --------------------------------------------------------------------------


def test_signs_in_with_the_code_sent_to_the_number(api: APIClient) -> None:
    _, user = signed_up(api)
    assert user["phoneVerified"] is False
    res = request_code()
    assert res.status_code == 200
    assert res.json()["data"] == {"resendInSeconds": 30, "expiresInSeconds": 300}
    assert sms_outbox[-1]["to"] == PHONE
    stored = OtpChallenge.objects.get()
    assert last_code() not in stored.code_hash  # only an HMAC is kept

    login = code_login(last_code())
    assert login.status_code == 200, login.json()
    assert login.json()["data"]["user"]["id"] == user["id"]
    assert login.json()["data"]["user"]["phoneVerified"] is True
    assert login.cookies.get("bb_refresh")
    assert code_login(last_code()).status_code == 400  # a code works once


def test_the_number_matches_however_it_was_typed(api: APIClient) -> None:
    signed_up(api)  # stored as 9876543210
    request_code("+919876543210")
    assert code_login(last_code(), "+919876543210").status_code == 200


def test_unknown_numbers_get_the_same_answer_but_no_text() -> None:
    res = request_code("9123456780")
    assert res.status_code == 200
    assert res.json()["message"].startswith("If this number has a BiteBox account")
    assert sms_outbox == []
    assert code_login("123456", "9123456780").status_code in (400, 401)


def test_wrong_codes_count_down_then_lock(api: APIClient) -> None:
    signed_up(api)
    request_code()
    code = last_code()
    first = code_login(wrong(code))
    assert first.status_code == 400
    assert "4 tries left" in first.json()["message"]
    for _ in range(4):
        code_login(wrong(code))
    locked = code_login(code)  # even the right code, after five wrong ones
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "OTP_LOCKED"


def test_codes_expire(api: APIClient) -> None:
    signed_up(api)
    request_code()
    OtpChallenge.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
    assert "expired" in code_login(last_code()).json()["message"]


def test_resend_waits_and_hourly_limits(api: APIClient, settings: Any) -> None:
    signed_up(api)
    assert request_code().status_code == 200
    again = request_code()
    assert again.status_code == 429
    assert again.json()["message"].startswith("Wait")
    settings.OTP_RESEND_SECONDS = 0
    for _ in range(3):
        assert request_code().status_code == 200
    assert "this number" in request_code().json()["message"]  # 5 an hour per number
    settings.OTP_PER_IP_PER_HOUR = 5
    assert "Too many codes requested" in request_code("9000000999").json()["message"]  # per IP


def test_portal_and_suspension_rules_apply(api: APIClient) -> None:
    signed_up(api)
    request_code()
    assert code_login(last_code(), portal="admin").status_code == 403
    User.objects.filter(phone=PHONE).update(status="suspended")
    OtpChallenge.objects.all().delete()
    request_code()
    assert len(sms_outbox) == 1  # no text for a suspended account


def test_phone_sign_in_is_unavailable_without_sms(api: APIClient, settings: Any) -> None:
    methods = lambda: api.get("/api/v1/auth/methods").json()["data"]  # noqa: E731
    assert methods() == {"phone": True}
    settings.SMS_PROVIDER = ""
    assert request_code().status_code == 503
    assert methods() == {"phone": False}  # the pages hide phone codes
    settings.SMS_PROVIDER, settings.MSG91_AUTH_KEY = "msg91", ""  # no key: still off
    assert methods() == {"phone": False}


# --- verifying a number --------------------------------------------------------------------------


def test_signed_in_people_verify_their_number_and_a_new_number_needs_it_again(
    api: APIClient,
) -> None:
    client, _ = signed_up(api)
    assert client.post("/api/v1/auth/phone/verification").status_code == 200
    verified = client.post("/api/v1/auth/phone/verify", {"code": last_code()}, format="json")
    assert verified.json()["data"]["user"]["phoneVerified"] is True
    assert client.post("/api/v1/auth/phone/verification").status_code == 409
    changed = client.patch("/api/v1/auth/me", {"phone": "9876500000"}, format="json")
    assert changed.json()["data"]["user"]["phoneVerified"] is False


# --- email ---------------------------------------------------------------------------------------


def test_new_accounts_get_a_link_that_verifies_the_email_once(
    api: APIClient, django_capture_on_commit_callbacks: Any
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        client, user = signed_up(api)
    assert user["emailVerified"] is False
    token = verification_token()
    assert (
        APIClient().post("/api/v1/auth/email/verify", {"token": token}, format="json").status_code
        == 200
    )
    assert client.get("/api/v1/auth/me").json()["data"]["user"]["emailVerified"] is True
    again = APIClient().post("/api/v1/auth/email/verify", {"token": token}, format="json")
    assert again.status_code == 400
    assert client.post("/api/v1/auth/email/verification").status_code == 409


def test_a_new_link_replaces_the_old_one_and_links_expire(
    api: APIClient, django_capture_on_commit_callbacks: Any
) -> None:
    with django_capture_on_commit_callbacks(execute=True):
        client, _ = signed_up(api)
    old = verification_token()
    assert client.post("/api/v1/auth/email/verification").status_code == 200
    new = verification_token()
    verify = lambda t: APIClient().post("/api/v1/auth/email/verify", {"token": t}, format="json")  # noqa: E731
    assert verify(old).status_code == 400
    User.objects.update(email_verification_expires_at=timezone.now() - timedelta(seconds=1))
    assert verify(new).status_code == 400


# --- profile photo and housekeeping --------------------------------------------------------------


def test_profile_photo_must_be_one_of_our_uploads(api: APIClient) -> None:
    class Keep:
        def save(self, data: bytes, extension: str) -> str:
            return f"{settings.PUBLIC_BASE_URL}/uploads/images/{uuid.uuid4()}.png"

    client, _ = signed_up(api)
    with use_image_storage(Keep()):
        photo = io.BytesIO(PNG)
        photo.name = "me.png"
        url = client.post("/api/v1/uploads/avatars", {"image": photo}, format="multipart").json()[
            "data"
        ]["url"]
    me = client.patch("/api/v1/auth/me", {"avatarUrl": url}, format="json")
    assert me.json()["data"]["user"]["avatarUrl"] == url
    other = client.patch(
        "/api/v1/auth/me", {"avatarUrl": "https://evil.example/x.png"}, format="json"
    )
    assert other.status_code == 400
    removed = client.patch("/api/v1/auth/me", {"avatarUrl": None}, format="json")
    assert "avatarUrl" not in removed.json()["data"]["user"]


def test_purge_drops_expired_sessions_and_old_codes(api: APIClient) -> None:
    signed_up(api)
    request_code()
    OtpChallenge.objects.update(created_at=timezone.now() - timedelta(days=2))
    assert purge() >= 1
    assert not OtpChallenge.objects.exists()


# --- sign-up confirmed by SMS --------------------------------------------------------------------


def signup(**body: Any) -> Any:
    base = {
        "name": "Meera Test",
        "email": "meera@example.com",
        "password": "Sup3rSecret!",
        "phone": PHONE,
    }
    return APIClient().post("/api/v1/auth/register", {**base, **body}, format="json")


def test_sign_up_creates_the_account_only_with_the_texted_code(settings: Any) -> None:
    settings.SIGNUP_OTP_REQUIRED = True
    sent = APIClient().post(
        "/api/v1/auth/register/code", {"email": "meera@example.com", "phone": PHONE}, format="json"
    )
    assert sent.status_code == 200
    assert sms_outbox[-1]["to"] == PHONE
    without = signup()
    assert without.status_code == 400
    assert without.json()["error"]["details"][0]["field"] == "code"
    assert signup(code=wrong(last_code())).status_code == 400
    assert not User.objects.filter(email="meera@example.com").exists()
    created = signup(code=last_code())
    assert created.status_code == 201, created.json()
    assert created.json()["data"]["user"]["phoneVerified"] is True
    assert signup(code=last_code()).status_code == 409  # the account exists now


def test_sign_up_code_is_not_sent_for_taken_emails_or_numbers(
    api: APIClient, settings: Any
) -> None:
    signed_up(api)  # PHONE is taken
    settings.SIGNUP_OTP_REQUIRED = True
    taken = APIClient().post(
        "/api/v1/auth/register/code", {"email": "new@example.com", "phone": PHONE}, format="json"
    )
    assert taken.status_code == 409
    assert sms_outbox == []


def test_sign_up_stays_one_step_while_sms_is_off(settings: Any) -> None:
    settings.SIGNUP_OTP_REQUIRED = True
    settings.SMS_PROVIDER = ""
    assert signup().status_code == 201
