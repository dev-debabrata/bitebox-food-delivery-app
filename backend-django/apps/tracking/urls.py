from django.urls import path

from . import views

urlpatterns = [path("tracking/orders/<str:id>", views.OrderTrackingView.as_view())]
