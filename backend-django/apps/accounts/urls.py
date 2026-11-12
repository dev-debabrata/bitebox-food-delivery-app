from django.urls import path

from . import views, views_admin

auth_urls = [
    path("auth/register", views.RegisterView.as_view()),
    path("auth/login", views.LoginView.as_view()),
    path("auth/refresh", views.RefreshView.as_view()),
    path("auth/logout", views.LogoutView.as_view()),
    path("auth/forgot-password", views.ForgotPasswordView.as_view()),
    path("auth/reset-password", views.ResetPasswordView.as_view()),
    path("auth/me", views.MeView.as_view()),
    path("auth/change-password", views.ChangePasswordView.as_view()),
]

admin_urls = [
    path("admin/users", views_admin.MembersView.as_view()),
    path("admin/users/<str:id>/status", views_admin.MemberStatusView.as_view()),
    path("admin/users/<str:id>/logins", views_admin.MemberLoginsView.as_view()),
    path("admin/admins", views_admin.StaffListView.as_view()),
    path("admin/admins/<str:id>", views_admin.StaffDetailView.as_view()),
    path("admin/admins/<str:id>/status", views_admin.StaffStatusView.as_view()),
    path("admin/admins/<str:id>/logins", views_admin.StaffLoginsView.as_view()),
    path("admin/audit-logs", views_admin.AuditLogView.as_view()),
]

urlpatterns = auth_urls + admin_urls
