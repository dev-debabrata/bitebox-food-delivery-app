from django.urls import path

from . import views

urlpatterns = [
    path("delivery/me", views.DashboardView.as_view()),
    path("delivery/me/vehicle", views.VehicleView.as_view()),
    path("delivery/me/details", views.RiderDetailsView.as_view()),
    path("delivery/me/resubmit", views.RiderResubmitView.as_view()),
    path("delivery/me/availability", views.AvailabilityView.as_view()),
    path("delivery/me/location", views.LocationView.as_view()),
    path("delivery/offers/<str:id>/accept", views.OfferAcceptView.as_view()),
    path("delivery/offers/<str:id>/decline", views.OfferDeclineView.as_view()),
    path("delivery/orders/history", views.RiderHistoryView.as_view()),
    path("delivery/reviews", views.RiderReviewsView.as_view()),
    path("delivery/earnings", views.RiderEarningsView.as_view()),
    path("delivery/stats", views.RiderStatsView.as_view()),
    path("delivery/orders/<str:id>/status", views.RiderOrderStatusView.as_view()),
    path("admin/delivery-partners", views.AdminRidersView.as_view()),
    path("admin/delivery-partners/<str:id>", views.AdminRiderView.as_view()),
    path("admin/delivery-partners/<str:id>/status", views.AdminRiderStatusView.as_view()),
    path(
        "admin/delivery-partners/<str:id>/verification", views.AdminRiderVerificationView.as_view()
    ),
]
