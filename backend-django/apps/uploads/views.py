"""POST /api/v1/uploads/images and /review-images; GET /uploads/images/<name> serves local files."""

from typing import Any

from django.conf import settings
from django.http import FileResponse, Http404, HttpRequest
from drf_spectacular.utils import extend_schema
from rest_framework.parsers import MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.rbac.roles import Role
from common.api import ApiError, ok
from common.permissions import IsSignedIn, role_required
from common.schema import envelope, errors
from common.throttling import rate_limit

from .storage import CONTENT_TYPES, LOCAL_NAME, save_image

UPLOADED = envelope("Uploaded")


def _image_from(request: Request) -> bytes:
    files = request.FILES.getlist("image")
    if len(files) != 1 or len(request.FILES) != 1:
        if not files:
            raise ApiError.bad_request("Choose an image to upload")
        raise ApiError(
            400, 'Upload a single image in the "image" field', code="LIMIT_UNEXPECTED_FILE"
        )
    upload = files[0]
    if upload.size is None or upload.size > settings.MAX_IMAGE_BYTES:
        raise ApiError(413, "Image must be 2 MB or smaller", code="LIMIT_FILE_SIZE")
    return upload.read()


class _ImageUpload(APIView):
    parser_classes = [MultiPartParser]
    noun = "Image"

    @extend_schema(
        tags=["Uploads"],
        request={
            "multipart/form-data": {
                "type": "object",
                "properties": {"image": {"type": "string", "format": "binary"}},
            }
        },
        responses={201: UPLOADED, **errors(400, 401, 403, 413, 415, 429, 503)},
    )
    def post(self, request: Request) -> Response:
        return ok(save_image(_image_from(request)), message=f"{self.noun} uploaded", status=201)


class ImageUploadView(_ImageUpload):
    permission_classes = [role_required(Role.RESTAURANT, Role.ADMIN)]
    throttle_classes = [
        rate_limit("IMAGE_UPLOAD_RATE_LIMIT", "Too many image uploads. Try again later.")
    ]


class ReviewImageUploadView(_ImageUpload):
    permission_classes = [role_required(Role.CUSTOMER)]
    throttle_classes = [
        rate_limit("REVIEW_IMAGE_UPLOAD_RATE_LIMIT", "Too many photo uploads. Try again later.")
    ]
    noun = "Photo"


@extend_schema(exclude=True)
def serve_image(request: HttpRequest, name: str) -> Any:
    """Locally stored images (development, or a server without Cloudinary)."""
    if not LOCAL_NAME.match(name):
        raise Http404
    path = settings.UPLOAD_DIR / "images" / name
    if not path.is_file():
        raise Http404
    response = FileResponse(path.open("rb"), content_type=CONTENT_TYPES[name.rsplit(".", 1)[1]])
    response["Cross-Origin-Resource-Policy"] = "cross-origin"  # the web app runs on another origin
    response["X-Content-Type-Options"] = "nosniff"
    response["Cache-Control"] = (
        "public, max-age=31536000, immutable"  # names are random and never reused
    )
    return response


class AvatarUploadView(_ImageUpload):
    """A profile photo, for anyone signed in (saved with PATCH /auth/me avatarUrl)."""

    permission_classes = [IsSignedIn]
    throttle_classes = [
        rate_limit("REVIEW_IMAGE_UPLOAD_RATE_LIMIT", "Too many photo uploads. Try again later.")
    ]
    noun = "Photo"
