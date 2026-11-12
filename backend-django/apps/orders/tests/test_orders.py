"""
Port of the Node API's tests/orders.test.js (workflow, restaurant, customer, dispatch, admin) and
the "placing orders" part of tests/checkout.test.js.

Races are tested deterministically: tests run inside one database transaction, so two truly
parallel requests are not possible here. Instead, the competing write is made between the
read and the conditional update, which is exactly the window a real race hits.
"""

import re
from datetime import timedelta
from typing import Any
from unittest import mock

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.cart.models import Cart
from apps.coupons.models import Coupon, CouponRedemption
from apps.customers.models import Address
from apps.delivery.models import DeliveryPartner
from apps.dispatch.config import DISPATCH
from apps.dispatch.models import AssignmentStatus, DeliveryAssignment
from apps.dispatch.services import sweep
from apps.finance.models import OrderSettlement
from apps.menus.models import FoodItem
from apps.notifications.models import Notification
from apps.orders import workflow
from apps.orders.models import Order, OrderStatus
from apps.orders.workflow import TRANSITIONS, can_transition
from apps.payments.models import Payment
from apps.restaurants.models import Restaurant
from common.seed import seed

pytestmark = pytest.mark.django_db
PASSWORD = "Sup3rSecret!1"

NEAR = {"latitude": 12.9729, "longitude": 77.6412}  # ~110 m from the restaurant
FARTHER = {"latitude": 12.9899, "longitude": 77.6412}  # ~2 km
TOO_FAR = {"latitude": 13.1719, "longitude": 77.6412}  # ~22 km
ADDRESS = {
    "recipientName": "Asha",
    "phone": "9000000002",
    "line1": "Flat 4B, 80 Feet Road",
    "city": "Bengaluru",
    "state": "Karnataka",
    "postalCode": "560034",
    "location": {"latitude": 12.9352, "longitude": 77.6271},
}


