"""
The rider's side (Node: services/delivery-partner.service.js): profile, vehicle, going online
and offline, position reports, and the admin list of riders.
"""

import contextlib
import uuid
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import RevokedReason, User, UserStatus
from apps.accounts.serializers import user_json
from apps.accounts.services import end_sessions
from apps.kyc import services as kyc
from apps.notifications.services import notify, notify_admins
from apps.orders import presenters
from apps.orders.models import Order, OrderStatus
from apps.rbac.roles import Permission, Role
from apps.restaurants.presenters import geo_json, rating_json
from common.api import ApiError
from common.geo import GeoPoint, haversine_m
from common.pagination import Page, paginate

from .models import VERIFICATION_TRANSITIONS, DeliveryPartner, RiderVehicle, VerificationStatus

V = VerificationStatus
# (notification type, title, body) per decision.
VERIFICATION_NOTICE = {
    V.APPROVED: ("rider.verified", "You are verified", "You can go online and start delivering."),
    V.REJECTED: (
        "rider.rejected",
        "Your verification was not approved",
        "See the reason on the Verification page.",
    ),
    V.RESUBMISSION_REQUESTED: (
        "rider.documents_needed",
        "Please update your documents",
        "Fix what is asked on the Verification page, then send it for review again.",
    ),
}


def get_or_create_profile(user: User) -> DeliveryPartner:
    """The rider's profile, created on first use."""
    profile = DeliveryPartner.objects.select_related("vehicle").filter(user=user).first()
    if profile:
        return profile
    try:
        with transaction.atomic():
            return DeliveryPartner.objects.create(user=user)
    except IntegrityError:  # created concurrently
        return DeliveryPartner.objects.get(user=user)


def _vehicle(profile: DeliveryPartner) -> RiderVehicle | None:
    try:
        return profile.vehicle
    except RiderVehicle.DoesNotExist:
        return None


def profile_json(profile: DeliveryPartner) -> dict[str, Any]:
    vehicle = _vehicle(profile)
    data: dict[str, Any] = {
        "id": str(profile.pk),
        "user": str(profile.user_id),
        "is_online": profile.is_online,
        "current_offer": str(profile.current_offer_id) if profile.current_offer_id else None,
        "active_order": str(profile.active_order_id) if profile.active_order_id else None,
        "last_assigned_at": profile.last_assigned_at,
        "completed_deliveries": profile.completed_deliveries,
        "rating": rating_json(profile),
        "address": profile.address,
        "verification": {
            "status": profile.verification_status,
            "reason": profile.verification_reason or None,
            "verified_at": profile.verified_at,
        },
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }
    if vehicle:
        data["vehicle_type"] = vehicle.vehicle_type
        if vehicle.vehicle_number:
            data["vehicle_number"] = vehicle.vehicle_number
    if profile.location:
        data["location"] = geo_json(profile.location)
    if profile.location_updated_at:
        data["location_updated_at"] = profile.location_updated_at
    if profile.location_accuracy_m is not None:
        data["location_accuracy"] = profile.location_accuracy_m
    return data


def dashboard(user: User) -> dict[str, Any]:
    """Profile + the offer waiting for them + the order they carry: the whole dashboard."""
    from apps.dispatch.models import AssignmentStatus

    profile = get_or_create_profile(user)
    profile.refresh_from_db()
    offer = (
        presenters.with_details(
            Order.objects.filter(
                pk=profile.current_offer_id,
                status=OrderStatus.READY_FOR_PICKUP,
                assignments__rider=user,
                assignments__status=AssignmentStatus.OFFERED,
            )
        ).first()
        if profile.current_offer_id
        else None
    )
    active = (
        presenters.load(profile.active_order_id, delivery_partner=user)
        if profile.active_order_id
        else None
    )
    offer_json = presenters.present_for_rider(offer, user.pk) if offer else None
    if offer is not None and offer_json is not None:
        offer_json["pickup_distance_meters"] = _pickup_distance(profile, offer)
    return {
        "profile": profile_json(
            DeliveryPartner.objects.select_related("vehicle").get(pk=profile.pk)
        ),
        "offer": offer_json,
        "active_order": presenters.present_for_rider(active, user.pk) if active else None,
    }


def _pickup_distance(profile: DeliveryPartner, order: Order) -> int | None:
    """Straight-line metres from the rider's last GPS fix to the restaurant (None without a fix)."""
    coordinates = ((order.restaurant_snapshot or {}).get("location") or {}).get("coordinates")
    if profile.location is None or not coordinates:
        return None
    return haversine_m(profile.location, GeoPoint(lat=coordinates[1], lng=coordinates[0]))


