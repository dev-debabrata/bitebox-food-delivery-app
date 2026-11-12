from django.urls import path

from . import views

urlpatterns = [
    path("coupons/available", views.AvailableView.as_view()),
    path("admin/coupons", views.AdminCouponsView.as_view()),
    path("admin/coupons/<str:id>", views.AdminCouponView.as_view()),
]
