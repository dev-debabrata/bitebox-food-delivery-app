from typing import Any

from rest_framework.request import Request
from rest_framework.response import Response

PUBLIC_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=600"


class PublicCacheMixin:
    """
    Public catalogue reads may be shared by a CDN for 60 s (Node: publicCache). Browsers always
    revalidate, and errors stay `no-store` (set by the exception handler).
    """

    def finalize_response(
        self, request: Request, response: Response, *args: Any, **kwargs: Any
    ) -> Response:
        response = super().finalize_response(request, response, *args, **kwargs)  # type: ignore[misc]
        if request.method == "GET" and response.status_code < 400:
            response["Cache-Control"] = PUBLIC_CACHE
        return response