def update_vehicle(user: User, vehicle_type: str, vehicle_number: str | None) -> dict[str, Any]:
    profile = get_or_create_profile(user)
    RiderVehicle.objects.update_or_create(
        partner=profile,
        defaults={
            "vehicle_type": vehicle_type,
            "vehicle_number": (vehicle_number or "").strip().upper(),
        },
    )
    profile.save(update_fields=["updated_at"])
    return profile_json(DeliveryPartner.objects.select_related("vehicle").get(pk=profile.pk))


def set_availability(
    user: User, is_online: bool, latitude: float | None, longitude: float | None
) -> dict[str, Any]:
    profile = get_or_create_profile(user)
    if is_online:
        if settings.RIDER_KYC_REQUIRED and profile.verification_status != V.APPROVED:
            raise ApiError(
                403,
                "BiteBox is still verifying your documents. You can go online once approved.",
                code="RIDER_NOT_VERIFIED",
            )
        if _vehicle(profile) is None:
            raise ApiError.bad_request("Add your vehicle details before going online")
        if latitude is None or longitude is None:
            raise ApiError.bad_request("Share your location to go online")
        now = timezone.now()
        DeliveryPartner.objects.filter(pk=profile.pk).update(
            is_online=True,
            location=GeoPoint(lat=latitude, lng=longitude),
            location_updated_at=now,
            updated_at=now,
        )
        _offer_waiting_orders()
        return dashboard(user)
    take_offline(user, profile, "Finish your current delivery before going offline")
    return dashboard(user)


def take_offline(user: User, profile: DeliveryPartner | None, busy_message: str) -> None:
    """Offline rules shared by the rider and admins: never mid-delivery; an offer is passed on."""
    from apps.dispatch.services import decline_offer

    if profile is None:
        return
    profile.refresh_from_db()
    if profile.active_order_id:
        raise ApiError(409, busy_message, code="DELIVERY_IN_PROGRESS")
    if profile.current_offer_id:
        with contextlib.suppress(ApiError):
            decline_offer(user.pk, profile.current_offer_id)
    DeliveryPartner.objects.filter(pk=profile.pk).update(
        is_online=False, current_offer=None, updated_at=timezone.now()
    )


def update_location(user: User, latitude: float, longitude: float) -> dict[str, Any]:
    """A position report from the rider's device (rate limited at the view)."""
    now = timezone.now()
    updated = DeliveryPartner.objects.filter(user=user, is_online=True).update(
        location=GeoPoint(lat=latitude, lng=longitude), location_updated_at=now, updated_at=now
    )
    if not updated:
        raise ApiError(409, "Go online to share your location", code="OFFLINE")
    from apps.tracking.services import on_position, tracked_order_id

    if order_id := tracked_order_id(user.pk):
        on_position(user.pk, order_id, latitude, longitude, None, now)
    return {"location_updated_at": now}


def _offer_waiting_orders() -> None:
    """A rider just became available: give waiting orders a chance straight away."""
    from apps.dispatch.services import dispatch_safely, waiting_orders

    for order in waiting_orders(5):
        if dispatch_safely(order.pk):
            break  # one offer per rider at a time


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    users = User.objects.filter(role=Role.DELIVERY)
    if search := (query.get("search") or "").strip():
        users = users.filter(
            Q(name__icontains=search) | Q(email__icontains=search) | Q(phone__icontains=search)
        )
    if query.get("online") is True:
        users = users.filter(delivery_partner__is_online=True)
    if verification := query.get("verification"):
        users = users.filter(delivery_partner__verification_status=verification)
    rows, meta = paginate(users.order_by("-created_at"), page)
    profiles = {
        p.user_id: p
        for p in DeliveryPartner.objects.select_related("vehicle", "active_order").filter(
            user__in=rows
        )
    }
    items = []
    for u in rows:
        p = profiles.get(u.pk)
        vehicle = _vehicle(p) if p else None
        active = p.active_order if p else None
        items.append(
            {
                **user_json(u),
                "vehicle_type": vehicle.vehicle_type if vehicle else None,
                "vehicle_number": (vehicle.vehicle_number or None) if vehicle else None,
                "is_online": p.is_online if p else False,
                "verification_status": p.verification_status if p else V.PENDING,
                "location_updated_at": p.location_updated_at if p else None,
                "completed_deliveries": p.completed_deliveries if p else 0,
                "rating": rating_json(p) if p else None,
                "active_order": {
                    "id": str(active.pk),
                    "order_number": active.order_number,
                    "status": active.status,
                }
                if active
                else None,
            }
        )
    return {"items": items, "pagination": meta}


