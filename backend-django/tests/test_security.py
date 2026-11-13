"""
Security checks (Phase 16, security plan §7.4): token tampering, data exposure, headers, access to
other people's data (IDOR), spreadsheet formula injection, photo metadata and log redaction.
The role × endpoint matrix is in test_access_control.py, hostile input in test_input_fuzzing.py.
"""

import io
import logging
import re
import struct
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from django.conf import settings
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.accounts.tokens import sign_access_token
from apps.customers.models import Address
from apps.finance.services import spreadsheet_safe
from apps.finance.tests.test_finance import deliver, finance
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import World, client_for
from apps.rbac.roles import Role
from apps.restaurants.models import Restaurant
from apps.uploads.metadata import strip_metadata
from apps.uploads.storage import use_image_storage
from common.log_redaction import RedactSecrets, scrub
from tests.factories import restaurant, user
from tests.test_access_control import allows, endpoints

pytestmark = pytest.mark.django_db
ME = "/api/v1/auth/me"


def bearer(token: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


def claims(u: User, **changes: Any) -> dict[str, Any]:
    now = datetime.now(UTC)
    base = {
        "sub": str(u.pk),
        "role": u.role,
        "tv": u.token_version,
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
    }
    return {**base, **changes}


# --- tokens ---------------------------------------------------------------------------------------


def test_forged_and_altered_access_tokens_are_refused() -> None:
    customer = user(Role.CUSTOMER)
    assert bearer(sign_access_token(customer)).get(ME).status_code == 200
    secret = settings.JWT_SECRET
    forged = {
        "wrong key": jwt.encode(claims(customer), "x" * 48, algorithm="HS256"),
        "alg none": jwt.encode(claims(customer), "", algorithm="none"),
        "expired": jwt.encode(
            claims(customer, exp=datetime.now(UTC) - timedelta(seconds=1)), secret, "HS256"
        ),
        "other audience": jwt.encode(claims(customer, aud="someone-else"), secret, "HS256"),
        "other issuer": jwt.encode(claims(customer, iss="someone-else"), secret, "HS256"),
        "no expiry": jwt.encode({k: v for k, v in claims(customer).items() if k != "exp"}, secret),
        "unknown user": jwt.encode(claims(customer, sub=str(uuid.uuid4())), secret, "HS256"),
        "text version": jwt.encode(claims(customer, tv="0"), secret, "HS256"),
    }
    for name, token in forged.items():
        assert bearer(token).get(ME).status_code == 401, name
    for header in (
        "Bearer",
        "Basic abc",
        f"bearer  {sign_access_token(customer)} extra",
        "Token x",
    ):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=header)
        assert client.get(ME).status_code == 401, header


def test_the_role_comes_from_the_database_not_the_token() -> None:
    customer = user(Role.CUSTOMER)
    token = jwt.encode(claims(customer, role="admin"), settings.JWT_SECRET, "HS256")
    assert bearer(token).get("/api/v1/admin/users").status_code == 403


def test_old_tokens_stop_working_after_a_password_change_or_suspension() -> None:
    customer = user(Role.CUSTOMER)
    token = sign_access_token(customer)
    User.objects.filter(pk=customer.pk).update(token_version=customer.token_version + 1)
    assert bearer(token).get(ME).status_code == 401
    other = user(Role.CUSTOMER)
    token = sign_access_token(other)
    User.objects.filter(pk=other.pk).update(status="suspended")
    assert bearer(token).get(ME).status_code in (401, 403)


# --- data exposure --------------------------------------------------------------------------------

SECRET_KEY_NAMES = re.compile(r"(?i)password|hash|tokenversion|refresh|otp|secret")


def keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in keys(v)}
    return set()


def test_responses_never_carry_password_hashes_or_token_internals(api: APIClient) -> None:
    res, _ = register(api)
    me = bearer(token_of(res)).get(ME)
    admin = client_for(create_and_login("admin")["token"])
    users = admin.get("/api/v1/admin/users")
    detail = admin.get(f"/api/v1/admin/users/{me.json()['data']['user']['id']}")
    for body in (res.json(), me.json(), users.json(), detail.json()):
        leaked = {k for k in keys(body) if SECRET_KEY_NAMES.search(k)}
        assert leaked == set()


def test_api_responses_carry_the_security_headers(api: APIClient) -> None:
    res = api.get("/api/v1/health/live")
    assert res["X-Content-Type-Options"] == "nosniff"
    assert res["X-Frame-Options"] == "DENY"
    assert res["Referrer-Policy"] == "same-origin" or res["Referrer-Policy"].startswith("strict")


