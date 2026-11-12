from django.urls import path

from . import views

urlpatterns = [
    path("my/restaurant/reviews/orders", views.ReviewOrdersView.as_view()),
    path("my/restaurant/reviews/orders/<str:order_id>", views.ReviewOrderView.as_view()),
    path("my/restaurant/reviews/summary", views.ReviewSummaryView.as_view()),
    path("my/restaurant/reviews/<str:id>/response", views.ReviewResponseView.as_view()),
]
