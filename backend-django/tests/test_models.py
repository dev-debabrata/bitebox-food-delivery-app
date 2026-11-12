"""
Database rules that protect money, dispatch and the ledger. These run on SQLite locally and on
PostgreSQL in CI; both enforce CHECK and partial UNIQUE constraints.
"""

from datetime import timedelta

import pytest
from django.contrib.auth.hashers import make_password
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.coins.models import (
    CoinAllocation,
    CoinBatch,
    CoinTransaction,
    CoinWallet,
    LedgerImmutable,
    LedgerStatus,
)
from apps.coupons.models import Coupon
from apps.customers.models import Address
from apps.dispatch.models import DeliveryAssignment
from apps.payments.models import Payment, WebhookEvent
from apps.rbac.roles import Role
from apps.reviews.models import Review
from common.geo import GeoPoint
from tests import factories as make

pytestmark = pytest.mark.django_db


def rejected(**kwargs: object) -> pytest.RaisesExc[IntegrityError]:
    return pytest.raises(IntegrityError)


def address(user: User, **fields: object) -> Address:
    defaults: dict[str, object] = {
        "user": user,
        "recipient_name": "Asha",
        "phone": "9000000002",
        "line1": "4B, 80 Feet Road",
        "city": "Bengaluru",
        "state": "Karnataka",
        "postal_code": "560034",
        "location": GeoPoint(lat=12.9352, lng=77.6271),
    }
    return Address.objects.create(**{**defaults, **fields})


# --- Accounts -----------------------------------------------------------------------------------


def test_email_is_unique_regardless_of_case() -> None:
    make.user(email="Asha@BiteBox.test")
    assert User.objects.filter(email="asha@bitebox.test").exists()
    with transaction.atomic(), rejected():
        make.user(email="ASHA@bitebox.test")


def test_phone_is_unique_but_optional() -> None:
    make.user(phone=None)
    make.user(phone=None)
    make.user(phone="9000000101")
    with transaction.atomic(), rejected():
        make.user(phone="9000000101")


def test_passwords_use_argon2_and_imported_bcrypt_hashes_upgrade_on_login() -> None:
    user = make.user(password="Test-pass-123")
    assert user.password.startswith("argon2")

    # A hash imported from the Node API (bcryptjs) keeps working, then is re-hashed with Argon2.
    user.password = make_password("Old-pass-456", hasher="bcrypt")
    user.save()
    assert user.password.startswith("bcrypt$")
    assert user.check_password("Old-pass-456")
    user.refresh_from_db()
    assert user.password.startswith("argon2")


def test_roles_and_permissions_on_the_user() -> None:
    support = make.user(Role.SUPPORT_ADMIN)
    assert "orders:view" in support.permissions
    assert "orders:manage" not in support.permissions
    assert make.user(Role.CUSTOMER).permissions == []
    with transaction.atomic(), rejected():
        User.objects.filter(pk=support.pk).update(role="emperor")


# --- Addresses ----------------------------------------------------------------------------------


def test_one_default_address_per_customer() -> None:
    customer = make.user()
    address(customer, is_default=True)
    address(customer, is_default=False)
    with transaction.atomic(), rejected():
        address(customer, is_default=True)
    stored = Address.objects.filter(user=customer, is_default=True).get()
    assert stored.location == GeoPoint(lat=12.9352, lng=77.6271)


# --- Orders -------------------------------------------------------------------------------------


def test_order_totals_must_add_up() -> None:
    order = make.order()
    assert order.total_paise == 29250
    with transaction.atomic(), rejected():
        make.order(total_paise=1)


def test_coupon_discount_cannot_exceed_subtotal() -> None:
    with transaction.atomic(), rejected():
        make.order(discount_paise=30000, total_paise=25000 - 30000 + 2500 + 500 + 1250)


def test_order_placement_is_idempotent_per_customer() -> None:
    customer = make.user()
    make.order(customer=customer, idempotency_key="tap-1")
    make.order(idempotency_key="tap-1")  # another customer may reuse a key
    with transaction.atomic(), rejected():
        make.order(customer=customer, idempotency_key="tap-1")


def test_unknown_order_status_is_refused() -> None:
    order = make.order()
    with transaction.atomic(), rejected():
        type(order).objects.filter(pk=order.pk).update(status="teleported")


# --- Dispatch -----------------------------------------------------------------------------------


def test_an_order_has_one_live_offer_at_a_time() -> None:
    order = make.order()
    first, second = make.user(Role.DELIVERY), make.user(Role.DELIVERY)
    offer = DeliveryAssignment.objects.create(order=order, rider=first)
    with transaction.atomic(), rejected():
        DeliveryAssignment.objects.create(order=order, rider=second)
    offer.status = "declined"
    offer.save()
    DeliveryAssignment.objects.create(order=order, rider=second)  # the next rider can now get it


# --- Payments -----------------------------------------------------------------------------------


def payment(**fields: object) -> Payment:
    order = make.order(payment_method="online")
    defaults: dict[str, object] = {
        "order": order,
        "user": order.customer,
        "method": "online",
        "provider": "razorpay",
        "amount_paise": order.total_paise,
    }
    return Payment.objects.create(**{**defaults, **fields})


