"""
/coins (the signed-in customer's own wallet, read-only), /referrals (refer & earn) and /rewards
(birthday, welcome and campaigns). Node: routes/coins.routes.js, referral.routes.js and
rewards.routes.js. Balances change only through orders, reviews, referrals and campaigns on the
server, never by a client request.
"""

from drf_spectacular.utils import extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.rbac.roles import Role
from common.api import ok
from common.pagination import Page
from common.permissions import PUBLIC, role_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import parse_id, validated

from . import orders, referrals, special, wallet
from .quote import get_reward_config
from .serializers import (
    BirthdayInput,
    CoinTransactionQuery,
    ReferralCodeInput,
    ReferralHistoryQuery,
    RewardHistoryQuery,
)

CUSTOMER = [role_required(Role.CUSTOMER)]
ReferralLimit = rate_limit("REFERRAL_RATE_LIMIT", "Too many attempts. Try again later.")


class CoinWalletView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Coins"],
        operation_id="coins_wallet_get",
        responses={200: envelope("CoinWalletResult"), **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        user = current_user(request)
        return ok(
            {
                "wallet": wallet.wallet_summary(user.pk),
                "rules": orders.customer_rules(get_reward_config()),
            }
        )


class CoinTransactionsView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Coins"],
        operation_id="coins_transactions_list",
        parameters=[CoinTransactionQuery],
        responses={200: envelope("CoinTransactionPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(CoinTransactionQuery, request.query_params)
        return ok(wallet.list_transactions(current_user(request).pk, query, Page.from_query(query)))


class ReferralValidateView(APIView):
    """Public (the sign-up form), so code guessing is slowed down."""

    permission_classes = PUBLIC
    throttle_classes = [ReferralLimit]

    @extend_schema(
        tags=["Referrals"],
        request=ReferralCodeInput,
        responses={200: envelope("ReferralCodeCheck"), **errors(422, 429)},
    )
    def post(self, request: Request) -> Response:
        data = validated(ReferralCodeInput, request.data)
        return ok(referrals.validate_code(data["code"]))


class MyReferralView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Referrals"],
        operation_id="referrals_me_get",
        responses={200: envelope("MyReferral"), **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        return ok(referrals.my_referral(current_user(request).pk))


class MyReferralHistoryView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Referrals"],
        operation_id="referrals_me_history_list",
        parameters=[ReferralHistoryQuery],
        responses={200: envelope("ReferralHistoryPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(ReferralHistoryQuery, request.query_params)
        return ok(
            referrals.my_referral_history(current_user(request).pk, query, Page.from_query(query))
        )


class RewardsOverviewView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Rewards"],
        operation_id="rewards_overview",
        responses={200: envelope("RewardsOverview"), **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        return ok(special.overview(current_user(request).pk))


class RewardCampaignsView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Rewards"],
        operation_id="rewards_campaigns_list",
        responses={200: envelope("CustomerCampaigns"), **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        return ok(special.customer_campaigns(current_user(request).pk))


class RewardClaimView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Rewards"],
        request=None,
        responses={201: envelope("RewardClaimResult"), **errors(401, 403, 404, 409, 422)},
    )
    def post(self, request: Request, id: str) -> Response:
        campaign_id = parse_id(id)
        result = special.claim(current_user(request).pk, campaign_id)
        return ok(result, message="Reward claimed", status=201)


class RewardHistoryView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Rewards"],
        operation_id="rewards_history_list",
        parameters=[RewardHistoryQuery],
        responses={200: envelope("RewardHistoryPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(RewardHistoryQuery, request.query_params)
        return ok(special.history(current_user(request).pk, query, Page.from_query(query)))


class BirthdayView(APIView):
    permission_classes = CUSTOMER

    @extend_schema(
        tags=["Rewards"],
        request=BirthdayInput,
        responses={200: envelope("BirthdayResult"), **errors(401, 403, 409, 422)},
    )
    def put(self, request: Request) -> Response:
        data = validated(BirthdayInput, request.data)
        result = special.set_birth_date(current_user(request).pk, data["birth_date"])
        return ok(result, message="Birthday saved")
