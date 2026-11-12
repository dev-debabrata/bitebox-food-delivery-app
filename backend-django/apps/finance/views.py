"""Earnings for the restaurant panel (the rider's arrives with the delivery partner phase)."""

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.rbac.roles import Permission, Role
from common.api import ok
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.validation import validated

from . import reports


class DaysQuery(serializers.Serializer):
    days = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=365,
        error_messages=dict.fromkeys(("invalid", "min_value", "max_value"), "Invalid value"),
    )


class RestaurantEarningsView(APIView):
    permission_classes = [role_required(Role.RESTAURANT)]

    @extend_schema(
        tags=["My restaurant"],
        parameters=[DaysQuery],
        responses={200: envelope("Earnings"), **errors(401, 403, 404, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(reports.restaurant_earnings(current_user(request), days))


class AdminReportsView(APIView):
    permission_classes = [permission_required(Permission.FINANCE_VIEW)]

    @extend_schema(
        tags=["Admin: reports"],
        parameters=[DaysQuery],
        responses={200: envelope("AdminReport"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(reports.admin_report(days))
