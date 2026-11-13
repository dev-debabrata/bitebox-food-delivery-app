from django.urls import path

from . import views

urlpatterns = [
    path("notifications", views.InboxView.as_view()),
    path("notifications/read-all", views.ReadAllView.as_view()),
    path("notifications/preferences", views.ChannelPreferencesView.as_view()),
    path("notifications/<str:id>/read", views.ReadView.as_view()),
    path("push/public-key", views.PublicKeyView.as_view()),
    path("push/subscriptions", views.SubscriptionsView.as_view()),
    path("push/preferences", views.PushPreferencesView.as_view()),
    path("push/devices", views.DevicesView.as_view()),
    path("admin/push/promotions", views.PromotionView.as_view()),
    path("admin/notifications/deliveries", views.AdminDeliveriesView.as_view()),
    path("admin/notifications/deliveries/<str:id>/retry", views.AdminDeliveryRetryView.as_view()),
]
