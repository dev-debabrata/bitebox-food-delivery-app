"""
Tests. Never touches the developer's database:
TEST_DATABASE_URL (PostgreSQL + PostGIS) is required, and its database name must end in "_test"
(CI sets it; locally see backend-django/README.md).
Redis, Celery and Channels run in-process.
"""

from django.core.exceptions import ImproperlyConfigured

from .base import *

SECRET_KEY = "test-only-secret-key-with-at-least-32-characters"  # noqa: S105
JWT_SECRET = "test-only-jwt-secret-that-is-long-enough-0123456789"  # noqa: S105
REFRESH_COOKIE_SECURE = False
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
# Fast hashing in tests (same algorithm name, tiny cost).
PASSWORD_HASHERS = [
    "common.testing.FastArgon2PasswordHasher",
    "django.contrib.auth.hashers.BCryptPasswordHasher",
]
AUTH_RATE_LIMIT = "1000/900s"
SENSITIVE_RATE_LIMIT = "1000/900s"
IMAGE_UPLOAD_RATE_LIMIT = "1000/3600s"
REVIEW_IMAGE_UPLOAD_RATE_LIMIT = "1000/3600s"
REVIEW_RATE_LIMIT = "1000/60s"
REVIEW_REPORT_RATE_LIMIT = "1000/900s"
CLOUDINARY_CLOUD_NAME = CLOUDINARY_API_KEY = CLOUDINARY_API_SECRET = ""  # tests use local disk
UPLOAD_DIR = BASE_DIR / ".test-uploads"
PRIVATE_UPLOAD_DIR = BASE_DIR / ".test-uploads" / "private"
RESTAURANT_KYC_REQUIRED = False  # most tests approve restaurants directly; KYC tests turn it on
RIDER_KYC_REQUIRED = False  # likewise for riders going online
UPSTREAM_MIN_GAP_SECONDS = 0
GEO_RATE_LIMIT = "1000/60s"
COUPON_RATE_LIMIT = "1000/900s"
REFERRAL_RATE_LIMIT = "1000/900s"
ORDER_RATE_LIMIT = "1000/60s"
NEWSLETTER_RATE_LIMIT = "1000/900s"
LOCATION_RATE_LIMIT = "1000/60s"
DEBUG = False
# Tests choose their provider (apps/payments/providers.py#use_online_provider); never real keys.
RAZORPAY_KEY_ID = RAZORPAY_KEY_SECRET = RAZORPAY_WEBHOOK_SECRET = ""
PAYMENTS_MOCK_ENABLED = True
# Notification channels: tests turn them on with fake senders (apps/notifications/senders.py).
VAPID_PUBLIC_KEY = VAPID_PRIVATE_KEY = FCM_CREDENTIALS_FILE = MSG91_AUTH_KEY = ""
SMS_PROVIDER = ""
SIGNUP_OTP_REQUIRED = False  # most tests register in one step; test_phone_email.py turns it on
PUSH_RATE_LIMIT = PROMOTION_RATE_LIMIT = "1000/60s"
ALLOWED_HOSTS = ["testserver", "localhost"]

# From Phase 6 the catalogue uses PostGIS and JSON operators, so tests need PostgreSQL.
_test_db = env.str("TEST_DATABASE_URL", default="")
if not _test_db:
    raise ImproperlyConfigured(
        "Set TEST_DATABASE_URL to a PostgreSQL + PostGIS database whose name ends in _test "
        "(see backend-django/README.md, Local PostgreSQL)."
    )
_db = env.db_url_config(_test_db)
if not str(_db.get("NAME", "")).endswith("_test"):
    raise ImproperlyConfigured(
        "TEST_DATABASE_URL must point at a database whose name ends in _test"
    )
DATABASES = {"default": {**_db, "TEST": {"NAME": _db["NAME"]}}}

CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True
CELERY_BROKER_URL = "memory://"
REDIS_URL = "redis://redis.invalid:6379/0"  # tests replace the Redis client; never a real server
LOGGING = {**LOGGING, "root": {"handlers": ["console"], "level": "WARNING"}}
