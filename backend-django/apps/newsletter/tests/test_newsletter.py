"""Port of the Node API's tests/newsletter.test.js (public footer sign-up)."""

from typing import Any

import pytest
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIClient

from apps.newsletter.models import NewsletterSubscription

pytestmark = pytest.mark.django_db

URL = "/api/v1/newsletter/subscriptions"


@pytest.fixture(autouse=True)
def _clear_rate_limits() -> None:
    cache.clear()


def subscribe(email: Any) -> Any:
    return APIClient().post(URL, {"email": email}, format="json")


def test_subscribes_an_email_once_and_says_so_when_it_is_repeated() -> None:
    first = subscribe("  Meera.Iyer@Example.com ")
    assert first.status_code == 200, first.json()
    assert first.json()["data"] == {"subscribed": True, "alreadySubscribed": False}
    assert first.json()["message"] == "Subscribed"

    again = subscribe("meera.iyer@example.com")
    assert again.json()["data"]["alreadySubscribed"] is True
    assert again.json()["message"] == "You're already subscribed"
    assert NewsletterSubscription.objects.count() == 1
    assert NewsletterSubscription.objects.get().email == "meera.iyer@example.com"


def test_handles_repeated_duplicate_requests() -> None:
    # Parallel requests cannot run inside one test transaction; the unique index stops both.
    results = [subscribe("kabir@example.com") for _ in range(5)]
    assert all(r.status_code == 200 for r in results)
    assert NewsletterSubscription.objects.count() == 1


def test_resubscribes_someone_who_unsubscribed() -> None:
    NewsletterSubscription.objects.create(email="asha@example.com", status="unsubscribed")
    res = subscribe("asha@example.com")
    assert res.json()["data"]["alreadySubscribed"] is False
    assert NewsletterSubscription.objects.get().status == "subscribed"


def test_rejects_invalid_input_and_ignores_extra_fields() -> None:
    for email in ["", "not-an-email", "a@b", 42, None]:
        res = subscribe(email)
        assert res.status_code == 422, email
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert subscribe("not-an-email").json()["error"]["details"] == [
        {"field": "email", "message": "Enter a valid email address"}
    ]
    res = APIClient().post(
        URL,
        {"email": "riya@example.com", "status": "unsubscribed", "source": "admin"},
        format="json",
    )
    assert res.status_code == 200
    saved = NewsletterSubscription.objects.get()
    assert saved.status == "subscribed"
    assert saved.source == "footer"
    assert NewsletterSubscription.objects.filter(email="").count() == 0


@override_settings(NEWSLETTER_RATE_LIMIT="2/900s")
def test_is_rate_limited() -> None:
    assert subscribe("one@example.com").status_code == 200
    assert subscribe("two@example.com").status_code == 200
    res = subscribe("three@example.com")
    assert res.status_code == 429
    assert res.json()["message"] == "Too many sign-up attempts. Please try again later."
