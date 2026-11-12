"""
Settings shared by every environment. Values come from the environment (or backend-django/.env
in development); see .env.example. Environment modules (development, test, staging, production)
import this and override.
"""

from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parents[2]

env = environ.Env()
# Real environment variables win over the file (read_env never overwrites them).
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env.str("DJANGO_SECRET_KEY", default="")
DEBUG = False
ALLOWED_HOSTS: list[str] = env.list("DJANGO_ALLOWED_HOSTS", default=[])

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------
# The custom User model is set from the first migration (it can't be swapped later).
# django.contrib.admin arrives with sign-in in Phase 5.
AUTH_USER_MODEL = "accounts.User"

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "django_filters",
    "drf_spectacular",
    "channels",
    "common",
    "apps.rbac",
    "apps.realtime",
    # Domain apps (docs/django-migration/03-data-model.md)
    "apps.accounts",
    "apps.customers",
    "apps.restaurants",
    "apps.menus",
    "apps.cart",
    "apps.coupons",
    "apps.orders",
    "apps.delivery",
    "apps.dispatch",
    "apps.payments",
    "apps.finance",
    "apps.notifications",
    "apps.reviews",
    "apps.support",
    "apps.audit",
    "apps.coins",
    "apps.newsletter",
    "apps.uploads",
    "apps.geo",
]

# Argon2id first; bcrypt only verifies hashes imported from the Node API (re-hashed on next login).
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.BCryptPasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 8},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    # DRF API views are CSRF-exempt (they use bearer tokens; the refresh cookie gets its own
    # header and Origin check in Phase 5). The middleware protects the Django admin.
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # ?pageSize=… → page_size for views and serializers.
    "djangorestframework_camel_case.middleware.CamelCaseMiddleWare",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# Node routes have no trailing slash; keep the same URLs.
APPEND_SLASH = False

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    }
]

# ---------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------
DATABASES = {
    "default": {
        **env.db_url("DATABASE_URL", default="postgres://bitebox:bitebox@localhost:5432/bitebox"),
        "CONN_MAX_AGE": env.int("DB_CONN_MAX_AGE", default=60),
        "CONN_HEALTH_CHECKS": True,
    }
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REDIS_URL = env.str("REDIS_URL", default="redis://localhost:6379/0")

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}

# ---------------------------------------------------------------------------
# Celery (config/celery.py reads every CELERY_* setting)
# ---------------------------------------------------------------------------
CELERY_BROKER_URL = env.str("CELERY_BROKER_URL", default=REDIS_URL)
CELERY_TASK_IGNORE_RESULT = True
CELERY_TASK_ACKS_LATE = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TIMEZONE = "UTC"
CELERY_TASK_ALWAYS_EAGER = False
# Fail fast when the broker is unreachable (health checks, web requests that enqueue tasks)
# instead of retrying for seconds; workers reconnect on their own.
CELERY_BROKER_CONNECTION_TIMEOUT = 2
CELERY_BROKER_TRANSPORT_OPTIONS = {"max_retries": 1, "interval_start": 0, "interval_step": 0.5}

# ---------------------------------------------------------------------------
# Time, language, static files
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "en-in"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True
# Days in reports and earnings are grouped in this zone (same as the Node API's REPORT_TIMEZONE).
REPORT_TIMEZONE = env.str("REPORT_TIMEZONE", default="Asia/Kolkata")

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# ---------------------------------------------------------------------------
# HTTP, CORS
# ---------------------------------------------------------------------------
# The web app's origins (comma separated), like the Node API's CLIENT_URL.
CLIENT_URLS: list[str] = env.list("CLIENT_URL", default=["http://localhost:4200"])
CORS_ALLOWED_ORIGINS = CLIENT_URLS
CORS_ALLOW_CREDENTIALS = True  # the refresh-token cookie (Phase 5)
CORS_URLS_REGEX = r"^/api/.*$"
CORS_ALLOW_HEADERS = [
    "accept",
    "authorization",
    "content-type",
    "idempotency-key",
    "x-requested-with",
]

# Larger bodies are rejected before parsing (images go through /uploads with their own limit).
DATA_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024

