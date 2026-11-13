from django.urls import URLPattern, URLResolver, include, path, re_path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from apps.uploads.views import serve_image
from common.exceptions import route_not_found
from common.health import HealthView, LiveView, ReadyView

api_v1: list[URLPattern | URLResolver] = [
    path("health", HealthView.as_view(), name="health"),
    path("health/live", LiveView.as_view(), name="health-live"),
    path("health/ready", ReadyView.as_view(), name="health-ready"),
    path("", include("apps.accounts.urls")),
    path("", include("apps.restaurants.urls")),
    path("", include("apps.menus.urls")),
    path("", include("apps.uploads.urls")),
    path("", include("apps.geo.urls")),
    path("", include("apps.cart.urls")),
    path("", include("apps.customers.urls")),
    path("", include("apps.coupons.urls")),
    path("", include("apps.orders.urls")),
    path("", include("apps.delivery.urls")),
    path("", include("apps.reviews.urls")),
    path("", include("apps.coins.urls")),
    path("", include("apps.finance.urls")),
    path("", include("apps.payments.urls")),
    path("", include("apps.tracking.urls")),
    path("", include("apps.kyc.urls")),
    path("", include("apps.notifications.urls")),
    path("", include("apps.support.urls")),
    path("", include("apps.newsletter.urls")),
]

urlpatterns = [
    path("api/v1/", include(api_v1)),
    path("uploads/images/<str:name>", serve_image),
    path("api/docs.json", SpectacularAPIView.as_view(), name="openapi-schema"),
    path("api/docs", SpectacularSwaggerView.as_view(url_name="openapi-schema"), name="swagger-ui"),
    # Unknown API paths get the JSON envelope, not Django's HTML page.
    re_path(r"^api/", route_not_found),
]

handler500 = "common.exceptions.server_error"
