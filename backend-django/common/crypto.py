"""
Field encryption for sensitive numbers (bank accounts, licence and document numbers; Node:
utils/field-crypto.js). AES-256-GCM with a random 12-byte nonce; the stored text is
"v1:" + base64(nonce + ciphertext). The key is FIELD_ENCRYPTION_KEY (32 bytes, base64); outside
production it falls back to a key derived from SECRET_KEY. Only the last 4 characters are ever
shown again.
"""

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings

PREFIX = "v1:"


def _key() -> bytes:
    if settings.FIELD_ENCRYPTION_KEY:
        key = base64.b64decode(settings.FIELD_ENCRYPTION_KEY)
        if len(key) != 32:
            raise RuntimeError("FIELD_ENCRYPTION_KEY must be 32 bytes, base64 encoded")
        return key
    return hashlib.sha256(f"field-encryption:{settings.SECRET_KEY}".encode()).digest()


def encrypt(text: str) -> str:
    nonce = os.urandom(12)
    sealed = AESGCM(_key()).encrypt(nonce, text.encode(), None)
    return PREFIX + base64.b64encode(nonce + sealed).decode()


def decrypt(token: str) -> str:
    if not token.startswith(PREFIX):
        raise ValueError("not an encrypted value")
    raw = base64.b64decode(token[len(PREFIX) :])
    return AESGCM(_key()).decrypt(raw[:12], raw[12:], None).decode()


def last4(text: str) -> str:
    return text[-4:]
