from django.urls import path

from . import views

urlpatterns = [
    path("restaurants", views.PublicListView.as_view()),
    path("restaurants/cuisines", views.CuisinesView.as_view()),
    path("restaurants/<str:slug_or_id>", views.PublicDetailView.as_view()),
    path("restaurants/<str:slug_or_id>/menu", views.PublicMenuView.as_view()),
    path("my/restaurant", views.MyRestaurantView.as_view()),
    path("my/restaurant/accepting-orders", views.AcceptingOrdersView.as_view()),
    path("my/restaurant/resubmit", views.ResubmitView.as_view()),
    path("admin/restaurants", views.AdminListView.as_view()),
    path("admin/restaurants/counts", views.AdminCountsView.as_view()),
    path("admin/restaurants/<str:id>", views.AdminDetailView.as_view()),
    path("admin/restaurants/<str:id>/status", views.AdminStatusView.as_view()),
]
