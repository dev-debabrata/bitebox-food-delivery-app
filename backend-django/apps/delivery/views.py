"""
/delivery (riders) and /admin/delivery-partners. Rider actions answer with the fresh dashboard
(profile, offer, active order) so the app needs no second request.
"""

from typing import Any

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from apps.accounts.models import UserStatus
from apps.accounts.serializers import user_json
from apps.audit.services import audited
from apps.dispatch import services as dispatch
from apps.finance import reports
from apps.finance.views import DaysQuery
from apps.orders import services as orders
from apps.orders.views import STATUS_MESSAGE
from apps.rbac.roles import Permission, Role
from apps.restaurants.serializers import RestaurantAddressInput
from apps.reviews import services as review_services
from common.api import ok
from common.fields import QueryBoolean
from common.pagination import Page
from common.permissions import permission_required, role_required
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import PageQuery, parse_id, validated

from . import services
from .models import VehicleType, VerificationStatus

RIDER = [role_required(Role.DELIVERY)]
DASHBOARD = envelope("RiderDashboard")
RESULT = envelope("RiderResult")


def _coordinate(limit: float, message: str, **kwargs: Any) -> serializers.FloatField:
    keys = ("min_value", "max_value", "invalid", "required", "null")
    return serializers.FloatField(
        min_value=-limit, max_value=limit, error_messages=dict.fromkeys(keys, message), **kwargs
    )


class VehicleInput(serializers.Serializer):
    vehicle_type = serializers.ChoiceField(
        choices=VehicleType.values,
        error_messages=dict.fromkeys(
            ("invalid_choice", "required", "null", "blank"),
            f"Vehicle must be one of: {', '.join(VehicleType.values)}",
        ),
    )
    vehicle_number = serializers.RegexField(
        r"^[A-Za-z0-9 -]{4,20}$",
        required=False,
        allow_blank=True,
        allow_null=True,
        error_messages={"invalid": "Enter a valid vehicle number"},
    )


class RiderAvailabilityInput(serializers.Serializer):
    is_online = serializers.BooleanField(
        error_messages=dict.fromkeys(
            ("invalid", "required", "null"), "isOnline must be true or false"
        )
    )
    latitude = _coordinate(90, "Invalid latitude", required=False)
    longitude = _coordinate(180, "Invalid longitude", required=False)


class RiderLocationInput(serializers.Serializer):
    latitude = _coordinate(90, "Invalid latitude")
    longitude = _coordinate(180, "Invalid longitude")


class RiderStatusInput(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=list(orders.RIDER_STATUSES),
        error_messages=dict.fromkeys(
            ("invalid_choice", "required", "null", "blank"),
            "Status must be arrived_at_restaurant, picked_up, on_the_way or delivered",
        ),
    )
    # The customer's delivery code, needed with "delivered".
    otp = serializers.RegexField(
        r"^\d{4}$",
        required=False,
        allow_blank=True,
        error_messages=dict.fromkeys(("invalid", "blank"), "Enter the 4-digit code"),
    )


class DashboardView(APIView):
    permission_classes = RIDER

    @extend_schema(tags=["Delivery"], responses={200: DASHBOARD, **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok(services.dashboard(current_user(request)))


class VehicleView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"], request=VehicleInput, responses={200: RESULT, **errors(401, 403, 422)}
    )
    def put(self, request: Request) -> Response:
        data = validated(VehicleInput, request.data)
        profile = services.update_vehicle(
            current_user(request), data["vehicle_type"], data.get("vehicle_number")
        )
        return ok({"profile": profile}, message="Vehicle saved")


class AvailabilityView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"],
        request=RiderAvailabilityInput,
        responses={200: DASHBOARD, **errors(400, 401, 403, 409, 422)},
    )
    def patch(self, request: Request) -> Response:
        data = validated(RiderAvailabilityInput, request.data)
        result = services.set_availability(
            current_user(request), data["is_online"], data.get("latitude"), data.get("longitude")
        )
        return ok(result, message="You are online" if data["is_online"] else "You are offline")


class LocationView(APIView):
    permission_classes = RIDER
    throttle_classes = [rate_limit("LOCATION_RATE_LIMIT", "Location updates are too frequent")]

    @extend_schema(
        tags=["Delivery"],
        request=RiderLocationInput,
        responses={200: RESULT, **errors(401, 403, 409, 422, 429)},
    )
    def put(self, request: Request) -> Response:
        data = validated(RiderLocationInput, request.data)
        return ok(
            services.update_location(current_user(request), data["latitude"], data["longitude"])
        )


class OfferAcceptView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"],
        request=None,
        responses={200: DASHBOARD, **errors(401, 403, 404, 409, 422)},
    )
    def post(self, request: Request, id: str) -> Response:
        user = current_user(request)
        dispatch.accept_offer(user, parse_id(id))
        return ok(services.dashboard(user), message="Delivery accepted. Head to the restaurant.")


class OfferDeclineView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"], request=None, responses={200: DASHBOARD, **errors(401, 403, 409, 422)}
    )
    def post(self, request: Request, id: str) -> Response:
        user = current_user(request)
        dispatch.decline_offer(user.pk, parse_id(id))
        return ok(services.dashboard(user), message="Request declined")


class RiderOrderStatusView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"],
        request=RiderStatusInput,
        responses={200: DASHBOARD, **errors(400, 401, 403, 404, 409, 422)},
    )
    def patch(self, request: Request, id: str) -> Response:
        order_id = parse_id(id)
        data = validated(RiderStatusInput, request.data)
        user = current_user(request)
        orders.rider_set_status(user, order_id, data["status"], data.get("otp") or None)
        return ok(services.dashboard(user), message=STATUS_MESSAGE[data["status"]])


