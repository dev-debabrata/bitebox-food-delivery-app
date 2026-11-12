"""
`?page=&limit=` paging with the Node API's response shape (backend/utils/pagination.js):

    { "items": [...], "pagination": { "page", "limit", "total", "totalPages" } }

Out-of-range or junk values are clamped, never rejected (page ≥ 1, 1 ≤ limit ≤ max).
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from django.db.models import QuerySet
from rest_framework.pagination import BasePagination
from rest_framework.request import Request
from rest_framework.response import Response

from .api import ok

DEFAULT_LIMIT = 20
MAX_LIMIT = 100


def _int(value: Any, default: int) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Page:
    page: int
    limit: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit

    @classmethod
    def from_query(
        cls, query: Any, *, default_limit: int = DEFAULT_LIMIT, max_limit: int = MAX_LIMIT
    ) -> "Page":
        page = max(1, _int(query.get("page"), 1))
        limit = min(max_limit, max(1, _int(query.get("limit"), default_limit)))
        return cls(page=page, limit=limit)

    def meta(self, total: int) -> dict[str, int]:
        return {
            "page": self.page,
            "limit": self.limit,
            "total": total,
            "totalPages": math.ceil(total / self.limit),
        }


def paginate(source: QuerySet[Any] | Sequence[Any], page: Page) -> tuple[list[Any], dict[str, int]]:
    """Slice a queryset or list; returns (items, pagination meta)."""
    total = source.count() if isinstance(source, QuerySet) else len(source)
    items = list(source[page.offset : page.offset + page.limit])
    return items, page.meta(total)


class PagePagination(BasePagination):
    """DRF pagination class for generic list views (REST_FRAMEWORK["DEFAULT_PAGINATION_CLASS"])."""

    def paginate_queryset(self, queryset: Any, request: Request, view: Any = None) -> list[Any]:
        self.page = Page.from_query(request.query_params)
        items, self.meta = paginate(queryset, self.page)
        return items

    def get_paginated_response(self, data: Any) -> Response:
        return ok({"items": data, "pagination": self.meta})

    def get_paginated_response_schema(self, schema: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "items": schema,
                "pagination": {
                    "type": "object",
                    "properties": {
                        k: {"type": "integer"} for k in ("page", "limit", "total", "totalPages")
                    },
                },
            },
        }

    def get_schema_operation_parameters(self, view: Any) -> list[dict[str, Any]]:
        return [
            {
                "name": "page",
                "in": "query",
                "required": False,
                "schema": {"type": "integer", "minimum": 1},
            },
            {
                "name": "limit",
                "in": "query",
                "required": False,
                "schema": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT},
            },
        ]
