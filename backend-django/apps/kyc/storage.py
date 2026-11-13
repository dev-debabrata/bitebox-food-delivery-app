"""
Private storage for KYC documents: a directory that no URL serves. Files are read back only
through the API, by the owner or a reviewing admin (apps/kyc/views.py).
"""

import uuid
from pathlib import Path

from django.conf import settings

from apps.uploads.metadata import strip_metadata
from apps.uploads.storage import detect_image_type
from common.api import ApiError

CONTENT_TYPES = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}


def _dir() -> Path:
    path = Path(settings.PRIVATE_UPLOAD_DIR) / "kyc"
    path.mkdir(parents=True, exist_ok=True)
    return path


def detect(data: bytes) -> str | None:
    if data[:5] == b"%PDF-":
        return "pdf"
    return detect_image_type(data)


def save(data: bytes) -> tuple[str, str]:
    """(file name, content type). Type from the bytes; photos lose their metadata."""
    if len(data) > settings.MAX_DOCUMENT_BYTES:
        raise ApiError(413, "Documents must be 5 MB or smaller", code="LIMIT_FILE_SIZE")
    kind = detect(data)
    if kind is None:
        raise ApiError(415, "Upload a PDF, JPEG, PNG or WebP file", code="UNSUPPORTED_MEDIA_TYPE")
    if kind != "pdf":
        try:
            data = strip_metadata(data, kind)
        except ValueError:
            raise ApiError(
                415, "This file is damaged. Try another one.", code="UNSUPPORTED_MEDIA_TYPE"
            ) from None
    name = f"{uuid.uuid4()}.{kind}"
    with open(_dir() / name, "xb") as f:
        f.write(data)
    return name, CONTENT_TYPES[kind]


def path_of(name: str) -> Path:
    return _dir() / Path(name).name  # never outside the directory


def delete(name: str) -> None:
    path_of(name).unlink(missing_ok=True)
