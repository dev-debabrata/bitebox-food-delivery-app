from django.urls import path

from . import views_admin, views_customer

urlpatterns = [
    # Customers, restaurants and riders
    path("support/tickets", views_customer.MyTicketsView.as_view()),
    path("support/tickets/<str:id>", views_customer.MyTicketView.as_view()),
    path("support/tickets/<str:id>/messages", views_customer.MyTicketMessagesView.as_view()),
    # Support staff
    path("admin/support/dashboard", views_admin.SupportDashboardView.as_view()),
    path("admin/support/staff", views_admin.SupportStaffView.as_view()),
    path("admin/support/tickets", views_admin.SupportTicketsView.as_view()),
    path("admin/support/tickets/<str:id>", views_admin.SupportTicketView.as_view()),
    path(
        "admin/support/tickets/<str:id>/messages", views_admin.SupportTicketMessagesView.as_view()
    ),
    path(
        "admin/support/tickets/<str:id>/escalate", views_admin.SupportTicketEscalateView.as_view()
    ),
]
