from django.urls import path

from apps.realtime.consumers import RealtimeConsumer

websocket_urlpatterns = [path("ws/", RealtimeConsumer.as_asgi())]
