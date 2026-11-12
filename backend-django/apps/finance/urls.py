from django.urls import path

from . import views

urlpatterns = [
    path("my/restaurant/earnings", views.RestaurantEarningsView.as_view()),
    path("admin/reports", views.AdminReportsView.as_view()),
]