class RiderHistoryView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"], parameters=[PageQuery], responses={200: RESULT, **errors(401, 403, 422)}
    )
    def get(self, request: Request) -> Response:
        query = validated(PageQuery, request.query_params)
        return ok(orders.rider_history(current_user(request), Page.from_query(query)))


class RiderReviewQuery(PageQuery):
    rating = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=5,
        error_messages=dict.fromkeys(("invalid", "min_value", "max_value"), "Invalid value"),
    )
    sort = serializers.ChoiceField(
        choices=["newest", "oldest", "highest", "lowest"],
        required=False,
        error_messages=dict.fromkeys(("invalid_choice", "null", "blank"), "Invalid value"),
    )


class RiderReviewsView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"],
        parameters=[RiderReviewQuery],
        responses={200: envelope("RiderReviews"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(RiderReviewQuery, request.query_params)
        page = Page.from_query(query, default_limit=10)
        return ok(review_services.rider_list(current_user(request), query, page))


class RiderEarningsView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"],
        operation_id="delivery_earnings",
        parameters=[DaysQuery],
        responses={200: envelope("RiderEarnings"), **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        days = validated(DaysQuery, request.query_params).get("days", 30)
        return ok(reports.rider_earnings(current_user(request), days))


class RiderStatsView(APIView):
    permission_classes = RIDER

    @extend_schema(tags=["Delivery"], responses={200: envelope("RiderStats"), **errors(401, 403)})
    def get(self, request: Request) -> Response:
        return ok(reports.rider_stats(current_user(request)))


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
class AdminRiderQuery(PageQuery):
    online = QueryBoolean()
    verification = serializers.ChoiceField(choices=VerificationStatus.values, required=False)


class AdminVerificationInput(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=[
            VerificationStatus.APPROVED,
            VerificationStatus.REJECTED,
            VerificationStatus.RESUBMISSION_REQUESTED,
        ]
    )
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")


class RiderDetailsInput(serializers.Serializer):
    address = RestaurantAddressInput()


class AdminRiderStatusInput(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=UserStatus.values,
        error_messages=dict.fromkeys(
            ("invalid_choice", "required", "null", "blank"), "Status must be active or suspended"
        ),
    )


RIDERS_ADMIN = [permission_required(Permission.RIDERS_MANAGE)]


class AdminRidersView(APIView):
    permission_classes = RIDERS_ADMIN

    @extend_schema(
        tags=["Admin: delivery partners"],
        parameters=[AdminRiderQuery],
        responses={200: RESULT, **errors(401, 403, 422)},
    )
    def get(self, request: Request) -> Response:
        query = validated(AdminRiderQuery, request.query_params)
        return ok(services.admin_list(query, Page.from_query(query)))


class AdminRiderStatusView(APIView):
    permission_classes = RIDERS_ADMIN

    @extend_schema(
        tags=["Admin: delivery partners"],
        request=AdminRiderStatusInput,
        responses={200: RESULT, **errors(401, 403, 404, 409, 422)},
    )
    @audited("rider.status", "user", lambda req: f"Set rider status to {req.data.get('status')}")
    def patch(self, request: Request, id: str) -> Response:
        user_id = parse_id(id)
        data = validated(AdminRiderStatusInput, request.data)
        user = services.admin_set_status(user_id, data["status"])
        return ok(
            {"user": user_json(user)},
            message="Rider reactivated" if user.status == UserStatus.ACTIVE else "Rider suspended",
        )


class AdminRiderView(APIView):
    permission_classes = RIDERS_ADMIN

    @extend_schema(
        tags=["Admin: delivery partners"],
        operation_id="admin_delivery_partner_detail",
        responses={200: RESULT, **errors(401, 403, 404)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.admin_get(parse_id(id)))


class AdminRiderVerificationView(APIView):
    """Approve a rider (once documents, bank account and address are in), ask for documents
    again, or reject."""

    permission_classes = RIDERS_ADMIN

    @extend_schema(
        tags=["Admin: delivery partners"],
        request=AdminVerificationInput,
        responses={200: RESULT, **errors(400, 401, 403, 404, 409, 422)},
    )
    @audited(
        "rider.verification",
        "user",
        lambda req: f"Set rider verification to {req.data.get('status')}",
    )
    def patch(self, request: Request, id: str) -> Response:
        data = validated(AdminVerificationInput, request.data)
        result = services.admin_set_verification(
            parse_id(id), data["status"], data["reason"].strip(), current_user(request)
        )
        return ok(result, message="Verification updated")


# --- the rider's own verification ----------------------------------------------------------------


class RiderDetailsView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"],
        request=RiderDetailsInput,
        responses={200: RESULT, **errors(401, 403, 422)},
    )
    def patch(self, request: Request) -> Response:
        address = validated(RiderDetailsInput, request.data)["address"]
        return ok(
            {"profile": services.update_details(current_user(request), address)},
            message="Details saved",
        )


class RiderResubmitView(APIView):
    permission_classes = RIDER

    @extend_schema(
        tags=["Delivery"], request=None, responses={200: RESULT, **errors(401, 403, 409)}
    )
    def post(self, request: Request) -> Response:
        return ok({"profile": services.resubmit(current_user(request))}, message="Sent for review")
