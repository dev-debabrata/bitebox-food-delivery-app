"""
Port of the Node API's tests/coin-wallet.test.js and tests/reward-config.test.js: the coin ledger
(credits, holds, FIFO spending, expiry, reversals, integrity) and the reward settings.

Node runs some cases with concurrent promises; here wallet operations lock the wallet row, so
the same requests are sent one after the other and the outcome must be the same.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from apps.coins import config as reward_config
from apps.coins import wallet
from apps.coins.models import CoinBatch, CoinTransaction, CoinWallet, LedgerImmutable
from apps.coins.quote import coins_to_paise, get_reward_config
from apps.rbac.roles import Permission, Role, has_permission
from common.api import ApiError
from common.pagination import Page
from tests import factories

pytestmark = pytest.mark.django_db

NOW = datetime(2026, 11, 5, 6, 0, tzinfo=UTC)


def at(days: float) -> datetime:
    return NOW + timedelta(days=days)


def bal(user: Any) -> CoinWallet:
    return CoinWallet.objects.get(user=user)


def live(user: Any) -> list[tuple[str, int]]:
    return sorted(
        CoinBatch.objects.filter(wallet__user=user, remaining__gt=0).values_list(
            "source", "remaining"
        )
    )


def reconciled(user: Any) -> None:
    assert wallet.reconcile(user.pk)["issues"] == []


def code_of(call: Any) -> str | None:
    try:
        call()
    except ApiError as error:
        return error.code
    return None


@pytest.fixture
def user() -> Any:
    return factories.user()


def earn(user: Any, coins: Any, key: str, **extra: Any) -> wallet.Result:
    extra.setdefault("now", NOW)
    return wallet.credit(user.pk, coins=coins, source="ORDER_REWARD", key=key, **extra)


def page() -> Page:
    return Page(page=1, limit=10)


# --- credits ------------------------------------------------------------------------------------


def test_creates_the_wallet_a_batch_and_a_posted_ledger_row(user: Any) -> None:
    result = earn(user, 120, "order-reward:A")
    txn = result.row()
    assert result.created is True
    assert (txn.type, txn.status, txn.seq) == ("CREDIT", "posted", 1)
    assert (txn.available_before, txn.available_after) == (0, 120)
    assert txn.expires_at == at(180)  # the default for order rewards
    w = bal(user)
    assert (w.available, w.total_earned) == (120, 120)
    assert live(user) == [("ORDER_REWARD", 120)]
    reconciled(user)


def test_never_credits_the_same_key_twice(user: Any) -> None:
    results = [earn(user, 50, "order-reward:dup") for _ in range(8)]
    assert sum(r.created for r in results) == 1
    assert len({r.row().pk for r in results}) == 1
    assert bal(user).available == 50
    assert CoinTransaction.objects.filter(user=user).count() == 1


def test_rejects_zero_negative_and_fractional_amounts(user: Any) -> None:
    for coins in (0, -5, 1.5):
        assert code_of(lambda c=coins: earn(user, c, f"bad:{c}")) == "VALIDATION_ERROR"
    assert CoinTransaction.objects.count() == 0


# --- reserve, commit, release -------------------------------------------------------------------


def test_reserve_then_commit_moves_coins_to_redeemed(user: Any) -> None:
    earn(user, 300, "c1")
    wallet.reserve(user.pk, coins=100, key="reserve:o1", now=NOW)
    w = bal(user)
    assert (w.available, w.reserved) == (200, 100)
    wallet.commit_reservation(user.pk, reserve_key="reserve:o1")
    w = bal(user)
    assert (w.available, w.reserved, w.total_redeemed) == (200, 0, 100)
    assert wallet.commit_reservation(user.pk, reserve_key="reserve:o1").created is False
    assert bal(user).total_redeemed == 100
    reconciled(user)


def test_cannot_reserve_more_than_the_balance_and_writes_nothing(user: Any) -> None:
    earn(user, 80, "c1")
    assert code_of(lambda: wallet.reserve(user.pk, coins=100, key="r:big")) == "INSUFFICIENT_COINS"
    assert CoinTransaction.objects.filter(user=user).count() == 1
    assert bal(user).available == 80


def test_releases_a_reservation_back_exactly_once(user: Any) -> None:
    earn(user, 100, "c1")
    wallet.reserve(user.pk, coins=60, key="reserve:o2", now=NOW)
    wallet.release_reservation(user.pk, reserve_key="reserve:o2", now=NOW)
    wallet.release_reservation(user.pk, reserve_key="reserve:o2", now=NOW)
    w = bal(user)
    assert (w.available, w.reserved, w.total_redeemed) == (100, 0, 0)
    reconciled(user)


def test_never_both_commits_and_releases_the_same_reservation(user: Any) -> None:
    earn(user, 100, "c1")
    wallet.reserve(user.pk, coins=40, key="reserve:race")
    codes = [
        code_of(lambda: wallet.commit_reservation(user.pk, reserve_key="reserve:race")),
        code_of(lambda: wallet.release_reservation(user.pk, reserve_key="reserve:race")),
        code_of(lambda: wallet.commit_reservation(user.pk, reserve_key="reserve:race")),
        code_of(lambda: wallet.release_reservation(user.pk, reserve_key="reserve:race")),
    ]
    assert codes == [None, "RESERVATION_CLOSED", None, "RESERVATION_CLOSED"]
    assert CoinTransaction.objects.filter(type__in=["DEBIT", "RELEASE"]).count() == 1
    w = bal(user)
    assert w.reserved == 0
    assert w.available + w.total_redeemed == 100
    reconciled(user)


def test_refunds_coins_spent_on_an_order_that_was_then_cancelled(user: Any) -> None:
    earn(user, 100, "c1")
    wallet.reserve(user.pk, coins=100, key="reserve:o3")
    assert (
        code_of(lambda: wallet.refund_redemption(user.pk, reserve_key="reserve:o3"))
        == "NOT_REDEEMED"
    )
    wallet.commit_reservation(user.pk, reserve_key="reserve:o3")
    wallet.refund_redemption(user.pk, reserve_key="reserve:o3")
    wallet.refund_redemption(user.pk, reserve_key="reserve:o3")
    w = bal(user)
    assert (w.available, w.total_redeemed) == (100, 0)
    reconciled(user)


def test_keeps_the_balance_right_over_many_redemptions(user: Any) -> None:
    earn(user, 100, "c1")
    codes = [code_of(lambda i=i: wallet.reserve(user.pk, coins=30, key=f"r:p{i}")) for i in range(12)]
    assert codes.count(None) == 3
    assert set(codes) - {None} == {"INSUFFICIENT_COINS"}
    w = bal(user)
    assert (w.available, w.reserved) == (10, 90)
    reconciled(user)


def test_keeps_the_balance_right_over_mixed_operations(user: Any) -> None:
    earn(user, 500, "seed")
    for i in range(5):
        earn(user, 10, f"mix-credit:{i}")
        wallet.reserve(user.pk, coins=20, key=f"mix-reserve:{i}")
    for i in range(5):
        if i % 2:
            wallet.commit_reservation(user.pk, reserve_key=f"mix-reserve:{i}")
        else:
            wallet.release_reservation(user.pk, reserve_key=f"mix-reserve:{i}")
    w = bal(user)
    assert (w.total_earned, w.total_redeemed, w.available, w.reserved) == (550, 40, 510, 0)
    reconciled(user)


# --- FIFO and expiry ----------------------------------------------------------------------------


def test_spends_coins_that_expire_first_and_never_expiring_coins_last(user: Any) -> None:
    wallet.credit(user.pk, coins=50, source="WELCOME_REWARD", key="never", expires_at=None, now=NOW)
    wallet.credit(user.pk, coins=30, source="ORDER_REWARD", key="late", expires_at=at(90), now=NOW)
    wallet.credit(user.pk, coins=40, source="REVIEW_REWARD", key="early", expires_at=at(10), now=NOW)
    txn = wallet.reserve(user.pk, coins=60, key="reserve:fifo", now=NOW).row()
    assert [(a.source, a.coins) for a in txn.allocations.order_by("expires_at")] == [
        ("REVIEW_REWARD", 40),
        ("ORDER_REWARD", 20),
    ]
    assert live(user) == [("ORDER_REWARD", 10), ("WELCOME_REWARD", 50)]
    reconciled(user)


def test_expires_overdue_batches_once_and_only_what_is_left(user: Any) -> None:
    wallet.credit(user.pk, coins=100, source="ORDER_REWARD", key="old", expires_at=at(5), now=NOW)
    wallet.credit(user.pk, coins=70, source="ORDER_REWARD", key="new", expires_at=at(60), now=NOW)
    # 30 of the expiring batch are spent first, so only 70 can expire.
    wallet.reserve(user.pk, coins=30, key="reserve:e", now=NOW)
    wallet.commit_reservation(user.pk, reserve_key="reserve:e")
    assert wallet.expire_due_coins(now=at(6)) == {"wallets": 1, "batches": 1, "coins": 70}
    assert wallet.expire_due_coins(now=at(6)) == {"wallets": 0, "batches": 0, "coins": 0}
    w = bal(user)
    assert (w.available, w.total_expired, w.total_redeemed) == (70, 70, 30)
    assert CoinTransaction.objects.filter(type="EXPIRE").count() == 1
    reconciled(user)


def test_coins_past_expiry_cannot_be_spent_before_the_sweep(user: Any) -> None:
    wallet.credit(user.pk, coins=100, source="ORDER_REWARD", key="old", expires_at=at(1), now=NOW)
    assert (
        code_of(lambda: wallet.reserve(user.pk, coins=50, key="r:late", now=at(2)))
        == "INSUFFICIENT_COINS"
    )
    assert wallet.wallet_summary(user.pk, now=at(2))["available"] == 0


def test_does_not_expire_coins_while_expiry_is_off(user: Any) -> None:
    wallet.credit(user.pk, coins=100, source="ORDER_REWARD", key="old", expires_at=at(1), now=NOW)
    reward_config.update(None, {"expiry": {"enabled": False}})
    assert wallet.expire_due_coins(now=at(3))["coins"] == 0
    wallet.reserve(user.pk, coins=100, key="r:off", now=at(3))
    assert bal(user).reserved == 100


def test_released_coins_get_at_least_the_grace_period(user: Any) -> None:
    wallet.credit(user.pk, coins=100, source="ORDER_REWARD", key="c", expires_at=at(2), now=NOW)
    wallet.reserve(user.pk, coins=100, key="reserve:g", now=NOW)
    wallet.release_reservation(user.pk, reserve_key="reserve:g", now=at(1))
    batch = CoinBatch.objects.get(wallet__user=user, remaining__gt=0)
    assert batch.expires_at == at(1 + 7)  # restore_grace_days = 7
    # A held coin did not expire while it was held.
    assert wallet.expire_due_coins(now=at(3))["coins"] == 0
    reconciled(user)


def test_assigns_expiry_per_source_from_the_settings(user: Any) -> None:
    reward_config.update(None, {"expiry": {"days": {"REVIEW_REWARD": 30, "BIRTHDAY_REWARD": 0}}})
    review = wallet.credit(user.pk, coins=5, source="REVIEW_REWARD", key="r", now=NOW).row()
    birthday = wallet.credit(user.pk, coins=100, source="BIRTHDAY_REWARD", key="b", now=NOW).row()
    assert review.expires_at == at(30)
    assert birthday.expires_at is None


# --- reversals ----------------------------------------------------------------------------------


def test_reverses_part_then_the_rest_and_never_more(user: Any) -> None:
    earn(user, 100, "order-reward:R")
    wallet.reverse_credit(user.pk, credit_key="order-reward:R", coins=40, key="rev:1")
    too_much = code_of(
        lambda: wallet.reverse_credit(user.pk, credit_key="order-reward:R", coins=70, key="rev:2")
    )
    assert too_much == "REVERSAL_TOO_LARGE"
    rest = wallet.reverse_credit(user.pk, credit_key="order-reward:R", key="rev:3")
    assert rest.row().coins == 60
    again = code_of(lambda: wallet.reverse_credit(user.pk, credit_key="order-reward:R", key="rev:4"))
    assert again == "ALREADY_REVERSED"
    replay = wallet.reverse_credit(user.pk, credit_key="order-reward:R", coins=40, key="rev:1")
    assert replay.created is False
    w = bal(user)
    assert (w.available, w.total_reversed) == (0, 100)
    reconciled(user)


def test_records_a_shortfall_when_the_coins_were_spent(user: Any) -> None:
    earn(user, 100, "order-reward:S")
    wallet.reserve(user.pk, coins=80, key="reserve:s")
    wallet.commit_reservation(user.pk, reserve_key="reserve:s")
    txn = wallet.reverse_credit(user.pk, credit_key="order-reward:S", key="rev:s").row()
    assert (txn.requested_coins, txn.coins, txn.shortfall) == (100, 20, 80)
    w = bal(user)
    assert (w.available, w.uncollected_reversal) == (0, 80)
    reconciled(user)


def test_takes_reversed_coins_from_the_rewards_own_batch_first(user: Any) -> None:
    wallet.credit(user.pk, coins=50, source="WELCOME_REWARD", key="w", expires_at=at(5), now=NOW)
    earn(user, 50, "order-reward:T", expires_at=at(100))
    txn = wallet.reverse_credit(user.pk, credit_key="order-reward:T", coins=30, key="rev:t").row()
    assert [a.source for a in txn.allocations.all()] == ["ORDER_REWARD"]


# --- integrity ----------------------------------------------------------------------------------


def test_refuses_to_edit_or_delete_ledger_rows(user: Any) -> None:
    txn = earn(user, 10, "c1").row()
    with pytest.raises(LedgerImmutable):
        CoinTransaction.objects.filter(pk=txn.pk).update(coins=9999)
    with pytest.raises(LedgerImmutable):
        CoinTransaction.objects.filter(pk=txn.pk).delete()
    with pytest.raises(LedgerImmutable):
        CoinTransaction.objects.all().delete()
    row = CoinTransaction.objects.get(pk=txn.pk)
    row.coins = 5000
    with pytest.raises(LedgerImmutable):
        row.save()
    with pytest.raises(LedgerImmutable):
        row.delete()
    assert CoinTransaction.objects.get(pk=txn.pk).coins == 10


def test_keeps_one_wallet_per_user_and_a_gap_free_sequence(user: Any) -> None:
    for i in range(6):
        earn(user, 5, f"par:{i}")
    assert CoinWallet.objects.filter(user=user).count() == 1
    seqs = list(CoinTransaction.objects.filter(user=user).order_by("seq").values_list("seq", flat=True))
    assert seqs == [1, 2, 3, 4, 5, 6]


def test_keeps_wallets_separate_between_customers(user: Any) -> None:
    other = factories.user()
    earn(user, 100, "mine")
    wallet.credit(other.pk, coins=5, source="ORDER_REWARD", key="theirs")
    assert code_of(lambda: wallet.reserve(other.pk, coins=50, key="r:other")) == "INSUFFICIENT_COINS"
    wallet.reserve(user.pk, coins=50, key="reserve:mine")
    # Another customer cannot settle my reservation, even with my key.
    assert code_of(lambda: wallet.commit_reservation(other.pk, reserve_key="reserve:mine")) == (
        "NOT_FOUND"
    )
    # An idempotency key used by one wallet cannot be replayed by another.
    with pytest.raises(RuntimeError, match="belongs to another wallet"):
        wallet.credit(other.pk, coins=1, source="ORDER_REWARD", key="mine")
    assert len(wallet.list_transactions(other.pk, {}, page())["items"]) == 1


def test_a_failed_operation_leaves_nothing_behind(user: Any) -> None:
    """The row, the batches and the wallet are written in one transaction (Node: aborts)."""
    earn(user, 100, "c1")
    with pytest.raises(RuntimeError, match="order creation failed"):
        from django.db import transaction

        with transaction.atomic():
            wallet.reserve(user.pk, coins=60, key="reserve:tx-abort")
            raise RuntimeError("order creation failed")
    assert not CoinTransaction.objects.filter(idempotency_key="reserve:tx-abort").exists()
    assert bal(user).available == 100
    reconciled(user)


def test_reconcile_spots_a_wallet_that_drifted_from_its_ledger(user: Any) -> None:
    earn(user, 100, "c1")
    CoinWallet.objects.filter(user=user).update(available=150)
    issues = wallet.reconcile(user.pk)["issues"]
    assert any(i.startswith("available: wallet 150, ledger 100") for i in issues)


# --- reading ------------------------------------------------------------------------------------


def test_summarises_balances_rupee_value_and_upcoming_expiry(user: Any) -> None:
    earn(user, 200, "a", expires_at=at(10))
    earn(user, 1050, "b", expires_at=at(100))
    wallet.reserve(user.pk, coins=100, key="reserve:r", now=NOW)
    s = wallet.wallet_summary(user.pk, now=NOW)
    assert (s["available"], s["reserved"]) == (1150, 100)
    assert s["value_paise"] == 11_500  # 100 coins = ₹10
    assert s["expiring"]["coins"] == 100  # 100 of the 10-day batch; the rest is beyond 30 days
    assert s["expiring"]["next"]["coins"] == 100
    assert len(s["expiring"]["upcoming"]) == 2


def test_lists_the_customers_ledger_newest_first_without_staff_fields(user: Any) -> None:
    earn(user, 100, "a")
    wallet.reserve(user.pk, coins=40, key="reserve:l")
    wallet.reverse_credit(user.pk, credit_key="a", coins=10, key="rev:l", note="staff only")
    result = wallet.list_transactions(user.pk, {}, page())
    assert [r["type"] for r in result["items"]] == ["REVERSAL", "RESERVE", "CREDIT"]
    assert (result["items"][1]["available_change"], result["items"][1]["reserved_change"]) == (
        -40,
        40,
    )
    assert "note" not in result["items"][0]
    assert "created_by" not in result["items"][0]
    assert result["pagination"]["total"] == 3
    assert len(wallet.list_transactions(user.pk, {"type": "CREDIT"}, page())["items"]) == 1


# --- reward settings (Node: reward-config.test.js) ----------------------------------------------


def test_reads_the_defaults_when_nothing_is_stored() -> None:
    current = reward_config.current()
    assert current["version"] == 0
    assert current["coins_enabled"] is True
    assert current["earning"]["order"]["coins_per_unit"] == 10
    assert current["redemption"]["payment_methods"] == ["cod", "online"]
    assert current["expiry"]["days"]["ORDER_REWARD"] == 180
    assert current["updated_by"] is None
    assert "updated_at" not in current


def test_saves_a_partial_change_keeps_the_rest_and_bumps_the_version() -> None:
    admin = factories.user(Role.ADMIN)
    saved = reward_config.update(
        admin,
        {"redemption": {"min_coins": 50, "payment_methods": ["online"]}, "birthday": {"coins": 150}},
        0,
    )
    assert saved["version"] == 1
    assert saved["redemption"]["min_coins"] == 50
    assert saved["redemption"]["payment_methods"] == ["online"]
    assert saved["redemption"]["max_coins_per_order"] == 2000
    assert saved["birthday"]["coins"] == 150
    assert saved["updated_by"] == str(admin.pk)
    assert get_reward_config()["birthday"]["coins"] == 150


def test_refuses_to_overwrite_a_newer_version() -> None:
    reward_config.update(None, {"birthday": {"coins": 120}}, 0)
    stale = code_of(lambda: reward_config.update(None, {"birthday": {"coins": 130}}, 0))
    assert stale == "CONFIG_CHANGED"
    assert get_reward_config()["birthday"]["coins"] == 120


@pytest.mark.parametrize(
    "patch",
    [
        {"redemption": {"min_coins": 5000, "max_coins_per_order": 100}},
        {"redemption": {"max_percent_of_order": 150}},
        {"earning": {"order": {"coins_per_unit": 2.5}}},
        {"earning": {"review": {"coins": -1}}},
        {"expiry": {"days": {"ORDER_REWARD": 99999}}},
        {"redemption": {"payment_methods": ["wallet"]}},
        {"timezone": "Mars/Olympus"},
        {"welcome": {"trigger": "sometimes"}},
        {"birthday": {"coins": "lots"}},
    ],
)
def test_validates_values_and_ranges(patch: dict[str, Any]) -> None:
    assert code_of(lambda: reward_config.update(None, patch)) == "VALIDATION_ERROR"
    assert not reward_config.RewardConfiguration.objects.exists()


def test_ignores_unknown_and_protected_fields() -> None:
    saved = reward_config.update(
        None,
        {"something_else": True, "key": "other", "version": 99, "redemption": {"secret": 1, "min_coins": 120}},
    )
    assert saved["redemption"]["min_coins"] == 120
    assert "something_else" not in saved
    assert reward_config.RewardConfiguration.objects.get().key == "global"


def test_converts_coins_to_paise_and_works_out_expiry_dates() -> None:
    config = get_reward_config()
    assert coins_to_paise(100, config) == 1000
    assert coins_to_paise(15, config) == 150
    assert coins_to_paise(1, {"redemption": {"coin_value_coins": 3, "coin_value_paise": 100}}) == 33
    now = datetime(2026, 11, 5, tzinfo=UTC)
    assert reward_config.expiry_for("ORDER_REWARD", config, now) == datetime(2027, 5, 4, tzinfo=UTC)
    assert reward_config.expiry_for("ORDER_REWARD", {"expiry": {"enabled": False}}, now) is None
    off = {"expiry": {"enabled": True, "days": {"ORDER_REWARD": 0}}}
    assert reward_config.expiry_for("ORDER_REWARD", off, now) is None
    soon = datetime(2026, 11, 6, tzinfo=UTC)
    assert reward_config.restored_expiry(soon, config, now) == datetime(2026, 11, 12, tzinfo=UTC)
    later = datetime(2027, 1, 1, tzinfo=UTC)
    assert reward_config.restored_expiry(later, config, now) == later
    assert reward_config.restored_expiry(None, config, now) is None


def test_gives_reward_management_to_the_super_admin_only() -> None:
    assert has_permission(Role.ADMIN, Permission.REWARDS_MANAGE)
    assert has_permission(Role.ADMIN, Permission.REWARDS_VIEW)
    for role in (Role.OPERATIONS_ADMIN, Role.FINANCE_ADMIN, Role.SUPPORT_ADMIN, Role.CUSTOMER):
        assert not has_permission(role, Permission.REWARDS_MANAGE)
