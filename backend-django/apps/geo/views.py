"""/api/v1/geo/search, /reverse (public) and /route (signed in) (Node: routes/geo.routes.js)."""

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.api import ok
from common.geo import GeoPoint
from common.permissions import IsSignedIn
from common.schema import envelope, errors
from common.throttling import rate_limit
from common.validation import validated

from . import geocoding, routing

GeoLimit = rate_limit("GEO_RATE_LIMIT", "Too many location lookups. Please wait a moment.")


def _coordinate(limit: float, message: str) -> serializers.FloatField:
    keys = ("min_value", "max_value", "invalid", "required")
    return serializers.FloatField(
        min_value=-limit, max_value=limit, error_messages=dict.fromkeys(keys, message)
    )


def _lat() -> serializers.FloatField:
    return _coordinate(90, "Invalid latitude")


def _lng() -> serializers.FloatField:
    return _coordinate(180, "Invalid longitude")


class SearchQuery(serializers.Serializer):
    q = serializers.CharField(
        min_length=3,
        max_length=120,
        error_messages={
            k: "Type at least 3 characters"
            for k in ("min_length", "max_length", "required", "blank")
        },
    )


class ReverseQuery(serializers.Serializer):
    lat = _lat()
    lng = _lng()


class RouteQuery(serializers.Serializer):
    from_lat = _lat()
    from_lng = _lng()
    to_lat = _lat()
    to_lng = _lng()


class SearchView(APIView):
    throttle_classes = [GeoLimit]

    @extend_schema(
        tags=["Location"],
        parameters=[OpenApiParameter("q", str, required=True)],
        responses={200: envelope("Places"), **errors(422, 429, 503)},
    )
    def get(self, request: Request) -> Response:
        return ok({"places": geocoding.search(validated(SearchQuery, request.query_params)["q"])})


class ReverseView(APIView):
    throttle_classes = [GeoLimit]

    @extend_schema(
        tags=["Location"],
        parameters=[
            OpenApiParameter("lat", float, required=True),
            OpenApiParameter("lng", float, required=True),
        ],
        responses={200: envelope("Place"), **errors(404, 422, 429)},
    )
    def get(self, request: Request) -> Response:
        q = validated(ReverseQuery, request.query_params)
        return ok({"place": geocoding.reverse(q["lat"], q["lng"])})


class RouteView(APIView):
    permission_classes = [IsSignedIn]
    throttle_classes = [GeoLimit]

    @extend_schema(
        tags=["Location"],
        parameters=[
            OpenApiParameter(n, float, required=True)
            for n in ("fromLat", "fromLng", "toLat", "toLng")
        ],
        responses={200: envelope("Route"), **errors(400, 401, 422, 429, 503)},
    )
    def get(self, request: Request) -> Response:
        q = validated(RouteQuery, request.query_params)
        result = routing.route(
            GeoPoint(lat=q["from_lat"], lng=q["from_lng"]),
            GeoPoint(lat=q["to_lat"], lng=q["to_lng"]),
        )
        return ok({"route": result})
