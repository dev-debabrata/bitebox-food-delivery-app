from django.urls import path

from . import views

urlpatterns = [
    path("categories", views.CategoriesView.as_view()),
    path("foods", views.FoodSearchView.as_view()),
    path("foods/<str:id>", views.FoodDetailView.as_view()),
    path("my/restaurant/foods", views.MyFoodsView.as_view()),
    path("my/restaurant/foods/<str:id>", views.MyFoodView.as_view()),
    path("my/restaurant/foods/<str:id>/availability", views.MyFoodAvailabilityView.as_view()),
    path("admin/categories", views.AdminCategoriesView.as_view()),
    path("admin/categories/<str:id>", views.AdminCategoryView.as_view()),
    path("admin/foods", views.AdminFoodsView.as_view()),
    path("admin/foods/<str:id>", views.AdminFoodView.as_view()),
    path("admin/foods/<str:id>/availability", views.AdminFoodAvailabilityView.as_view()),
]
