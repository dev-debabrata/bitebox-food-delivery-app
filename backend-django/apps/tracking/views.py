from drf_spectacular.utils import extend_schema
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.authentication import current_user
from common.api import ok
from common.permissions import IsSignedIn
from common.schema import envelope, errors
from common.validation import parse_id

from . import services


class OrderTrackingView(APIView):
    """The customer of the order, its rider, or staff with orders:view."""

    permission_classes = [IsSignedIn]

    @extend_schema(
        tags=["Tracking"],
        responses={200: envelope("OrderTracking"), **errors(401, 404, 422)},
    )
    def get(self, request: Request, id: str) -> Response:
        return ok(services.order_tracking(current_user(request), parse_id(id)))
