"""Saved delivery addresses, always scoped to their owner (Node: services/address.service.js)."""

import uuid
from typing import Any

from django.db import transaction

from apps.accounts.models import User
from apps.restaurants.presenters import geo_json
from common.api import ApiError
from common.geo import GeoPoint

from .models import MAX_ADDRESSES_PER_USER, Address

FIELDS = (
    "label",
    "recipient_name",
    "phone",
    "line1",
    "line2",
    "area",
    "landmark",
    "city",
    "state",
    "postal_code",
)


def address_json(a: Address) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": str(a.pk),
        "user": str(a.user_id),
        "label": a.label,
        "recipient_name": a.recipient_name,
        "phone": a.phone,
        "line1": a.line1,
        "city": a.city,
        "state": a.state,
        "postal_code": a.postal_code,
        "location": geo_json(a.location),
        "is_default": a.is_default,
        "created_at": a.created_at,
        "updated_at": a.updated_at,
    }
    for optional in ("line2", "area", "landmark"):
        if value := getattr(a, optional):
            data[optional] = value
    return data


def _apply(address: Address, data: dict[str, Any]) -> None:
    for field in FIELDS:
        if field in data:
            optional = field in ("line2", "area", "landmark")
            setattr(address, field, (data[field] or "") if optional else data[field])
    if location := data.get("location"):
        address.location = GeoPoint(lat=location["latitude"], lng=location["longitude"])


def list_for(user: User) -> list[Address]:
    return list(Address.objects.filter(user=user).order_by("-is_default", "-updated_at"))


def get_own(user: User, address_id: uuid.UUID) -> Address:
    address = Address.objects.filter(pk=address_id, user=user).first()
    if address is None:
        raise ApiError.not_found("Address not found")
    return address


@transaction.atomic
def create(user: User, data: dict[str, Any]) -> Address:
    count = Address.objects.select_for_update().filter(user=user).count()
    if count >= MAX_ADDRESSES_PER_USER:
        raise ApiError.conflict(f"You can save up to {MAX_ADDRESSES_PER_USER} addresses")
    make_default = count == 0 or data.get("is_default") is True
    if make_default:
        Address.objects.filter(user=user, is_default=True).update(is_default=False)
    address = Address(user=user, is_default=make_default)
    _apply(address, data)
    address.save()
    return address


def update(user: User, address_id: uuid.UUID, data: dict[str, Any]) -> Address:
    address = get_own(user, address_id)
    _apply(address, data)
    address.save()
    if data.get("is_default") is True:
        return set_default(user, address_id)
    return address


@transaction.atomic
def set_default(user: User, address_id: uuid.UUID) -> Address:
    address = get_own(user, address_id)
    Address.objects.filter(user=user, is_default=True).exclude(pk=address.pk).update(
        is_default=False
    )
    address.is_default = True
    address.save()
    return address


@transaction.atomic
def remove(user: User, address_id: uuid.UUID) -> None:
    address = get_own(user, address_id)
    was_default = address.is_default
    address.delete()
    if was_default:
        nxt = Address.objects.filter(user=user).order_by("-updated_at").first()
        if nxt is not None:
            Address.objects.filter(pk=nxt.pk).update(is_default=True)
