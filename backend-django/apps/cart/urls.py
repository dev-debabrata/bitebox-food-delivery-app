from django.urls import path

from . import views

urlpatterns = [
    path("cart", views.CartView.as_view()),
    path("cart/items", views.CartItemsView.as_view()),
    path("cart/items/<str:food_item_id>", views.CartItemView.as_view()),
    path("cart/coupon", views.CartCouponView.as_view()),
    path("cart/coins", views.CartCoinsView.as_view()),
]
