from django.urls import path

from . import views

urlpatterns = [
    path("kyc", views.MyKycView.as_view()),
    path("kyc/documents", views.MyDocumentsView.as_view()),
    path("kyc/documents/<str:id>", views.MyDocumentView.as_view()),
    path("kyc/documents/<str:id>/file", views.MyDocumentFileView.as_view()),
    path("kyc/payout-account", views.MyPayoutAccountView.as_view()),
    path("admin/kyc/partners/<str:id>", views.AdminPartnerKycView.as_view()),
    path("admin/kyc/documents/<str:id>", views.AdminDocumentView.as_view()),
    path("admin/kyc/documents/<str:id>/file", views.AdminDocumentFileView.as_view()),
]
