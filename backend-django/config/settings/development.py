"""Local development: DEBUG on, a dev-only secret key if none is set."""

from .base import *

DEBUG = True
SECRET_KEY = SECRET_KEY or "dev-only-insecure-key-never-use-in-production"
JWT_SECRET = JWT_SECRET or "dev-only-jwt-secret-that-is-long-enough-0123456789"
REFRESH_COOKIE_SECURE = False  # http://localhost
ALLOWED_HOSTS = ALLOWED_HOSTS or ["localhost", "127.0.0.1", "[::1]"]

# `manage.py runserver` serves ASGI through Daphne (requirements/dev.txt), so the /ws/
# WebSocket works there too, not only under uvicorn.
INSTALLED_APPS = ["daphne", *INSTALLED_APPS]

# Without Redis (e.g. a laptop with no Docker), WebSockets can use an in-process channel layer.
# Single process only: never for staging or production, where events must cross processes.
if env.bool("CHANNEL_LAYER_IN_MEMORY", default=False):
    CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
