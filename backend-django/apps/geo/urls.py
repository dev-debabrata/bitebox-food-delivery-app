from django.urls import path

from . import views

urlpatterns = [
    path("geo/search", views.SearchView.as_view()),
    path("geo/reverse", views.ReverseView.as_view()),
    path("geo/route", views.RouteView.as_view()),
]
