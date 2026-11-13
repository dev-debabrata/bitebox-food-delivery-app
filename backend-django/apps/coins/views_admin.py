"""
/admin/rewards: Coins & Rewards management (Node: routes/admin-rewards.routes.js). Reading needs
rewards:view; changing settings, campaigns, referrals or balances needs rewards:manage (the super
admin) and is audited.
"""

from typing import Any

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.audit.services import audited
from apps.rbac.roles import Permission
from common.api import ApiError, ok
from common.exceptions import flatten_validation
from common.pagination import Page
from common.permissions import permission_required
from common.schema import envelope, errors
from common.validation import parse_id, validated

from . import config, referrals, special, staff
from .serializers import (
    IDEMPOTENCY_KEY,
    AdminReferralQuery,
    AdminTransactionQuery,
    CampaignInput,
    CampaignListQuery,
    CampaignStatusInput,
    ClaimListQuery,
    DaysQuery,
    DecisionInput,
    RejectInput,
    ReverseInput,
)

VIEW = permission_required(Permission.REWARDS_VIEW)
MANAGE = permission_required(Permission.REWARDS_MANAGE)
TAGS = ["Admin: rewards"]
WRITES = ("POST", "PUT", "PATCH", "DELETE")
ADMIN_CAMPAIGN_RESULT = envelope("AdminCampaignResult")
ADMIN_COIN_TRANSACTION_RESULT = envelope("AdminCoinTransactionResult")
ADMIN_REFERRAL_RESULT = envelope("AdminReferralResult")
REWARD_CONFIGURATION_RESULT = envelope("RewardConfigurationResult")


class RewardsView(APIView):
    """Reading needs rewards:view; any change needs rewards:manage as well."""

    def get_permissions(self) -> list[Any]:
        needed = [VIEW, MANAGE] if self.request.method in WRITES else [VIEW]
        return [p() for p in needed]


class ManageView(RewardsView):
    def get_permissions(self) -> list[Any]:
        return [VIEW(), MANAGE()]


def _config_note(request: Request) -> str:
    keys = [k for k in (request.data or {}) if k != "version"]
    return (
        f"Updated reward settings: {', '.join(config.camel_path(k) for k in keys) or 'no changes'}"
    )


class ConfigurationView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_configuration_get",
        responses={200: REWARD_CONFIGURATION_RESULT, **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        return ok({"configuration": config.current()})

    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_configuration_update",
        request=OpenApiTypes.OBJECT,
        responses={200: REWARD_CONFIGURATION_RESULT, **errors(401, 403, 409, 422)},
    )
    @audited("rewards.configure", "reward_configuration", _config_note)
    def put(self, request: Request) -> Response:
        patch, version = config.parse_update(request.data)
        saved = config.update(current_user(request), patch, version)
        return ok({"configuration": saved}, message="Reward settings saved")