# ---------------------------------------------------------------------------
# Authentication (same behaviour and env names as the Node API's config/env.js)
# ---------------------------------------------------------------------------
JWT_SECRET = env.str("JWT_SECRET", default="")
JWT_ISSUER = "bitebox-api"
JWT_AUDIENCE = "bitebox-web"
JWT_ACCESS_TTL_SECONDS = env.int("JWT_ACCESS_TTL_SECONDS", default=15 * 60)
REFRESH_TOKEN_TTL_DAYS = env.int("REFRESH_TOKEN_TTL_DAYS", default=7)
REFRESH_COOKIE_NAME = "bb_refresh"
REFRESH_COOKIE_PATH = "/api/v1/auth"
# The web app reaches the API on the same site, so Strict works; "None" only for a cross-site API.
REFRESH_COOKIE_SAMESITE = env.str("COOKIE_SAMESITE", default="Strict")
REFRESH_COOKIE_SECURE = True  # development settings turn this off (http://localhost)
PASSWORD_RESET_TTL_MINUTES = env.int("PASSWORD_RESET_TTL_MINUTES", default=30)
# Rate limits per client IP: "<requests>/<seconds>s" (Node: 20 and 5 per 15 minutes).
AUTH_RATE_LIMIT = env.str("AUTH_RATE_LIMIT", default="20/900s")
SENSITIVE_RATE_LIMIT = env.str("SENSITIVE_RATE_LIMIT", default="5/900s")

# Email (password reset). Without SMTP_HOST, development prints emails to the console.
SMTP_HOST = env.str("SMTP_HOST", default="")
EMAIL_HOST = SMTP_HOST
EMAIL_PORT = env.int("SMTP_PORT", default=587)
EMAIL_HOST_USER = env.str("SMTP_USER", default="")
EMAIL_HOST_PASSWORD = env.str("SMTP_PASS", default="")
EMAIL_USE_SSL = EMAIL_PORT == 465
EMAIL_USE_TLS = EMAIL_PORT != 465
EMAIL_TIMEOUT = 15
DEFAULT_FROM_EMAIL = env.str("EMAIL_FROM", default="BiteBox <no-reply@example.com>")
EMAIL_BACKEND = (
    "django.core.mail.backends.smtp.EmailBackend"
    if SMTP_HOST
    else "django.core.mail.backends.console.EmailBackend"
)

# Uploaded images: Cloudinary when all three keys are set, otherwise local disk under UPLOAD_DIR,
# served at PUBLIC_BASE_URL/uploads/images/<random name> (Node: services/upload.service.js).
PUBLIC_BASE_URL = env.str("PUBLIC_BASE_URL", default="http://localhost:8000").rstrip("/")
UPLOAD_DIR = Path(env.str("UPLOAD_DIR", default=str(BASE_DIR / "uploads")))
MAX_IMAGE_BYTES = 2 * 1024 * 1024
CLOUDINARY_CLOUD_NAME = env.str("CLOUDINARY_CLOUD_NAME", default="")
CLOUDINARY_API_KEY = env.str("CLOUDINARY_API_KEY", default="")
CLOUDINARY_API_SECRET = env.str("CLOUDINARY_API_SECRET", default="")
CLOUDINARY_FOLDER = env.str("CLOUDINARY_FOLDER", default="bitebox")
IMAGE_UPLOAD_RATE_LIMIT = env.str("IMAGE_UPLOAD_RATE_LIMIT", default="60/3600s")
REVIEW_IMAGE_UPLOAD_RATE_LIMIT = env.str("REVIEW_IMAGE_UPLOAD_RATE_LIMIT", default="30/3600s")
# Files bigger than this are rejected before they are fully read into memory.
FILE_UPLOAD_MAX_MEMORY_SIZE = MAX_IMAGE_BYTES + 64 * 1024

# Free map services (Node: GEOCODER_URL, ROUTING_URL...). Their usage policies ask for an
# identifying User-Agent and about one request per second; self-host them for real traffic.
GEOCODER_URL = env.str("GEOCODER_URL", default="https://nominatim.openstreetmap.org")
# An empty value in .env (as .env.example ships it) falls back to the default.
GEOCODER_USER_AGENT = env.str("GEOCODER_USER_AGENT", default="") or (
    "BiteBoxApp/1.0 (BiteBox Food Delivery Platform; contact: support@bitebox.local)"
)
GEOCODER_COUNTRY_CODES = env.str("GEOCODER_COUNTRY_CODES", default="in")
ROUTING_URL = env.str("ROUTING_URL", default="https://router.project-osrm.org")
ROUTING_PROFILE = env.str("ROUTING_PROFILE", default="driving")
UPSTREAM_MIN_GAP_SECONDS = 1.1
GEO_RATE_LIMIT = env.str("GEO_RATE_LIMIT", default="30/60s")
COUPON_RATE_LIMIT = env.str("COUPON_RATE_LIMIT", default="30/900s")
ORDER_RATE_LIMIT = env.str("ORDER_RATE_LIMIT", default="10/60s")
# Delivery OTP: a 4-digit code made at pickup, shown to the customer, required to mark delivered.
DELIVERY_OTP_REQUIRED = env.bool("DELIVERY_OTP_REQUIRED", default=True)
DELIVERY_OTP_MAX_ATTEMPTS = env.int("DELIVERY_OTP_MAX_ATTEMPTS", default=5)