# --- other people's data (IDOR) ------------------------------------------------------------------


def test_nobody_reaches_another_customers_restaurants_or_riders_data() -> None:
    """Every non-admin route that takes an id, called with someone else's id by every partner
    or customer role allowed on it, must answer 403/404 and change nothing."""
    w = World()
    order_id = deliver(w)
    address_id = w.address_id()
    food_id = str(next(iter(w.food.values())).pk)
    payee = Restaurant.objects.get(owner_id=w.owner["user"]["id"])
    payout = finance().post(
        "/api/v1/admin/finance/payouts",
        {"type": "restaurant", "payeeId": str(payee.pk)},
        format="json",
    )
    payout_id = payout.json()["data"]["payout"]["id"]
    notification = Notification.objects.filter(user_id=w.customer["user"]["id"]).first()
    assert notification is not None
    ids = {
        "addresses": address_id,
        "foods": food_id,
        "payouts": payout_id,
        "notifications": str(notification.pk),
    }

    other_restaurant = restaurant()
    attackers = {
        Role.CUSTOMER: bearer(sign_access_token(user(Role.CUSTOMER))),
        Role.RESTAURANT: bearer(sign_access_token(other_restaurant.owner)),
        Role.DELIVERY: bearer(sign_access_token(user(Role.DELIVERY))),
    }
    probed, leaks = 0, []
    for route, method, view in endpoints():
        if "<" not in route or route.startswith(
            ("api/v1/admin", "api/v1/restaurants", "api/v1/foods")
        ):
            continue
        if "/cart/" in route or "/response" in route:  # your own cart; reviews have own tests
            continue
        kind = next((k for k in ids if f"/{k}/" in route), "orders")
        url = "/" + re.sub(r"<[^>]+>", ids.get(kind, order_id), route)
        for role, client in attackers.items():
            if not allows(view, method, role):
                continue
            probed += 1
            res = getattr(client, method)(
                url, {"status": "cancelled", "reason": "x"}, format="json"
            )
            if res.status_code not in (403, 404, 409, 422) or res.status_code >= 500:
                leaks.append(f"{role} {method.upper()} {url} -> {res.status_code}")
    assert leaks == []
    assert probed >= 25
    # Nothing changed hands.
    assert Order.objects.get(pk=order_id).status == "delivered"
    assert Address.objects.filter(pk=address_id).exists()


# --- spreadsheets ---------------------------------------------------------------------------------


def test_csv_export_neutralises_formulas_in_partner_written_text() -> None:
    assert spreadsheet_safe("=HYPERLINK(1)") == "'=HYPERLINK(1)"
    assert all(spreadsheet_safe(c + "x").startswith("'") for c in "=+-@\t\r")
    assert spreadsheet_safe("Spice Route") == "Spice Route"

    w = World()
    Restaurant.objects.filter(owner_id=w.owner["user"]["id"]).update(name="=cmd|' /C calc'!A0")
    deliver(w)
    csv = finance().get("/api/v1/admin/finance/settlements.csv").content.decode()
    assert "'=cmd|" in csv
    assert ",=cmd" not in csv


# --- photo metadata -------------------------------------------------------------------------------

GPS = b"GPSLatitude 12.9716 N"


def jpeg_with_exif(orientation: int = 6) -> bytes:
    tiff = b"MM\x00\x2a" + struct.pack(">I", 8) + struct.pack(">H", 2)
    tiff += struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0)  # Orientation
    tiff += struct.pack(">HHII", 0x8825, 4, 1, 38)  # GPS IFD pointer
    tiff += struct.pack(">I", 0) + GPS
    app1 = b"Exif\x00\x00" + tiff
    jfif = b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    comment = b"taken at 221B Fictional Street"
    return (
        b"\xff\xd8"
        + b"\xff\xe0" + struct.pack(">H", len(jfif) + 2) + jfif
        + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1
        + b"\xff\xfe" + struct.pack(">H", len(comment) + 2) + comment
        + b"\xff\xdb" + struct.pack(">H", 4) + b"\x00\x01"
        + b"\xff\xda" + struct.pack(">H", 4) + b"\x00\x00" + b"\x12\x34" + b"\xff\xd9"
    )  # fmt: skip


