"""
Image storage (Node: services/upload.service.js). The real file type comes from the bytes, never
from the name or the declared content type. Storage is Cloudinary when configured, otherwise the
local disk; tests swap it with `use_image_storage`.
"""

import contextlib
import logging
import re
import uuid
from collections.abc import Iterator
from typing import Protocol
from urllib.parse import urlsplit

from django.conf import settings

from common.api import ApiError

from .metadata import strip_metadata

logger = logging.getLogger("bitebox.uploads")

LOCAL_NAME = re.compile(r"^[0-9a-f-]{36}\.(jpg|png|webp)$")
CONTENT_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def detect_image_type(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


class ImageStorage(Protocol):
    def save(self, data: bytes, extension: str) -> str: ...


class LocalStorage:
    def save(self, data: bytes, extension: str) -> str:
        directory = settings.UPLOAD_DIR / "images"
        directory.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4()}.{extension}"
        with open(directory / name, "xb") as f:  # never overwrite
            f.write(data)
        return f"{settings.PUBLIC_BASE_URL}/uploads/images/{name}"


class CloudinaryStorage:
    def save(self, data: bytes, extension: str) -> str:
        import cloudinary
        import cloudinary.uploader

        cloudinary.config(
            cloud_name=settings.CLOUDINARY_CLOUD_NAME,
            api_key=settings.CLOUDINARY_API_KEY,
            api_secret=settings.CLOUDINARY_API_SECRET,
            secure=True,
        )
        result = cloudinary.uploader.upload(
            data,
            folder=settings.CLOUDINARY_FOLDER,
            resource_type="image",
            unique_filename=True,
            overwrite=False,
        )
        url, _ = cloudinary.utils.cloudinary_url(
            result["public_id"],
            version=result["version"],
            fetch_format="auto",
            quality="auto",
            secure=True,
        )
        return str(url)


def is_uploaded_image_url(url: str) -> bool:
    """True for images this API stored (Node: isUploadedImageUrl): local or our Cloudinary."""
    parts = urlsplit(url)
    local = f"{settings.PUBLIC_BASE_URL}/uploads/images/"
    if url.startswith(local) and LOCAL_NAME.match(url[len(local) :]):
        return True
    cloud = settings.CLOUDINARY_CLOUD_NAME
    return bool(cloud) and (
        parts.scheme == "https"
        and parts.netloc == "res.cloudinary.com"
        and parts.path.startswith(f"/{cloud}/image/upload/")
    )


def cloudinary_enabled() -> bool:
    return bool(
        settings.CLOUDINARY_CLOUD_NAME
        and settings.CLOUDINARY_API_KEY
        and settings.CLOUDINARY_API_SECRET
    )


_override: ImageStorage | None = None


def storage() -> ImageStorage:
    if _override is not None:
        return _override
    return CloudinaryStorage() if cloudinary_enabled() else LocalStorage()


@contextlib.contextmanager
def use_image_storage(replacement: ImageStorage) -> Iterator[None]:
    """Swap the storage (tests)."""
    global _override
    previous, _override = _override, replacement
    try:
        yield
    finally:
        _override = previous


def save_image(data: bytes) -> dict[str, object]:
    kind = detect_image_type(data)
    if kind is None:
        raise ApiError(
            415, "Only JPEG, PNG or WebP images are allowed", code="UNSUPPORTED_MEDIA_TYPE"
        )
    try:
        data = strip_metadata(data, kind)  # no GPS, device or time data in public photos
    except ValueError:
        raise ApiError(
            415, "This image file is damaged. Try another one.", code="UNSUPPORTED_MEDIA_TYPE"
        ) from None
    try:
        url = storage().save(data, kind)
    except Exception:
        logger.exception("Image upload failed")
        raise ApiError(
            503, "Could not upload the image right now. Please try again.", code="UPLOAD_FAILED"
        ) from None
    return {"url": url, "bytes": len(data), "type": kind}
