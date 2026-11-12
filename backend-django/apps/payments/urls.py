from django.urls import path

from . import views

urlpatterns = [
    path("payments/methods", views.MethodsView.as_view()),
    path("payments/mine", views.MineView.as_view()),
    path("payments/orders/<str:order_id>/start", views.StartView.as_view()),
    path("payments/orders/<str:order_id>/confirm", views.ConfirmView.as_view()),
    path("payments/orders/<str:order_id>/abandon", views.AbandonView.as_view()),
    path("payments/orders/<str:order_id>/mock", views.MockView.as_view()),
    path("payments/webhooks/razorpay", views.RazorpayWebhookView.as_view()),
    path("admin/payments", views.AdminPaymentsView.as_view()),
    path("admin/payments/<str:id>", views.AdminPaymentView.as_view()),
    path("admin/payments/<str:id>/refund", views.AdminRetryRefundView.as_view()),
    path("admin/payments/<str:id>/refunds", views.AdminRefundView.as_view()),
    path("admin/refunds/<str:id>/paid", views.AdminManualRefundDoneView.as_view()),
]
