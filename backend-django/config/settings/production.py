"""Production: refuses to start without the settings that must be explicit."""

from django.core.exceptions import ImproperlyConfigured

from .base import *

DEBUG = False
PAYMENTS_MOCK_ENABLED = False  # simulated payments never run in production

if len(SECRET_KEY) < 32:
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set (32+ characters)")
if len(JWT_SECRET) < 32:
    raise ImproperlyConfigured("JWT_SECRET must be set (32+ characters)")
if not SMTP_HOST:
    raise ImproperlyConfigured("SMTP_HOST must be set (password reset emails)")
if not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS must list the public host names")

# Behind nginx, which terminates TLS and sets X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SECURE_REDIRECT_EXEMPT = [r"^api/v1/health"]  # internal health checks use plain HTTP
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=60 * 60 * 24 * 30)
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = False  # enable once HTTPS is stable on every subdomain
SILENCED_SYSTEM_CHECKS = ["security.W021"]  # HSTS preload is off on purpose (line above)
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
CSRF_TRUSTED_ORIGINS = CLIENT_URLS
X_FRAME_OPTIONS = "DENY"

# Rate-limit counters shared by every API instance.
CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": REDIS_URL}
}
