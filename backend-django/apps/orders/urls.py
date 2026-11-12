from django.urls import path

from . import views, views_operations

urlpatterns = [
    path("orders", views.OrdersView.as_view()),
    path("orders/<str:id>", views.OrderView.as_view()),
    path("orders/<str:id>/cancel", views.OrderCancelView.as_view()),
    path("orders/<str:id>/timeline", views.OrderTimelineView.as_view()),
    path("my/restaurant/orders", views.MyOrdersView.as_view()),
    path("my/restaurant/stats", views.MyStatsView.as_view()),
    path("my/restaurant/orders/<str:id>", views.MyOrderView.as_view()),
    path("my/restaurant/orders/<str:id>/status", views.MyOrderStatusView.as_view()),
    path("admin/dashboard", views_operations.AdminDashboardView.as_view()),
    path("admin/operations/dashboard", views_operations.OperationsDashboardView.as_view()),
    path("admin/operations/monitoring", views_operations.OperationsMonitoringView.as_view()),
    path("admin/operations/restaurants", views_operations.OperationsRestaurantsView.as_view()),
    path("admin/operations/performance", views_operations.OperationsPerformanceView.as_view()),
    path("admin/orders", views.AdminOrdersView.as_view()),
    path("admin/orders/<str:id>", views.AdminOrderView.as_view()),
    path("admin/orders/<str:id>/cancel", views.AdminOrderCancelView.as_view()),
    path("admin/orders/<str:id>/unassign", views.AdminOrderUnassignView.as_view()),
    path("admin/orders/<str:id>/assign", views.AdminOrderAssignView.as_view()),
    path("admin/orders/<str:id>/delivery-code", views.AdminOrderDeliveryCodeView.as_view()),
    path("admin/orders/<str:id>/timeline", views.AdminOrderTimelineView.as_view()),
]
