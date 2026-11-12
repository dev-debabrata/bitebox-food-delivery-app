"""URL slugs (Node: utils/slug.js)."""

import re
import secrets
import unicodedata

from django.db.models import Model


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", value)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:60]
    return text or "item"


def unique_slug(model: type[Model], value: str, exclude_pk: object = None) -> str:
    base = slugify(value)
    manager = model._default_manager
    for attempt in range(5):
        candidate = base if attempt == 0 else f"{base}-{secrets.token_hex(3)}"
        qs = manager.filter(slug=candidate)
        if exclude_pk is not None:
            qs = qs.exclude(pk=exclude_pk)
        if not qs.exists():
            return candidate
    raise RuntimeError("Could not generate a unique slug")
