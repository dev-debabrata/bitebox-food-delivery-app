"""
The response contract the Angular app depends on (frontend/src/app/shared/models/api.models.ts,
core/services/api-error.ts), checked through real requests.
"""

from typing import Any

import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.urls("common.tests.urls")

VALID_ORDER = {
    "paymentMethod": "cod",
    "deliveryAddress": {"postalCode": "700150", "city": "Rajpur Sonarpur"},
    "items": [{"foodItemId": "f1", "quantity": 2}],
}


def body(response: Any) -> dict[str, Any]:
    return response.json()


def test_success_envelope_with_camel_case_both_ways(api: APIClient) -> None:
    response = api.post("/api/v1/echo", VALID_ORDER, format="json")
    assert response.status_code == 201
    assert body(response) == {"success": True, "message": "Order accepted", "data": VALID_ORDER}


def test_validation_errors_are_422_with_node_style_field_paths(api: APIClient) -> None:
    payload = {
        "paymentMethod": "card",
        "deliveryAddress": {"postalCode": "70", "city": "Rajpur Sonarpur"},
        "items": [{"foodItemId": "f1", "quantity": 1}, {"foodItemId": "f2", "quantity": 0}],
    }
    response = api.post("/api/v1/echo", payload, format="json")
    assert response.status_code == 422
    data = body(response)
    assert data["success"] is False
    assert data["message"] == "Validation failed"
    assert data["error"]["code"] == "VALIDATION_ERROR"
    fields = {d["field"] for d in data["error"]["details"]}
    assert fields == {"paymentMethod", "deliveryAddress.postalCode", "items[1].quantity"}
    # One message per field, like express-validator's onlyFirstError.
    assert len(data["error"]["details"]) == 3


def test_malformed_json_is_400(api: APIClient) -> None:
    response = api.generic("POST", "/api/v1/echo", "{not json", content_type="application/json")
    assert response.status_code == 400
    assert body(response)["error"] == {"code": "BAD_REQUEST"}
    assert body(response)["message"] == "Malformed JSON body"


@pytest.mark.parametrize(
    ("kind", "status", "code", "message"),
    [
        ("api", 409, "ORDER_CHANGED", "That order changed. Reload and try again."),
        ("forbidden", 403, "FORBIDDEN", "You do not have permission to perform this action"),
        ("missing", 404, "NOT_FOUND", "Resource not found"),
        ("throttled", 429, "RATE_LIMITED", "Too many requests, please try again later."),
    ],
)
def test_client_errors_use_the_envelope(
    api: APIClient, kind: str, status: int, code: str, message: str
) -> None:
    response = api.get(f"/api/v1/boom/{kind}")
    assert response.status_code == status
    assert body(response) == {"success": False, "message": message, "error": {"code": code}}
    assert response["Cache-Control"] == "no-store"


def test_throttled_sets_retry_after(api: APIClient) -> None:
    assert api.get("/api/v1/boom/throttled")["Retry-After"] == "30"


def test_unexpected_errors_are_generic_500_without_internals(api: APIClient) -> None:
    response = api.get("/api/v1/boom/crash")
    assert response.status_code == 500
    assert body(response) == {
        "success": False,
        "message": "Something went wrong. Please try again later.",
        "error": {"code": "INTERNAL_ERROR"},
    }
    assert "secret internal detail" not in response.content.decode()


def test_unknown_api_route_is_json_404(api: APIClient) -> None:
    response = api.get("/api/v1/nowhere?x=1")
    assert response.status_code == 404
    assert body(response) == {
        "success": False,
        "message": "Route not found: GET /api/v1/nowhere?x=1",
        "error": {"code": "NOT_FOUND"},
    }


def test_wrong_method_is_405(api: APIClient) -> None:
    response = api.delete("/api/v1/echo")
    assert response.status_code == 405
    assert body(response)["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_pagination_shape_and_clamping(api: APIClient) -> None:
    data = body(api.get("/api/v1/listing?page=2&limit=20"))["data"]
    assert data["items"][0] == 21
    assert data["pagination"] == {"page": 2, "limit": 20, "total": 45, "totalPages": 3}

    clamped = body(api.get("/api/v1/listing?page=-4&limit=5000"))["data"]["pagination"]
    assert clamped == {"page": 1, "limit": 100, "total": 45, "totalPages": 1}

    junk = body(api.get("/api/v1/listing?page=abc&limit=x"))["data"]["pagination"]
    assert junk["page"] == 1
    assert junk["limit"] == 20


@pytest.mark.parametrize("path", ["/api/v1/admin-only", "/api/v1/rider-only"])
def test_protected_views_refuse_anonymous_requests(api: APIClient, path: str) -> None:
    # No authentication exists until Phase 5, so anonymous requests are refused (403 until an
    # authenticator is installed, 401 after). Either way the envelope is the same.
    response = api.get(path)
    assert response.status_code in (401, 403)
    assert body(response)["success"] is False
