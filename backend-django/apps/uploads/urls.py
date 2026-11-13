from django.urls import path

from . import views

urlpatterns = [
    path("uploads/images", views.ImageUploadView.as_view()),
    path("uploads/review-images", views.ReviewImageUploadView.as_view()),
    path("uploads/avatars", views.AvatarUploadView.as_view()),
]