def test_refunds_never_exceed_the_amount_paid() -> None:
    paid = payment()
    with transaction.atomic(), rejected():
        Payment.objects.filter(pk=paid.pk).update(refunded_paise=paid.amount_paise + 1)


def test_a_gateway_payment_maps_to_one_payment() -> None:
    payment(provider_payment_id="pay_FAKE001")
    with transaction.atomic(), rejected():
        payment(provider_payment_id="pay_FAKE001")


def test_each_webhook_event_is_stored_once() -> None:
    WebhookEvent.objects.create(provider="razorpay", event_id="evt_1")
    with transaction.atomic(), rejected():
        WebhookEvent.objects.create(provider="razorpay", event_id="evt_1")


# --- Coupons ------------------------------------------------------------------------------------


def coupon(**fields: object) -> Coupon:
    now = timezone.now()
    defaults: dict[str, object] = {
        "code": "TEST10",
        "discount_type": "percent",
        "discount_value": 10,
        "valid_from": now,
        "valid_until": now + timedelta(days=30),
    }
    return Coupon.objects.create(**{**defaults, **fields})


def test_coupon_rules() -> None:
    with transaction.atomic(), rejected():
        coupon(code="TOOMUCH", discount_value=150)
    with transaction.atomic(), rejected():
        coupon(code="BACKWARD", valid_until=timezone.now() - timedelta(days=1))
    limited = coupon(code="LIMITED", usage_limit=1)
    Coupon.objects.filter(pk=limited.pk).update(used_count=1)
    with transaction.atomic(), rejected():
        Coupon.objects.filter(pk=limited.pk).update(used_count=2)


# --- Reviews ------------------------------------------------------------------------------------


def test_one_review_per_target_per_order() -> None:
    order = make.order()
    base = {
        "customer": order.customer,
        "customer_name": "Asha",
        "order": order,
        "order_number": order.order_number,
        "restaurant": order.restaurant,
        "rating": 5,
    }
    Review.objects.create(target="restaurant", **base)
    with transaction.atomic(), rejected():
        Review.objects.create(target="restaurant", **base)
    with transaction.atomic(), rejected():
        Review.objects.create(target="food", **base)  # a dish review needs the dish
    with transaction.atomic(), rejected():
        Review.objects.create(
            **{**base, "target": "restaurant", "rating": 6, "order": make.order()}
        )


# --- Coin ledger --------------------------------------------------------------------------------


def credit(wallet: CoinWallet, seq: int, coins: int = 50) -> CoinTransaction:
    return CoinTransaction.objects.create(
        user=wallet.user,
        wallet=wallet,
        seq=seq,
        type="CREDIT",
        source="ORDER_REWARD",
        coins=coins,
        available_before=0,
        available_after=coins,
        reserved_before=0,
        reserved_after=0,
        idempotency_key=f"order-reward:test-{seq}",
    )


def test_ledger_rows_only_move_from_pending_to_posted() -> None:
    wallet = CoinWallet.objects.create(user=make.user())
    txn = credit(wallet, seq=1)

    txn.status = LedgerStatus.POSTED
    txn.posted_at = timezone.now()
    txn.save(update_fields=["status", "posted_at"])

    txn.coins = 5000
    with pytest.raises(LedgerImmutable):
        txn.save()
    with pytest.raises(LedgerImmutable):
        txn.delete()
    with pytest.raises(LedgerImmutable):
        CoinTransaction.objects.filter(pk=txn.pk).update(coins=1)
    with pytest.raises(LedgerImmutable):
        CoinTransaction.objects.filter(pk=txn.pk).delete()
    txn.refresh_from_db()
    assert txn.coins == 50


def test_ledger_keys_and_sequence_are_unique() -> None:
    wallet = CoinWallet.objects.create(user=make.user())
    credit(wallet, seq=1)
    with transaction.atomic(), rejected():
        credit(wallet, seq=1)  # same idempotency key and seq: a retried credit can't double-count


def test_allocations_are_immutable_and_batches_never_go_negative() -> None:
    wallet = CoinWallet.objects.create(user=make.user())
    origin = credit(wallet, seq=1, coins=100)
    now = timezone.now()
    batch = CoinBatch.objects.create(
        wallet=wallet,
        origin=origin,
        source="ORDER_REWARD",
        original=100,
        remaining=100,
        earned_at=now,
    )
    spend = CoinTransaction.objects.create(
        user=wallet.user,
        wallet=wallet,
        seq=2,
        type="RESERVE",
        source="COIN_REDEMPTION",
        coins=40,
        available_before=100,
        available_after=60,
        reserved_before=0,
        reserved_after=40,
        idempotency_key="order-redeem:test",
    )
    allocation = CoinAllocation.objects.create(
        transaction=spend, batch=batch, source="ORDER_REWARD", earned_at=now, coins=40
    )
    with pytest.raises(LedgerImmutable):
        allocation.save()
    with pytest.raises(LedgerImmutable):
        CoinAllocation.objects.all().delete()
    with transaction.atomic(), rejected():
        CoinBatch.objects.filter(pk=batch.pk).update(remaining=101)
