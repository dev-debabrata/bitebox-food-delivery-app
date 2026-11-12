"""/admin/operations/* (operations:view) and /admin/dashboard (any admin role)."""

from drf_spectacular.utils import extend_schema
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.finance.views import DaysQuery
from apps.rbac.roles import ADMIN_ROLES, Permission, has_permission
from common.api import ok
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.validation import validated

from . import operations

OPS: list[type[BasePermission]] = [permission_required(Permission.OPERATIONS_VIEW)]


class OperationsDashboardView(APIView):
    permission_classes = OPS

    @extend_schema(
        tags=["Admin: operations"],
        parameters=[DaysQuery],
        responses={200: envelope("OperationsDashboard"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(operations.dashboard(days))


class OperationsMonitoringView(APIView):
    permission_classes = OPS

    @extend_schema(
        tags=["Admin: operations"], responses={200: envelope("LiveOrders"), **errors(401, 403)}
    )
    def get(self, request: Request) -> Response:
        return ok(operations.monitoring())


class OperationsRestaurantsView(APIView):
    permission_classes = OPS

    @extend_schema(
        tags=["Admin: operations"],
        responses={200: envelope("RestaurantAvailability"), **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        return ok(operations.restaurant_availability())


class OperationsPerformanceView(APIView):
    permission_classes = OPS

    @extend_schema(
        tags=["Admin: operations"],
        parameters=[DaysQuery],
        responses={200: envelope("DeliveryPerformance"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(operations.delivery_performance(days))


class AdminDashboardView(APIView):
    """Every admin role sees the counts; money figures need finance:view."""

    permission_classes = [role_required(*ADMIN_ROLES)]

    @extend_schema(
        tags=["Admin: dashboard"],
        responses={200: envelope("AdminDashboard"), **errors(401, 403)},
    )
    def get(self, request: Request) -> Response:
        user = current_user(request)
        return ok(
            operations.platform_summary(
                include_money=has_permission(user.role, Permission.FINANCE_VIEW)
            )
        )
