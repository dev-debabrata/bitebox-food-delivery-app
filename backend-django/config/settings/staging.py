"""Staging: production settings, with HSTS kept short so a misconfiguration is easy to undo."""

from .production import *

SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=60 * 60)
