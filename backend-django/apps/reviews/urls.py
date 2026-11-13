from django.urls import path

from . import views, views_admin, views_customer

urlpatterns = [
    # Public
    path("restaurants/<str:slug_or_id>/reviews", views_customer.RestaurantReviewsView.as_view()),
    path("foods/<str:id>/reviews", views_customer.FoodReviewsView.as_view()),
    # Customer
    path("orders/<str:id>/reviews", views_customer.OrderReviewsView.as_view()),
    path("reviews", views_customer.ReviewsView.as_view()),
    path("reviews/mine", views_customer.MyReviewsView.as_view()),
    path("reviews/<str:id>", views_customer.ReviewView.as_view()),
    path("reviews/<str:id>/reports", views_customer.ReviewReportsView.as_view()),
    # Restaurant partner
    path("my/restaurant/reviews/orders", views.ReviewOrdersView.as_view()),
    path("my/restaurant/reviews/orders/<str:order_id>", views.ReviewOrderView.as_view()),
    path("my/restaurant/reviews/summary", views.ReviewSummaryView.as_view()),
    path("my/restaurant/reviews/<str:id>/response", views.ReviewResponseView.as_view()),
    # Admin (fixed paths before /<id>)
    path("admin/reviews/orders", views_admin.AdminReviewOrdersView.as_view()),
    path("admin/reviews/orders/<str:order_id>", views_admin.AdminReviewOrderView.as_view()),
    path("admin/reviews/analytics", views_admin.AdminReviewAnalyticsView.as_view()),
    path("admin/reviews/<str:id>", views_admin.AdminReviewView.as_view()),
    path("admin/reviews/<str:id>/moderation", views_admin.AdminReviewModerationView.as_view()),
    path("admin/reviews/<str:id>/reports/dismiss", views_admin.AdminReviewDismissView.as_view()),
]
