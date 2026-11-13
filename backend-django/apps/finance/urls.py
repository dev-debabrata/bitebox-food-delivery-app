from django.urls import path

from apps.rbac.roles import Role
from common.permissions import role_required

from . import views

RESTAURANT = [role_required(Role.RESTAURANT)]
RIDER = [role_required(Role.DELIVERY)]

urlpatterns = [
    path("my/restaurant/earnings", views.RestaurantEarningsView.as_view()),
    path("admin/reports", views.AdminReportsView.as_view()),
    # Admin finance (Node parity) and Phase 15
    path("admin/finance/dashboard", views.FinanceDashboardView.as_view()),
    path("admin/finance/transactions/<str:id>", views.TransactionView.as_view()),
    path("admin/finance/commission", views.CommissionReportView.as_view()),
    path("admin/finance/commission/rules", views.CommissionRulesView.as_view()),
    path("admin/finance/commission/rules/<str:id>", views.CommissionOverrideView.as_view()),
    path("admin/finance/refunds", views.RefundQueueView.as_view()),
    path("admin/finance/payouts/due", views.PayoutsDueView.as_view()),
    path("admin/finance/payouts", views.PayoutsView.as_view()),
    path("admin/finance/payouts/<str:id>/paid", views.PayoutPaidView.as_view()),
    path("admin/finance/payouts/<str:id>/cancel", views.PayoutCancelView.as_view()),
    path("admin/finance/payouts/<str:id>/statement", views.AdminStatementView.as_view()),
    path("admin/finance/ledger", views.LedgerView.as_view()),
    path("admin/finance/settlements.csv", views.SettlementsCsvView.as_view()),
    path("admin/orders/<str:id>/invoice", views.AdminOrderInvoiceView.as_view()),
    # Customers and partners
    path("orders/<str:id>/invoice", views.OrderInvoiceView.as_view()),
    # Each prefix belongs to one partner role (as in Node), so a rider never calls /my/restaurant.
    path("my/restaurant/payouts", views.MyPayoutsView.as_view(permission_classes=RESTAURANT)),
    path(
        "my/restaurant/payouts/<str:id>/statement",
        views.MyStatementView.as_view(permission_classes=RESTAURANT),
    ),
    path(
        "my/restaurant/settlements", views.MySettlementsView.as_view(permission_classes=RESTAURANT)
    ),
    path("delivery/payouts", views.MyPayoutsView.as_view(permission_classes=RIDER)),
    path(
        "delivery/payouts/<str:id>/statement",
        views.MyStatementView.as_view(permission_classes=RIDER),
    ),
    path("delivery/settlements", views.MySettlementsView.as_view(permission_classes=RIDER)),
]
