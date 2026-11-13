"""
Shared set-up for the coins tests (Node: tests/rewards-helpers.js): the seeded order World plus
an admin, sign-ups that run the after-commit registration hooks (welcome coins, referral codes),
an address for new customers and helpers that drive orders through the real API.
"""

import itertools
from typing import Any

from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts.tests.test_auth import create_and_login, register, token_of
from apps.coins import wallet
from apps.coins.models import CoinWallet
from apps.customers.models import Address
from apps.orders.models import Order
from apps.orders.tests.test_orders import NEAR, World, client_for
from common.geo import GeoPoint

_n = itertools.count(1)
FRIEND_HOME = (12.9729, 77.6412)  # (lat, lng), near the restaurant and far from the referrer
REFERRER_HOME = (12.9352, 77.6271)  # the seeded customer's address


class RewardsWorld(World):
    def __init__(self) -> None:
        super().__init__()
        self.admin = create_and_login("admin")
        self.a = client_for(self.admin["token"])

    @property
    def me(self) -> str:
        return str(self.customer["user"]["id"])

    def coins_of(self, user_id: Any) -> int:
        w = CoinWallet.objects.filter(user_id=user_id).first()
        return w.available if w else 0

    def balance(self, user_id: Any = None) -> CoinWallet:
        return CoinWallet.objects.get(user_id=user_id or self.me)

    def gift(self, coins: int, key: str = "gift", user_id: Any = None) -> Any:
        return wallet.credit(
            user_id or self.me, coins=coins, source="PROMOTIONAL_REWARD", key=key
        ).txn

    def reconciled(self, user_id: Any = None) -> None:
        assert wallet.reconcile(user_id or self.me)["issues"] == []

    def sign_up(self, referral_code: str | None = None, **overrides: Any) -> dict[str, Any]:
        """Registers through the API and runs the after-commit hooks, like a real request."""
        n = next(_n)
        body: dict[str, Any] = {"name": "Asha Rao", "email": f"friend{n}@example.com", **overrides}
        if referral_code is not None:
            body["referralCode"] = referral_code
        with TestCase.captureOnCommitCallbacks(execute=True):
            res, _ = register(APIClient(), **body)
        if res.status_code != 201:
            return {"res": res}
        user = res.json()["data"]["user"]
        return {"res": res, "user": user, "id": user["id"], "c": client_for(token_of(res))}

    def address_for(self, user_id: str, where: tuple[float, float] = FRIEND_HOME) -> str:
        address = Address.objects.filter(user_id=user_id, is_default=True).first()
        if address is None:
            address = Address.objects.create(
                user_id=user_id,
                label="home",
                recipient_name="Test Customer",
                phone="9000000099",
                line1="12 Sample Street",
                area="Koramangala",
                city="Bengaluru",
                state="Karnataka",
                postal_code="560034",
                location=GeoPoint(
                    lat=where[0], lng=where[1]
                ),
                is_default=True,
            )
        return str(address.pk)

    def place_as(
        self,
        who: dict[str, Any] | None = None,
        method: str = "cod",
        qty: int = 2,
        where: tuple[float, float] = FRIEND_HOME,
        expect: int = 201,
        fill: bool = True,
        **body: Any,
    ) -> Any:
        """Fills the cart (Butter Chicken × qty) and places it. Returns the order JSON."""
        client = who["c"] if who else self.c
        if fill:
            assert self.add(client, qty=qty).status_code == 200
        address = self.address_for(who["id"], where) if who else self.address_id()
        res = client.post(
            "/api/v1/orders",
            {"paymentMethod": method, "addressId": address, **body},
            format="json",
        )
        assert res.status_code == expect, res.json()
        return res.json()["data"]["order"] if expect == 201 else res.json()

    def deliver(self, order_id: str) -> None:
        assert self.go_online(self.r, NEAR).status_code == 200
        for status in ("confirmed", "preparing", "ready_for_pickup"):
            assert self.restaurant_set(order_id, status).status_code == 200
        assert self.accept(self.r, order_id).status_code == 200
        for status in ("picked_up", "on_the_way", "delivered"):
            assert self.rider_set(self.r, order_id, status).status_code == 200
        assert Order.objects.get(pk=order_id).status == "delivered"

    def reject(self, order_id: str) -> Any:
        return self.restaurant_set(order_id, "rejected", "Kitchen closed early")