def admin_set_status(user_id: uuid.UUID, status: str) -> User:
    """Suspend or reactivate a rider. Suspending takes them offline; not allowed mid-delivery."""
    user = User.objects.filter(pk=user_id, role=Role.DELIVERY).first()
    if user is None:
        raise ApiError.not_found("Delivery partner not found")
    if status == UserStatus.SUSPENDED:
        take_offline(
            user,
            DeliveryPartner.objects.filter(user=user).first(),
            "This rider is carrying an order. Unassign or finish it first.",
        )
    user.status = status
    end_sessions(
        user,
        RevokedReason.SUSPENDED if status == UserStatus.SUSPENDED else RevokedReason.LOGOUT,
        fields=("status",),
    )
    return user


# --- verification ---------------------------------------------------------------------------------


def update_details(user: User, address: dict[str, Any]) -> dict[str, Any]:
    profile = get_or_create_profile(user)
    profile.address = address
    profile.save(update_fields=["address", "updated_at"])
    return profile_json(profile)


def resubmit(user: User) -> dict[str, Any]:
    """The rider fixed what was asked: back to the review queue."""
    profile = get_or_create_profile(user)
    if profile.verification_status not in (V.REJECTED, V.RESUBMISSION_REQUESTED):
        raise ApiError.conflict("Your verification is not waiting for changes")
    profile.verification_status, profile.verification_reason = V.PENDING, ""
    profile.save(update_fields=["verification_status", "verification_reason", "updated_at"])
    notify_admins(
        Permission.RIDERS_MANAGE,
        type="rider.review",
        title=f"Rider resubmitted: {user.name}",
        body="Their documents are ready for another look.",
        link=f"/admin/delivery-partners/{user.pk}",
    )
    return profile_json(profile)


def verification_gaps(user: User, profile: DeliveryPartner) -> list[str]:
    """What stops approval (RIDER_KYC_REQUIRED): documents, bank account, address."""
    if not settings.RIDER_KYC_REQUIRED:
        return []
    return kyc.missing(user) + ([] if profile.address else ["Address"])


def admin_get(user_id: uuid.UUID) -> dict[str, Any]:
    user = User.objects.filter(pk=user_id, role=Role.DELIVERY).first()
    if user is None:
        raise ApiError.not_found("Delivery partner not found")
    return {"user": user_json(user), "profile": profile_json(get_or_create_profile(user))}


def admin_set_verification(
    user_id: uuid.UUID, status: str, reason: str, admin: User
) -> dict[str, Any]:
    user = User.objects.filter(pk=user_id, role=Role.DELIVERY).first()
    if user is None:
        raise ApiError.not_found("Delivery partner not found")
    profile = get_or_create_profile(user)
    current = profile.verification_status
    if status not in VERIFICATION_TRANSITIONS.get(current, frozenset()):
        raise ApiError.conflict(f"Cannot change a {current} rider to {status}")
    if status != V.APPROVED and not reason:
        raise ApiError.bad_request("A reason is required")
    if status == V.APPROVED and (gaps := verification_gaps(user, profile)):
        raise ApiError.conflict(
            "Finish the verification first: " + ", ".join(gaps), code="KYC_INCOMPLETE"
        )
    with transaction.atomic():
        changed = DeliveryPartner.objects.filter(pk=profile.pk, verification_status=current).update(
            verification_status=status,
            verification_reason=reason if status != V.APPROVED else "",
            verified_at=timezone.now(),
            verified_by=admin,
            updated_at=timezone.now(),
        )
        if not changed:
            raise ApiError.conflict(
                "This rider was updated by someone else. Refresh and try again."
            )
    if status != V.APPROVED:  # no longer allowed online
        with contextlib.suppress(ApiError):
            take_offline(user, DeliveryPartner.objects.get(pk=profile.pk), "")
    kind, title, body = VERIFICATION_NOTICE[V(status)]
    notify(
        user.pk,
        type=kind,
        title=title,
        body=f"{body} Reason: {reason}" if reason and status != V.APPROVED else body,
        link="/delivery/verification",
    )
    return admin_get(user_id)