def test_jpeg_location_and_comments_are_removed_but_orientation_kept() -> None:
    clean = strip_metadata(jpeg_with_exif(6), "jpg")
    assert GPS not in clean
    assert b"Fictional Street" not in clean
    assert clean.startswith(b"\xff\xd8\xff\xe0")  # JFIF stays first
    assert b"Exif\x00\x00MM" in clean
    assert b"\x01\x12\x00\x03\x00\x00\x00\x01\x00\x06" in clean
    assert clean.endswith(b"\x12\x34\xff\xd9")  # the image data is untouched
    assert b"Exif" not in strip_metadata(jpeg_with_exif(1), "jpg")  # upright: no EXIF at all


def png_chunk(kind: bytes, data: bytes) -> bytes:
    import zlib

    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def test_png_and_webp_metadata_chunks_are_removed() -> None:
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00")
        + png_chunk(b"tEXt", b"Location\x0012.97,77.59")
        + png_chunk(b"eXIf", b"MM\x00\x2a" + GPS)
        + png_chunk(b"IDAT", b"\x78\x9c\x63\x60\x00\x00\x00\x02\x00\x01")
        + png_chunk(b"IEND", b"")
    )
    clean = strip_metadata(png, "png")
    assert b"Location" not in clean
    assert GPS not in clean
    assert b"IDAT" in clean
    assert clean.endswith(png_chunk(b"IEND", b""))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return kind + struct.pack("<I", len(data)) + data + (b"\x00" if len(data) & 1 else b"")

    vp8x = bytes([0x08 | 0x04, 0, 0, 0]) + b"\x00" * 6
    body = chunk(b"VP8X", vp8x) + chunk(b"VP8 ", b"\x01\x02\x03") + chunk(b"EXIF", GPS)
    webp = b"RIFF" + struct.pack("<I", len(body) + 4) + b"WEBP" + body
    clean = strip_metadata(webp, "webp")
    assert GPS not in clean
    assert b"VP8 " in clean
    assert struct.unpack("<I", clean[4:8])[0] == len(clean) - 8
    assert clean[20] & 0x0C == 0  # VP8X no longer claims EXIF or XMP


@pytest.mark.parametrize(
    ("data", "kind"),
    [
        (b"\xff\xd8\xff\xe0\x00\x10JFIF", "jpg"),  # cut off
        (b"\xff\xd8\xff\xe1\xff\xff" + b"x" * 10, "jpg"),  # segment longer than the file
        (b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR", "png"),  # no IEND
        (b"RIFF\xff\xff\x00\x00WEBPVP8 ", "webp"),
    ],
)
def test_damaged_images_are_refused(data: bytes, kind: str) -> None:
    with pytest.raises(ValueError, match=r"(?i)jpeg|png|webp|truncated|segment|marker"):
        strip_metadata(data, kind)


def test_uploaded_review_photos_are_stored_without_location() -> None:
    class Keep:
        saved: list[bytes] = []

        def save(self, data: bytes, extension: str) -> str:
            self.saved.append(data)
            return "https://images.example/x.jpg"

    store = Keep()
    client = client_for(create_and_login("customer")["token"])
    with use_image_storage(store):
        photo = io.BytesIO(jpeg_with_exif(6))
        photo.name = "photo.jpg"
        res = client.post("/api/v1/uploads/review-images", {"image": photo}, format="multipart")
        assert res.status_code == 201, res.json()
        broken = io.BytesIO(b"\xff\xd8\xff\xe1\xff\xff junk")
        broken.name = "broken.jpg"
        res = client.post("/api/v1/uploads/review-images", {"image": broken}, format="multipart")
        assert res.status_code == 415
    assert len(store.saved) == 1
    assert GPS not in store.saved[0]


# --- logs -----------------------------------------------------------------------------------------


def test_logs_never_show_tokens_or_passwords() -> None:
    token = sign_access_token(user(Role.CUSTOMER))
    text = scrub(f'Authorization: Bearer {token} body={{"password": "Hunter-22", "otp": 123456}}')
    assert token not in text
    assert "Hunter-22" not in text
    assert "123456" not in text
    assert "order_id=42" in scrub("order_id=42")

    record = logging.LogRecord(
        "x", logging.ERROR, __file__, 1, "login %s", (f"password={token}",), None
    )
    try:
        raise ValueError(f"refresh_token={token}")
    except ValueError:
        import sys

        record.exc_info = sys.exc_info()
    RedactSecrets().filter(record)
    assert token not in record.getMessage()
    assert token not in (record.exc_text or "")