# Payments. Razorpay is used when both keys are set; otherwise the simulated provider, which is
# never available in production (production.py turns it off).
RAZORPAY_KEY_ID = env.str("RAZORPAY_KEY_ID", default="")
RAZORPAY_KEY_SECRET = env.str("RAZORPAY_KEY_SECRET", default="")
RAZORPAY_WEBHOOK_SECRET = env.str("RAZORPAY_WEBHOOK_SECRET", default="")
PAYMENTS_MOCK_ENABLED = env.bool("PAYMENTS_MOCK", default=True)
LOCATION_RATE_LIMIT = env.str("LOCATION_RATE_LIMIT", default="30/60s")

# Rate-limit counters. Production uses Redis so every API instance shares them.
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

# ---------------------------------------------------------------------------
# Django REST Framework
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["common.renderers.CamelCaseJSONRenderer"],
    "DEFAULT_PARSER_CLASSES": [
        "djangorestframework_camel_case.parser.CamelCaseJSONParser",
        "djangorestframework_camel_case.parser.CamelCaseMultiPartParser",
    ],
    "EXCEPTION_HANDLER": "common.exceptions.exception_handler",
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "common.pagination.PagePagination",
    "PAGE_SIZE": 20,
    # Bearer access tokens; views opt in to protection with permission classes.
    "DEFAULT_AUTHENTICATION_CLASSES": ["apps.accounts.authentication.BearerAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "UNAUTHENTICATED_USER": None,
    # Proxies in front of the API (nginx = 1), so rate limits see the real client IP.
    "NUM_PROXIES": env.int("TRUST_PROXY", default=0),
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

# line1 stays line1 (not line_1) in both directions, like the Node field names.
JSON_CAMEL_CASE = {"JSON_UNDERSCOREIZE": {"no_underscore_before_number": True}}

SPECTACULAR_SETTINGS = {
    "TITLE": "BiteBox API",
    "DESCRIPTION": (
        "Food delivery platform API. Every response uses the envelope "
        "`{ success, message, data }`; errors are `{ success: false, message, "
        "error: { code, details? } }`. Money is in integer paise."
    ),
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "SCHEMA_PATH_PREFIX": r"/api/v1",
    "COMPONENT_SPLIT_REQUEST": True,
    "ENUM_NAME_OVERRIDES": {
        "ConnectionStateEnum": "common.health.CONNECTION_STATES",
        "HealthStatusEnum": "common.health.HEALTH_STATES",
        "UserStatusEnum": "apps.accounts.models.USER_STATUS_VALUES",
        "RoleEnum": "apps.rbac.roles.ALL_ROLE_VALUES",
        "SelfRegisterRoleEnum": "apps.accounts.serializers.SELF_REGISTER_ROLE_VALUES",
        "StaffRoleEnum": "apps.rbac.roles.STAFF_ROLE_VALUES",
        "AdminRoleEnum": "apps.rbac.roles.ADMIN_ROLE_VALUES",
    },
    "POSTPROCESSING_HOOKS": [
        "drf_spectacular.contrib.djangorestframework_camel_case.camelize_serializer_fields",
        "drf_spectacular.hooks.postprocess_schema_enums",
    ],
}

# ---------------------------------------------------------------------------
# Logging: one line per record on stdout (collected by Docker / the platform).
# ---------------------------------------------------------------------------
LOG_LEVEL = env.str("LOG_LEVEL", default="INFO")
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "line": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"},
    },
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "line"}},
    "root": {"handlers": ["console"], "level": LOG_LEVEL},
    "loggers": {
        "django.request": {"level": "ERROR"},
        "celery": {"level": LOG_LEVEL},
    },
}
