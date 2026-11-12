"""The OpenAPI document generates without warnings and lists every API route."""

from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from drf_spectacular.generators import SchemaGenerator
from drf_spectacular.validation import validate_schema
from rest_framework.test import APIClient


def api_routes(patterns: Any, prefix: str = "") -> set[str]:
    routes: set[str] = set()
    for p in patterns:
        if isinstance(p, URLResolver):
            routes |= api_routes(p.url_patterns, prefix + str(p.pattern))
        elif isinstance(p, URLPattern):
            route = prefix + str(p.pattern)
            if route.startswith("api/v1/"):
                routes.add("/" + route.replace("<str:", "{").replace("<", "{").replace(">", "}"))
    return routes


def test_schema_is_valid_and_complete() -> None:
    schema = SchemaGenerator().get_schema(request=None, public=True)
    validate_schema(schema)
    assert api_routes(get_resolver().url_patterns) <= set(schema["paths"])


@pytest.mark.parametrize("path", ["/api/docs.json", "/api/docs"])
def test_docs_are_served(api: APIClient, path: str) -> None:
    assert api.get(path).status_code == 200
