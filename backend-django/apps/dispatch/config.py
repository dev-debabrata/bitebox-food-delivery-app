"""Dispatch and timeout tunables (Node: config/dispatch.js)."""

DISPATCH = {
    "offer_timeout_seconds": 90,  # a rider has this long to accept an offer
    "max_pickup_distance_km": 10,  # riders farther than this from the restaurant are not offered
    "location_fresh_minutes": 15,  # riders whose last GPS fix is older are skipped
    "payment_window_minutes": 15,  # unpaid online orders are cancelled after this
    "restaurant_response_minutes": 10,  # pending orders are auto-rejected after this
    "pickup_window_minutes": 30,  # ready orders nobody picked up are cancelled after this
    "sweep_interval_seconds": 15,  # Celery Beat runs the sweep this often
}

# Riders within the same 500 m band count as equally near; the one idle longest goes first.
DISTANCE_BAND_M = 500