def client_for(token: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


class World:
    """Seeded catalogue, open 24 hours; a signed-in customer, restaurant owner and rider."""

    def __init__(self) -> None:
        cache.clear()
        seed(PASSWORD)
        Restaurant.objects.filter(slug="spice-route-kitchen").update(
            opening_time="00:00", closing_time="00:00"
        )
        self.customer = create_and_login("customer")
        self.owner = create_and_login("restaurant")
        self.rider = create_and_login("delivery")
        self.c = client_for(self.customer["token"])
        self.o = client_for(self.owner["token"])
        self.r = client_for(self.rider["token"])
        self.food = {f.name: f for f in FoodItem.objects.all()}

    # -- helpers ------------------------------------------------------------------------------
    def address_id(self, user_id: str | None = None) -> str:
        return str(
            Address.objects.get(user_id=user_id or self.customer["user"]["id"], is_default=True).pk
        )

    def add(
        self, client: APIClient | None = None, dish: str = "Butter Chicken", qty: int = 2
    ) -> Any:
        return (client or self.c).post(
            "/api/v1/cart/items",
            {"foodItemId": str(self.food[dish].pk), "quantity": qty},
            format="json",
        )

    def place(self, client: APIClient | None = None, key: str | None = None, **body: Any) -> Any:
        extra = {"HTTP_IDEMPOTENCY_KEY": key} if key else {}
        payload = {"paymentMethod": "cod", "addressId": self.address_id(), **body}
        return (client or self.c).post("/api/v1/orders", payload, format="json", **extra)

    def place_order(self, coupon: str | None = None) -> str:
        self.add()
        if coupon:
            self.c.post("/api/v1/cart/coupon", {"code": coupon}, format="json")
        res = self.place()
        assert res.status_code == 201, res.json()
        return str(res.json()["data"]["order"]["id"])

    def restaurant_set(self, order_id: str, status: str, reason: str | None = None) -> Any:
        body: dict[str, Any] = {"status": status}
        if reason is not None:
            body["reason"] = reason
        return self.o.patch(f"/api/v1/my/restaurant/orders/{order_id}/status", body, format="json")

    def go_online(self, client: APIClient, where: dict[str, float] = NEAR) -> Any:
        return client.patch(
            "/api/v1/delivery/me/availability", {"isOnline": True, **where}, format="json"
        )

    def rider_set(
        self, client: APIClient, order_id: str, status: str, otp: str | None = None
    ) -> Any:
        """For "delivered", sends the customer's code from the database unless `otp` is given."""
        body: dict[str, Any] = {"status": status}
        if status == "delivered":
            code = otp
            if code is None:
                code = (
                    Order.objects.filter(pk=order_id).values_list("delivery_otp", flat=True).first()
                )
            if code:
                body["otp"] = code
        return client.patch(f"/api/v1/delivery/orders/{order_id}/status", body, format="json")

    def dashboard(self, client: APIClient) -> Any:
        return client.get("/api/v1/delivery/me")

    def offer_id(self, client: APIClient) -> str | None:
        offer = self.dashboard(client).json()["data"]["offer"]
        return offer["id"] if offer else None

    def accept(self, client: APIClient, order_id: str) -> Any:
        return client.post(f"/api/v1/delivery/offers/{order_id}/accept")

    def ready_order(self, coupon: str | None = None) -> str:
        order_id = self.place_order(coupon)
        for status in ("confirmed", "preparing", "ready_for_pickup"):
            assert self.restaurant_set(order_id, status).status_code == 200
        return order_id

    def new_rider(
        self, where: dict[str, float] | None = None, name: str = "Second Rider"
    ) -> APIClient:
        res, _ = register(APIClient(), role="delivery", name=name)
        client = client_for(token_of(res))
        client.put(
            "/api/v1/delivery/me/vehicle",
            {"vehicleType": "scooter", "vehicleNumber": "KA 02 CC 1234"},
            format="json",
        )
        if where:
            assert self.go_online(client, where).status_code == 200
        return client

    def new_customer(self) -> APIClient:
        res, _ = register(APIClient())
        return client_for(token_of(res))


@pytest.fixture
def w() -> World:
    return World()


def history(order_id: str) -> list[str]:
    return list(
        Order.objects.get(pk=order_id)
        .status_history.order_by("created_at")
        .values_list("to_status", flat=True)
    )


# --- the state machine ------------------------------------------------------------------------


def test_only_allows_the_documented_moves() -> None:
    assert can_transition("pending", "confirmed", "restaurant")
    assert can_transition("pending", "cancelled", "customer")
    assert not can_transition("confirmed", "cancelled", "customer")  # accepted orders
    assert not can_transition("pending", "preparing", "restaurant")  # cannot skip acceptance
    assert not can_transition("ready_for_pickup", "assigned", "restaurant")  # riders accept
    assert not can_transition("picked_up", "cancelled", "admin")  # food on its way
    for final in ("delivered", "rejected", "cancelled"):
        assert TRANSITIONS[final] == {}


# --- placing orders (checkout.test.js) --------------------------------------------------------


def test_creates_an_order_with_snapshots_a_cod_payment_and_an_empty_cart(w: World) -> None:
    w.add()
    w.c.post("/api/v1/cart/coupon", {"code": "WELCOME50"}, format="json")
    quote = w.c.get("/api/v1/cart").json()["data"]

    res = w.place(expectedTotalPaise=quote["pricing"]["totalPaise"], note="Ring the bell")
    assert res.status_code == 201, res.json()
    assert res.json()["message"] == "Order placed"
    assert res.json()["data"]["checkout"] is None
    order = res.json()["data"]["order"]
    assert re.fullmatch(r"BB-\d{6}-[A-Z2-9]{6}", order["orderNumber"])
    assert (order["status"], order["paymentMethod"], order["paymentStatus"]) == (
        "pending",
        "cod",
        "pending",
    )
    assert order["pricing"] == quote["pricing"]
    assert order["items"][0]["unitPricePaise"] == 34900
    assert order["deliveryAddress"]["city"] == "Bengaluru"
    assert order["deliveryAddress"]["location"]["type"] == "Point"
    assert order["restaurantSnapshot"]["name"] == "Spice Route Kitchen"
    assert order["coupon"] == {
        "code": "WELCOME50",
        "discountPaise": quote["pricing"]["discountPaise"],
    }
    assert order["note"] == "Ring the bell"
    assert order["submittedAt"]
    assert [h["status"] for h in order["statusHistory"]] == ["pending"]
    assert "idempotencyKey" not in order
    assert "settlement" not in order

    assert w.c.get("/api/v1/cart").json()["data"]["cart"] is None
    payment = Payment.objects.get(order_id=order["id"])
    assert (payment.amount_paise, payment.provider) == (
        quote["pricing"]["totalPaise"],
        "cash_on_delivery",
    )
    assert Coupon.objects.get(code="WELCOME50").used_count == 1
    assert CouponRedemption.objects.count() == 1
    # The restaurant hears about a cash order at once.
    assert Notification.objects.filter(type="order.new", user_id=w.owner["user"]["id"]).exists()

    # Later menu price changes never alter the order.
    FoodItem.objects.filter(pk=w.food["Butter Chicken"].pk).update(price_paise=99900)
    fetched = w.c.get(f"/api/v1/orders/{order['id']}").json()["data"]["order"]
    assert fetched["items"][0]["unitPricePaise"] == 34900
    assert fetched["payment"]["status"] == "pending"
    assert fetched["rider"] is None


def test_refuses_when_the_price_changed_since_the_customer_saw_it(w: World) -> None:
    w.add()
    seen = w.c.get("/api/v1/cart").json()["data"]["pricing"]["totalPaise"]
    FoodItem.objects.filter(pk=w.food["Butter Chicken"].pk).update(price_paise=39900)
    res = w.place(expectedTotalPaise=seen)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "PRICE_CHANGED"
    assert w.c.get("/api/v1/cart").json()["data"]["cart"] is not None  # cart kept


def test_returns_the_same_order_for_a_retried_idempotency_key(w: World) -> None:
    w.add()
    first = w.place(key="checkout-key-123")
    retry = w.place(key="checkout-key-123")
    assert first.status_code == 201
    assert retry.status_code == 200
    assert retry.json()["message"] == "Order already placed"
    assert retry.json()["data"]["order"]["id"] == first.json()["data"]["order"]["id"]
    assert Order.objects.count() == 1
    bad = w.place(key="short")
    assert bad.status_code == 422
    assert bad.json()["error"]["details"][0]["field"] == "idempotency-key"


def test_never_turns_one_cart_into_two_orders(w: World) -> None:
    w.add()
    assert w.place().status_code == 201
    again = w.place()  # the second tap finds the cart already claimed
    assert again.status_code == 400
    assert Order.objects.count() == 1
    assert Payment.objects.count() == 1


def test_a_cart_changed_after_pricing_is_not_ordered(w: World) -> None:
    """The cart is claimed only if it is still the version that was priced (CART_CHANGED)."""
    w.add()
    from apps.cart import services as cart_services

    real = cart_services.build_quote

    def quote_then_change(*args: Any, **kwargs: Any) -> Any:
        quote = real(*args, **kwargs)
        Cart.objects.filter(user_id=w.customer["user"]["id"]).update(
            updated_at=timezone.now() + timedelta(seconds=5)
        )
        return quote

    with mock.patch.object(cart_services, "build_quote", quote_then_change):
        res = w.place()
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "CART_CHANGED"
    assert Order.objects.count() == 0
    assert Cart.objects.filter(user_id=w.customer["user"]["id"]).exists()


def test_enforces_coupon_usage_limits_and_keeps_the_losing_cart(w: World) -> None:
    Coupon.objects.filter(code="WELCOME50").update(usage_limit=1)
    other = w.new_customer()
    other.post("/api/v1/addresses", ADDRESS, format="json")
    other_id = other.get("/api/v1/auth/me").json()["data"]["user"]["id"]
    for client in (w.c, other):
        w.add(client)
        assert (
            client.post("/api/v1/cart/coupon", {"code": "WELCOME50"}, format="json").status_code
            == 200
        )

    assert w.place().status_code == 201
    lost = w.place(other, addressId=w.address_id(other_id))
    assert lost.status_code == 409
    assert Coupon.objects.get(code="WELCOME50").used_count == 1
    assert Order.objects.count() == 1
    assert Cart.objects.filter(items__isnull=False).distinct().count() == 1  # loser's cart kept


def test_the_coupon_reservation_respects_the_limit_at_write_time(w: World) -> None:
    """Two customers priced the cart while one use was left; only one reservation succeeds."""
    w.add()
    w.c.post("/api/v1/cart/coupon", {"code": "WELCOME50"}, format="json")
    Coupon.objects.filter(code="WELCOME50").update(usage_limit=1)
    from apps.coupons import services as coupon_services
    from apps.orders import services as order_services

    real = coupon_services.assert_eligible

    def eligible_then_exhausted(*args: Any, **kwargs: Any) -> Any:
        coupon = real(*args, **kwargs)
        Coupon.objects.filter(pk=coupon.pk).update(used_count=1)  # someone else just used it
        return coupon

    with mock.patch.object(order_services, "assert_eligible", eligible_then_exhausted):
        res = w.place()
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "COUPON_EXHAUSTED"
    assert Order.objects.count() == 0
    assert Cart.objects.filter(user_id=w.customer["user"]["id"]).exists()


def test_allows_a_coupon_only_once_per_customer(w: World) -> None:
    w.place_order(coupon="WELCOME50")
    w.add()
    again = w.c.post("/api/v1/cart/coupon", {"code": "WELCOME50"}, format="json")
    assert again.status_code == 422
    assert again.json()["error"]["code"] == "COUPON_USED"


def test_rejects_empty_carts_blocked_carts_and_other_peoples_addresses(w: World) -> None:
    assert w.place().status_code == 400  # empty

    w.add(dish="Garlic Naan", qty=1)  # below the minimum
    blocked = w.place()
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "CHECKOUT_BLOCKED"
    assert blocked.json()["error"]["details"][0]["field"] == "BELOW_MINIMUM"

    other = w.new_customer()
    theirs = other.post("/api/v1/addresses", ADDRESS, format="json").json()["data"]["address"]
    assert w.place(addressId=theirs["id"]).status_code == 404
    bad = w.place(paymentMethod="bitcoin")
    assert bad.status_code == 422
    assert bad.json()["error"]["details"][0] == {
        "field": "paymentMethod",
        "message": "Choose a payment method",
    }
    # Online payment is checked the same way (the cart is still below the minimum).
    assert w.place(paymentMethod="online").json()["error"]["code"] == "CHECKOUT_BLOCKED"


def test_lists_only_the_customers_own_orders(w: World) -> None:
    order_id = w.place_order()
    items = w.c.get("/api/v1/orders").json()["data"]["items"]
    assert [i["id"] for i in items] == [order_id]
    assert items[0]["myRating"] is None
    assert items[0]["pricing"] == {"totalPaise": Order.objects.get(pk=order_id).total_paise}

    other = w.new_customer()
    assert other.get(f"/api/v1/orders/{order_id}").status_code == 404
    assert other.get("/api/v1/orders").json()["data"]["items"] == []


# --- the whole journey ------------------------------------------------------------------------


def test_runs_the_whole_workflow_from_order_to_delivery(w: World) -> None:
    assert w.go_online(w.r).status_code == 200
    order_id = w.place_order()

    accepted = w.restaurant_set(order_id, "confirmed")
    assert accepted.json()["message"] == "Order accepted"
    order = accepted.json()["data"]["order"]
    assert order["status"] == "confirmed"
    assert "phone" not in order["deliveryAddress"]  # the restaurant never sees the phone
    w.restaurant_set(order_id, "preparing")
    ready = w.restaurant_set(order_id, "ready_for_pickup").json()["data"]["order"]
    assert ready["pickupBy"]

    # Ready → offered to the only nearby rider, who sees the pickup but not the customer's phone.
    offer = w.dashboard(w.r).json()["data"]["offer"]
    assert offer["id"] == order_id
    assert offer["offerExpiresAt"]
    assert offer["offerWindowSeconds"] == DISPATCH["offer_timeout_seconds"]
    assert "phone" not in offer["deliveryAddress"]

    accept = w.accept(w.r, order_id)
    assert accept.status_code == 200
    assert accept.json()["message"] == "Delivery accepted. Head to the restaurant."
    active = accept.json()["data"]["activeOrder"]
    assert active["status"] == "assigned"
    assert active["deliveryAddress"]["phone"]  # the carrying rider gets the phone

    seen = w.c.get(f"/api/v1/orders/{order_id}").json()["data"]["order"]
    assert seen["rider"]["name"] == "Ravi Rider"
    assert seen["rider"]["vehicleType"] == "motorbike"

    for status in ("picked_up", "on_the_way", "delivered"):
        res = w.rider_set(w.r, order_id, status)
        assert res.status_code == 200, res.json()
    assert res.json()["message"] == "Delivered. Nice work!"

    stored = Order.objects.get(pk=order_id)
    assert (stored.status, stored.payment_status) == ("delivered", "paid")
    assert history(order_id) == [
        "pending",
        "confirmed",
        "preparing",
        "ready_for_pickup",
        "assigned",
        "picked_up",
        "on_the_way",
        "delivered",
    ]
    assert Payment.objects.get(order_id=order_id).status == "paid"  # cash collected
    profile = DeliveryPartner.objects.get(user_id=w.rider["user"]["id"])
    assert profile.active_order_id is None  # free again
    assert profile.completed_deliveries == 1
    assert DeliveryAssignment.objects.get(order_id=order_id).status == AssignmentStatus.COMPLETED

    # The money split: restaurant 85% of the food after the coupon; the rider ₹20 + ₹6/started km.
    settlement = OrderSettlement.objects.get(order_id=order_id)
    food = stored.subtotal_paise - stored.discount_paise
    assert settlement.restaurant_paise == round(food * 0.85)
    assert settlement.rider_paise == 2000 + -(-stored.distance_m // 1000) * 600
    assert (
        settlement.platform_paise
        == stored.total_paise - settlement.restaurant_paise - settlement.rider_paise
    )

    rider_history = w.r.get("/api/v1/delivery/orders/history").json()["data"]
    assert rider_history["items"][0]["id"] == order_id
    assert "settlement" not in rider_history["items"][0]


# --- restaurant -------------------------------------------------------------------------------


def test_enforces_the_transition_table_and_treats_repeats_as_no_ops(w: World) -> None:
    order_id = w.place_order()
    skip = w.restaurant_set(order_id, "ready_for_pickup")
    assert skip.status_code == 409
    assert skip.json()["error"]["code"] == "INVALID_TRANSITION"
    assert skip.json()["message"] == (
        "This order is waiting for the restaurant and cannot be ready for pickup now"
    )

    assert w.restaurant_set(order_id, "confirmed").status_code == 200
    assert w.restaurant_set(order_id, "confirmed").status_code == 200  # double click is harmless
    assert len(history(order_id)) == 2  # recorded once
    assert w.restaurant_set(order_id, "rejected", "Too busy").status_code == 409


def test_needs_a_reason_to_reject_and_gives_the_coupon_use_back(w: World) -> None:
    order_id = w.place_order(coupon="WELCOME50")
    assert Coupon.objects.get(code="WELCOME50").used_count == 1
    no_reason = w.restaurant_set(order_id, "rejected")
    assert no_reason.status_code == 400
    assert no_reason.json()["message"] == "Tell the customer why the order is rejected"

    res = w.restaurant_set(order_id, "rejected", "Out of chicken today")
    assert res.json()["data"]["order"]["status"] == "rejected"
    order = Order.objects.get(pk=order_id)
    assert (order.cancellation.by, order.cancellation.reason) == (
        "restaurant",
        "Out of chicken today",
    )
    assert order.payment_status == "cancelled"
    assert Coupon.objects.get(code="WELCOME50").used_count == 0  # use restored
    assert CouponRedemption.objects.count() == 0
    assert Payment.objects.get(order_id=order_id).status == "cancelled"
    assert Notification.objects.filter(
        user_id=w.customer["user"]["id"], type="order.rejected", body="Out of chicken today"
    ).exists()


def test_only_sees_and_changes_its_own_restaurants_orders(w: World) -> None:
    order_id = w.place_order()
    res, _ = register(APIClient(), role="restaurant", name="Other Owner")
    other = client_for(token_of(res))
    created = other.post(
        "/api/v1/my/restaurant",
        {
            "name": "Other Place",
            "cuisines": ["Chinese"],
            "phone": "9111111111",
            "address": {
                "line1": "1 Test Street",
                "city": "Bengaluru",
                "state": "Karnataka",
                "postalCode": "560001",
            },
            "location": {"latitude": 12.97, "longitude": 77.6},
            "costForTwoPaise": 50000,
            "openingTime": "10:00",
            "closingTime": "22:00",
        },
        format="json",
    )
    assert created.status_code == 201, created.json()
    assert (
        other.patch(
            f"/api/v1/my/restaurant/orders/{order_id}/status",
            {"status": "confirmed"},
            format="json",
        ).status_code
        == 404
    )
    assert other.get(f"/api/v1/my/restaurant/orders/{order_id}").status_code == 404
    assert other.get("/api/v1/my/restaurant/orders").json()["data"]["items"] == []

    mine = w.o.get("/api/v1/my/restaurant/orders").json()["data"]
    assert len(mine["items"]) == 1
    assert mine["counts"] == {"pending": 1}
    assert mine["items"][0]["respondBy"]
    assert set(mine["items"][0]["deliveryAddress"]) == {"recipientName", "area", "city"}

    history_view = w.o.get("/api/v1/my/restaurant/orders?view=history").json()["data"]
    assert history_view["items"] == []
    assert history_view["pagination"]["total"] == 0
    assert w.o.get("/api/v1/my/restaurant/orders?view=later").status_code == 422
    assert w.c.get("/api/v1/my/restaurant/orders").status_code == 403


def test_lets_exactly_one_of_two_racing_changes_win(w: World) -> None:
    """The restaurant accepts while the customer cancels: the second write finds it changed."""
    order_id = w.place_order()
    real = workflow.can_transition

    def customer_cancels_first(*args: Any) -> bool:
        Order.objects.filter(pk=order_id).update(status=OrderStatus.CANCELLED)
        return real(*args)

    with mock.patch.object(workflow, "can_transition", customer_cancels_first):
        res = w.restaurant_set(order_id, "confirmed")
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ORDER_CHANGED"
    assert len(history(order_id)) == 1  # nothing recorded for the loser


def test_a_racing_identical_change_is_a_no_op(w: World) -> None:
    order_id = w.place_order()
    real = workflow.can_transition

    def accepted_meanwhile(*args: Any) -> bool:
        Order.objects.filter(pk=order_id).update(status=OrderStatus.CONFIRMED)
        return real(*args)

    with mock.patch.object(workflow, "can_transition", accepted_meanwhile):
        res = w.restaurant_set(order_id, "confirmed")
    assert res.status_code == 200
    assert len(history(order_id)) == 1


# --- customer ---------------------------------------------------------------------------------


def test_can_cancel_only_before_the_restaurant_accepts(w: World) -> None:
    first = w.place_order()
    cancel = w.c.post(
        f"/api/v1/orders/{first}/cancel", {"reason": "Ordered by mistake"}, format="json"
    )
    assert cancel.status_code == 200
    assert cancel.json()["message"] == "Order cancelled"
    assert cancel.json()["data"]["order"]["status"] == "cancelled"
    assert cancel.json()["data"]["order"]["cancellation"]["reason"] == "Ordered by mistake"
    # The restaurant is told; the customer (who cancelled) is not.
    assert Notification.objects.filter(
        user_id=w.owner["user"]["id"], type="order.cancelled"
    ).exists()
    assert not Notification.objects.filter(
        user_id=w.customer["user"]["id"], type="order.cancelled"
    ).exists()

    second = w.place_order()
    w.restaurant_set(second, "confirmed")
    late = w.c.post(f"/api/v1/orders/{second}/cancel", {}, format="json")
    assert late.status_code == 409
    too_long = w.c.post(f"/api/v1/orders/{second}/cancel", {"reason": "x" * 301}, format="json")
    assert too_long.status_code == 422
    assert too_long.json()["error"]["details"][0]["message"] == (
        "Keep the reason under 300 characters"
    )


def test_cannot_cancel_or_read_someone_elses_order(w: World) -> None:
    order_id = w.place_order()
    stranger = w.new_customer()
    assert stranger.post(f"/api/v1/orders/{order_id}/cancel", {}, format="json").status_code == 404
    assert stranger.get(f"/api/v1/orders/{order_id}").status_code == 404
    assert w.c.get("/api/v1/orders/not-an-id").status_code == 422


# --- dispatch ---------------------------------------------------------------------------------


def test_offers_the_nearest_free_rider_then_the_next_after_a_decline(w: World) -> None:
    far = w.new_rider(FARTHER)
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()

    assert w.offer_id(w.r) == order_id  # nearest first
    assert w.offer_id(far) is None

    steal = w.accept(far, order_id)  # not offered to them
    assert steal.status_code == 409
    assert steal.json()["error"]["code"] == "OFFER_UNAVAILABLE"

    decline = w.r.post(f"/api/v1/delivery/offers/{order_id}/decline")
    assert decline.status_code == 200
    assert decline.json()["message"] == "Request declined"
    assert w.offer_id(far) == order_id  # moved to the next rider
    assert w.offer_id(w.r) is None  # not offered again to the decliner
    assert w.r.post(f"/api/v1/delivery/offers/{order_id}/decline").status_code == 409


def test_skips_riders_who_are_too_far_stale_busy_or_without_a_vehicle(w: World) -> None:
    w.new_rider(TOO_FAR, name="Far Rider")
    stale = w.new_rider(NEAR, name="Stale Rider")
    DeliveryPartner.objects.filter(user__name="Stale Rider").update(
        location_updated_at=timezone.now()
        - timedelta(minutes=DISPATCH["location_fresh_minutes"] + 1)
    )
    res, _ = register(APIClient(), role="delivery", name="No Vehicle")
    no_vehicle = w.go_online(client_for(token_of(res)))
    assert no_vehicle.status_code == 400
    assert no_vehicle.json()["message"] == "Add your vehicle details before going online"
    no_location = w.r.patch("/api/v1/delivery/me/availability", {"isOnline": True}, format="json")
    assert no_location.json()["message"] == "Share your location to go online"

    order_id = w.ready_order()
    assert not DeliveryAssignment.objects.filter(order_id=order_id).exists()  # nobody eligible
    assert w.offer_id(stale) is None

    # A rider coming online picks up the waiting order straight away.
    online = w.go_online(w.r, NEAR)
    assert online.json()["message"] == "You are online"
    assert online.json()["data"]["offer"]["id"] == order_id


def test_a_suspended_rider_is_never_offered_an_order(w: World) -> None:
    w.go_online(w.r, NEAR)
    from apps.accounts.models import User

    User.objects.filter(pk=w.rider["user"]["id"]).update(status="suspended")
    order_id = w.ready_order()
    assert not DeliveryAssignment.objects.filter(order_id=order_id).exists()


def test_expires_ignored_offers_sets_that_rider_offline_and_re_offers(w: World) -> None:
    second = w.new_rider(FARTHER)
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()

    later = timezone.now() + timedelta(seconds=DISPATCH["offer_timeout_seconds"] + 5)
    summary = sweep(later)
    assert summary["expired_offers"] == 1
    assert summary["dispatched"] == 1
    ignored = DeliveryPartner.objects.get(user_id=w.rider["user"]["id"])
    assert ignored.is_online is False  # the rider who ignored it goes offline
    assert ignored.current_offer_id is None
    assert w.offer_id(second) == order_id  # offered to the next rider

    late = w.accept(w.r, order_id)
    assert late.status_code == 409  # an expired offer cannot be accepted


def test_an_offer_past_its_time_cannot_be_accepted_even_before_the_sweep(w: World) -> None:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    DeliveryAssignment.objects.filter(order_id=order_id).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert w.accept(w.r, order_id).status_code == 409
    assert Order.objects.get(pk=order_id).status == "ready_for_pickup"


def test_never_gives_one_rider_two_orders(w: World) -> None:
    w.go_online(w.r, NEAR)
    first = w.ready_order()
    second = w.ready_order()
    profile = DeliveryPartner.objects.get(user_id=w.rider["user"]["id"])
    assert str(profile.current_offer_id) == first
    assert not DeliveryAssignment.objects.filter(order_id=second).exists()  # second waits

    w.accept(w.r, first)
    sweep()
    assert not DeliveryAssignment.objects.filter(order_id=second).exists()  # busy rider
    offline = w.r.patch("/api/v1/delivery/me/availability", {"isOnline": False}, format="json")
    assert offline.status_code == 409
    assert offline.json()["error"]["code"] == "DELIVERY_IN_PROGRESS"


def test_only_lets_the_carrying_rider_update_a_delivery(w: World) -> None:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    w.accept(w.r, order_id)
    other = w.new_rider()
    assert w.rider_set(other, order_id, "picked_up").status_code == 404
    assert w.rider_set(w.r, order_id, "delivered").status_code == 409  # cannot skip pickup
    assert w.rider_set(w.r, order_id, "picked_up").status_code == 200
    bad = w.rider_set(w.r, order_id, "cancelled")
    assert bad.status_code == 422
    assert bad.json()["error"]["details"][0]["message"] == (
        "Status must be arrived_at_restaurant, picked_up, on_the_way or delivered"
    )


def test_rider_profile_vehicle_and_location(w: World) -> None:
    rider = w.new_rider()
    me = w.dashboard(rider).json()["data"]
    assert me["offer"] is None
    assert me["activeOrder"] is None
    assert me["profile"]["vehicleType"] == "scooter"
    assert me["profile"]["vehicleNumber"] == "KA 02 CC 1234"
    assert me["profile"]["isOnline"] is False

    bad = rider.put("/api/v1/delivery/me/vehicle", {"vehicleType": "rocket"}, format="json")
    assert bad.json()["error"]["details"][0]["message"] == (
        "Vehicle must be one of: bicycle, scooter, motorbike, car"
    )
    saved = rider.put(
        "/api/v1/delivery/me/vehicle",
        {"vehicleType": "bicycle", "vehicleNumber": "cycle-01"},
        format="json",
    )
    assert saved.json()["message"] == "Vehicle saved"
    assert saved.json()["data"]["profile"]["vehicleNumber"] == "CYCLE-01"

    offline = rider.put("/api/v1/delivery/me/location", NEAR, format="json")
    assert offline.status_code == 409
    assert offline.json()["error"]["code"] == "OFFLINE"
    w.go_online(rider, FARTHER)
    moved = rider.put("/api/v1/delivery/me/location", NEAR, format="json")
    assert moved.status_code == 200
    assert moved.json()["data"]["locationUpdatedAt"]
    assert (
        rider.put(
            "/api/v1/delivery/me/location", {"latitude": 91, "longitude": 0}, format="json"
        ).json()["error"]["details"][0]["message"]
        == "Invalid latitude"
    )
    gone = rider.patch("/api/v1/delivery/me/availability", {"isOnline": False}, format="json")
    assert gone.json()["message"] == "You are offline"
    assert gone.json()["data"]["profile"]["isOnline"] is False


# --- timeouts ---------------------------------------------------------------------------------


def test_auto_rejects_orders_the_restaurant_never_answers(w: World) -> None:
    order_id = w.place_order()
    summary = sweep(timezone.now() + timedelta(minutes=DISPATCH["restaurant_response_minutes"] + 1))
    assert summary["auto_rejected"] == 1
    order = Order.objects.get(pk=order_id)
    assert order.status == "rejected"
    assert order.cancellation.by == "system"
    assert order.cancellation.reason == "The restaurant did not respond in time"


def test_cancels_orders_nobody_picked_up_in_time(w: World) -> None:
    order_id = w.ready_order()  # no rider online
    assert sweep()["pickup_expired"] == 0
    summary = sweep(timezone.now() + timedelta(minutes=DISPATCH["pickup_window_minutes"] + 1))
    assert summary["pickup_expired"] == 1
    assert Order.objects.get(pk=order_id).status == "cancelled"


# --- admin ------------------------------------------------------------------------------------


@pytest.fixture
def admin(w: World) -> APIClient:
    return client_for(create_and_login("admin")["token"])


def test_admin_monitors_cancels_with_a_reason_and_unassigns_riders(
    w: World, admin: APIClient
) -> None:
    second = w.new_rider(FARTHER)
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    w.accept(w.r, order_id)

    listed = admin.get("/api/v1/admin/orders?status=active").json()["data"]
    assert listed["items"][0]["id"] == order_id
    assert listed["counts"]["assigned"] == 1
    assert admin.get("/api/v1/admin/orders?search=bb-").json()["data"]["pagination"]["total"] == 1
    assert admin.get("/api/v1/admin/orders?status=lost").status_code == 422

    detail = admin.get(f"/api/v1/admin/orders/{order_id}").json()["data"]["order"]
    assert detail["rider"]["name"] == "Ravi Rider"
    assert detail["offer"] is None

    unassign = admin.post(
        f"/api/v1/admin/orders/{order_id}/unassign",
        {"reason": "Rider's bike broke down"},
        format="json",
    )
    assert unassign.status_code == 200
    assert unassign.json()["message"] == "Rider unassigned; looking for another rider"
    assert unassign.json()["data"]["order"]["status"] == "ready_for_pickup"
    assert unassign.json()["data"]["order"]["offer"]["rider"]["name"] == "Second Rider"
    assert DeliveryPartner.objects.get(user_id=w.rider["user"]["id"]).active_order_id is None
    assert w.offer_id(second) == order_id  # re-offered to someone else

    no_reason = admin.post(f"/api/v1/admin/orders/{order_id}/cancel", {}, format="json")
    assert no_reason.status_code == 422
    assert no_reason.json()["error"]["details"][0]["message"] == "Give a reason"
    cancel = admin.post(
        f"/api/v1/admin/orders/{order_id}/cancel", {"reason": "Customer unreachable"}, format="json"
    )
    assert cancel.json()["data"]["order"]["status"] == "cancelled"
    assert w.offer_id(second) is None  # offer withdrawn
    assert not DeliveryAssignment.objects.filter(
        order_id=order_id, status__in=["offered", "accepted"]
    ).exists()

    from apps.audit.models import AuditLog

    assert list(AuditLog.objects.order_by("created_at").values_list("action", "description")) == [
        ("order.unassign", "Unassigned the rider: Rider's bike broke down"),
        ("order.cancel", "Cancelled order: Customer unreachable"),
    ]


def test_admin_manages_riders_and_cannot_suspend_one_mid_delivery(
    w: World, admin: APIClient
) -> None:
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    w.accept(w.r, order_id)

    riders = admin.get("/api/v1/admin/delivery-partners?online=true").json()["data"]
    assert len(riders["items"]) == 1
    assert riders["items"][0]["activeOrder"]["id"] == order_id
    assert riders["items"][0]["vehicleType"] == "motorbike"
    everyone = admin.get("/api/v1/admin/delivery-partners").json()["data"]
    assert everyone["pagination"]["total"] == 1

    url = f"/api/v1/admin/delivery-partners/{w.rider['user']['id']}/status"
    busy = admin.patch(url, {"status": "suspended"}, format="json")
    assert busy.status_code == 409

    for status in ("picked_up", "on_the_way", "delivered"):
        w.rider_set(w.r, order_id, status)
    suspend = admin.patch(url, {"status": "suspended"}, format="json")
    assert suspend.status_code == 200
    assert suspend.json()["message"] == "Rider suspended"
    assert DeliveryPartner.objects.get(user_id=w.rider["user"]["id"]).is_online is False
    assert w.dashboard(w.r).status_code == 401  # signed out
    assert admin.patch(url, {"status": "active"}, format="json").json()["message"] == (
        "Rider reactivated"
    )
    customer_url = f"/api/v1/admin/delivery-partners/{w.customer['user']['id']}/status"
    assert admin.patch(customer_url, {"status": "active"}, format="json").status_code == 404


def test_suspending_a_rider_with_an_open_offer_passes_the_offer_on(
    w: World, admin: APIClient
) -> None:
    second = w.new_rider(FARTHER)
    w.go_online(w.r, NEAR)
    order_id = w.ready_order()
    url = f"/api/v1/admin/delivery-partners/{w.rider['user']['id']}/status"
    assert admin.patch(url, {"status": "suspended"}, format="json").status_code == 200
    assert w.offer_id(second) == order_id


def test_order_admin_is_permission_checked(w: World) -> None:
    assert w.o.get("/api/v1/admin/orders").status_code == 403
    assert w.r.get("/api/v1/admin/delivery-partners").status_code == 403
    support = client_for(create_and_login("support_admin")["token"])
    assert support.get("/api/v1/admin/orders").status_code == 200  # orders:view
    order_id = w.place_order()
    assert (
        support.post(
            f"/api/v1/admin/orders/{order_id}/cancel", {"reason": "x"}, format="json"
        ).status_code
        == 403
    )  # no orders:manage
    assert support.get("/api/v1/admin/delivery-partners").status_code == 403


# --- partner dashboard figures -----------------------------------------------------------------


def test_restaurant_stats_count_received_orders_and_sales(w: World) -> None:
    empty = w.o.get("/api/v1/my/restaurant/stats").json()["data"]
    assert empty["totalOrders"] == 0
    assert empty["averageOrderPaise"] == 0

    w.go_online(w.r, NEAR)
    delivered = w.ready_order(coupon="WELCOME50")
    w.accept(w.r, delivered)
    for status in ("picked_up", "on_the_way", "delivered"):
        w.rider_set(w.r, delivered, status)
    rejected = w.place_order()
    w.restaurant_set(rejected, "rejected", "Too busy")
    w.place_order()  # still pending

    stats = w.o.get("/api/v1/my/restaurant/stats").json()["data"]
    order = Order.objects.get(pk=delivered)
    sales = order.subtotal_paise - order.discount_paise
    assert stats == {
        "totalOrders": 3,
        "todayOrders": 3,
        "pendingOrders": 1,
        "completedOrders": 1,
        "cancelledOrders": 1,
        "salesPaise": sales,
        "averageOrderPaise": sales,
        "rating": {"average": 0.0, "count": 0},
    }
    assert w.c.get("/api/v1/my/restaurant/stats").status_code == 403