class CampaignsView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_campaigns_list",
        parameters=[CampaignListQuery],
        responses={200: envelope("AdminCampaignPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(CampaignListQuery, request.query_params)
        return ok(special.admin_list(query, Page.from_query(query)))

    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_campaigns_create",
        request=CampaignInput,
        responses={201: ADMIN_CAMPAIGN_RESULT, **errors(401, 403, 422)},
    )
    @audited(
        "rewards.campaign.create",
        "reward_campaign",
        lambda req: f'Created campaign "{req.data.get("name", "")}"',
    )
    def post(self, request: Request) -> Response:
        data = validated(CampaignInput, request.data)
        campaign = special.admin_create(current_user(request), data)
        request.audit_resource_id = campaign["id"]  # type: ignore[attr-defined]
        return ok({"campaign": campaign}, message="Campaign created", status=201)


def _camel_keys(request: Request) -> str:
    return ", ".join(config.camel_path(k) for k in (request.data or {}))


class CampaignView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_campaign_get",
        responses={200: envelope("AdminCampaignDetail"), **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(special.admin_get(parse_id(id)))

    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_campaign_update",
        request=CampaignInput,
        responses={200: ADMIN_CAMPAIGN_RESULT, **errors(401, 403, 404, 409, 422)},
    )
    @audited(
        "rewards.campaign.update",
        "reward_campaign",
        lambda req: f"Edited campaign: {_camel_keys(req)}",
    )
    def put(self, request: Request, id: str) -> Response:
        campaign_id = parse_id(id)
        data = validated(CampaignInput, request.data, partial=True)
        campaign = special.admin_update(current_user(request), campaign_id, data)
        return ok({"campaign": campaign}, message="Campaign saved")


class CampaignStatusView(ManageView):
    @extend_schema(
        tags=TAGS,
        request=CampaignStatusInput,
        responses={200: ADMIN_CAMPAIGN_RESULT, **errors(401, 403, 404, 409, 422)},
    )
    @audited(
        "rewards.campaign.status",
        "reward_campaign",
        lambda req: f"Campaign {req.data.get('action', '')}",
    )
    def patch(self, request: Request, id: str) -> Response:
        campaign_id = parse_id(id)
        action = validated(CampaignStatusInput, request.data)["action"]
        campaign = special.admin_set_status(current_user(request), campaign_id, action)
        return ok({"campaign": campaign}, message="Campaign updated")


class ClaimsView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_claims_list",
        parameters=[ClaimListQuery],
        responses={200: envelope("AdminRewardClaimPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(ClaimListQuery, request.query_params)
        return ok(special.admin_claims(query, Page.from_query(query)))


class TransactionsView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_transactions_list",
        parameters=[AdminTransactionQuery],
        responses={200: envelope("AdminCoinTransactionPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminTransactionQuery, request.query_params)
        return ok(staff.list_transactions(query, Page.from_query(query)))


class TransactionView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_transaction_get",
        responses={200: ADMIN_COIN_TRANSACTION_RESULT, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(staff.get_transaction(parse_id(id)))


def _reverse_note(request: Request) -> str:
    coins = request.data.get("coins")
    amount = coins if coins is not None else "all remaining"
    return f"Reversed {amount} coins: {request.data.get('reason', '')}"


class ReverseView(ManageView):
    @extend_schema(
        tags=TAGS,
        request=ReverseInput,
        parameters=[
            OpenApiParameter(
                "Idempotency-Key",
                str,
                OpenApiParameter.HEADER,
                required=True,
                description="8-100 letters, digits, - or _; a repeat returns the same reversal",
            )
        ],
        responses={200: ADMIN_COIN_TRANSACTION_RESULT, **errors(401, 403, 404, 409, 422)},
    )
    @audited("rewards.reverse", "coin_transaction", _reverse_note)
    def post(self, request: Request, id: str) -> Response:
        txn_id = parse_id(id)
        key = request.headers.get("Idempotency-Key", "")
        details = []
        if not IDEMPOTENCY_KEY.match(key):
            details.append(
                {
                    "field": "idempotency-key",
                    "message": "Send an Idempotency-Key header (8-100 letters, digits, - or _)",
                }
            )
        body = ReverseInput(data=request.data)
        if not body.is_valid():
            details.extend(flatten_validation(body.errors))
        if details:
            raise ApiError(422, "Validation failed", code="VALIDATION_ERROR", details=details)
        data = dict(body.validated_data)
        result = staff.reverse_transaction(current_user(request), txn_id, data, key)
        return ok(result, message="Reward reversed")


class WalletView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_wallet_get",
        responses={200: envelope("AdminWalletDetail"), **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(staff.wallet_detail(parse_id(id)))


class ReportsView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_reports",
        parameters=[DaysQuery],
        responses={200: envelope("RewardsReport"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days") or 30
        return ok(staff.reports(days))


class ReferralsView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_referrals_list",
        parameters=[AdminReferralQuery],
        responses={200: envelope("AdminReferralPage"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminReferralQuery, request.query_params)
        return ok(referrals.admin_list(query, Page.from_query(query)))


class ReferralView(RewardsView):
    @extend_schema(
        tags=TAGS,
        operation_id="admin_rewards_referral_get",
        responses={200: ADMIN_REFERRAL_RESULT, **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok({"referral": referrals.admin_get(parse_id(id))})


def _approve_note(request: Request) -> str:
    note = str(request.data.get("note") or "").strip()
    return ": ".join(p for p in ("Approved a held referral", note) if p)


class ReferralApproveView(ManageView):
    @extend_schema(
        tags=TAGS,
        request=DecisionInput,
        responses={200: ADMIN_REFERRAL_RESULT, **errors(401, 403, 404, 409, 422)},
    )
    @audited("rewards.referral.approve", "referral", _approve_note)
    def post(self, request: Request, id: str) -> Response:
        referral_id = parse_id(id)
        note = validated(DecisionInput, request.data).get("note")
        referral = referrals.approve(current_user(request), referral_id, note)
        return ok({"referral": referral}, message="Referral approved")


class ReferralRejectView(ManageView):
    @extend_schema(
        tags=TAGS,
        request=RejectInput,
        responses={200: ADMIN_REFERRAL_RESULT, **errors(401, 403, 404, 409, 422)},
    )
    @audited(
        "rewards.referral.reject",
        "referral",
        lambda req: f"Rejected a referral: {str(req.data.get('note', '')).strip()}",
    )
    def post(self, request: Request, id: str) -> Response:
        referral_id = parse_id(id)
        note = validated(RejectInput, request.data)["note"]
        referral = referrals.reject(current_user(request), referral_id, note)
        return ok({"referral": referral}, message="Referral rejected")
