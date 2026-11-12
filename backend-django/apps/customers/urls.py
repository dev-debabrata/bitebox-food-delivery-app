from django.urls import path

from . import views

urlpatterns = [
    path("addresses", views.AddressesView.as_view()),
    path("addresses/<str:id>", views.AddressView.as_view()),
    path("addresses/<str:id>/default", views.DefaultAddressView.as_view()),
]
