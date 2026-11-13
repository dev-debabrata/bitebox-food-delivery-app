from django.urls import path

from . import views

urlpatterns = [
    path("newsletter/subscriptions", views.SubscriptionsView.as_view()),
]
