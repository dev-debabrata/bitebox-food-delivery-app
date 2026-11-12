"""
Every payment state change (Node: services/payments/payment.service.js), plus partial refunds,
refund status and reconciliation from the master prompt §9.

- Online orders stay invisible to the restaurant (`submitted_at` null) until paid. Payment is
  confirmed only server-side: the checkout signature and the payment fetched from the gateway,
  or a signed webhook. The browser's "success" is never trusted.
- Each webhook event id is applied once (`WebhookEvent` row, unique per provider).
- Refunds are rows. Opening one reserves its amount on `Payment.refunded_paise` (a CHECK caps it
  at the amount paid) inside the caller's transaction; the gateway is called after commit, never
  while rows are locked. A lost call is picked up by `reconcile()`.
"""

import functools
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import F, Q, Sum
from django.utils import timezone

from apps.accounts.models import User
from apps.cart.models import Cart, CartItem
from apps.menus.models import FoodItem
from apps.orders import presenters
from apps.orders.models import Order, OrderStatus, PaymentMethod, PaymentStatus
from apps.orders.notifications import notify_new_order, notify_refund
from apps.orders.notifications import rupees as _rupees
from apps.orders.workflow import Actor, transition
from apps.realtime.events import emit_order_updated
from common.api import ApiError
from common.pagination import Page, paginate

from .models import Payment, Provider, Refund, RefundStatus, WebhookEvent
from .providers import online_provider, provider_named

logger = logging.getLogger("bitebox.payments")

P = PaymentStatus
R = RefundStatus
S = OrderStatus
CLOSED = (S.CANCELLED, S.REJECTED)
REFUNDABLE = (P.PAID, P.PARTIALLY_REFUNDED)
REFUND_DONE = (R.PROCESSED, R.MANUAL_DONE)
REFUND_FAILED_NOTE = "Refund failed; retry from the admin panel"

# Reconciliation (Celery Beat `payments.reconcile`).
RECONCILE_AFTER = timedelta(minutes=2)  # give the browser and the webhook a head start
RECONCILE_WINDOW = timedelta(hours=24)
REFUND_CHECK_AFTER = timedelta(minutes=5)


def _conflict(message: str, code: str) -> ApiError:
    return ApiError(409, message, code=code)


def _unavailable(message: str) -> ApiError:
    return ApiError(503, message, code="PAYMENT_UNAVAILABLE")


# ---------------------------------------------------------------------------
# Methods and checkout
# ---------------------------------------------------------------------------
def available_methods() -> list[dict[str, Any]]:
    methods: list[dict[str, Any]] = [
        {
            "method": PaymentMethod.COD.value,
            "label": "Cash on delivery",
            "provider": Provider.CASH_ON_DELIVERY.value,
            "simulated": False,
        }
    ]
    online = online_provider()
    if online is not None:
        methods.append(
            {
                "method": PaymentMethod.ONLINE.value,
                "label": online.label,
                "provider": online.name,
                "simulated": online.simulated,
            }
        )
    return methods


def provider_for(method: str) -> str:
    """Provider stored on a new order's payment record."""
    if method == PaymentMethod.COD:
        return Provider.CASH_ON_DELIVERY.value
    online = online_provider()
    if online is None:
        raise ApiError.bad_request("Online payment is not available right now")
    return str(online.name)


def _load_for_customer(user: User, order_id: uuid.UUID) -> tuple[Order, Payment]:
    order = Order.objects.filter(pk=order_id, customer=user).first()
    if order is None:
        raise ApiError.not_found("Order not found")
    payment = Payment.objects.filter(order=order).first()
    if payment is None or payment.method != PaymentMethod.ONLINE:
        raise ApiError.bad_request("This order is paid in cash on delivery")
    return order, payment


def _checkout_info(order: Order, payment: Payment) -> dict[str, Any]:
    online = online_provider()
    return {
        "provider": payment.provider,
        "simulated": payment.provider == Provider.MOCK,
        "key_id": online.key_id if online is not None else None,  # the public key only
        "provider_order_id": payment.provider_order_id,
        "amount_paise": payment.amount_paise,
        "currency": payment.currency,
        "order_number": order.order_number,
    }


def start_payment(user: User, order_id: uuid.UUID) -> dict[str, Any]:
    """Creates (or reuses) the gateway order and returns the checkout details. Safe to repeat."""
    order, payment = _load_for_customer(user, order_id)
    if payment.status == P.PAID:
        raise _conflict("This order is already paid", "ALREADY_PAID")
    if order.status != S.PENDING:
        raise _conflict("This order can no longer be paid", "PAYMENT_CLOSED")
    online = online_provider()
    if online is None or online.name != payment.provider:
        raise _unavailable("Online payment is not available right now")

    if not payment.provider_order_id:
        try:
            created = online.create_order(
                payment.amount_paise, order.order_number, {"orderId": str(order.pk)}
            )
        except Exception:
            logger.exception("Could not create gateway order", extra={"order_id": str(order.pk)})
            raise _unavailable("The payment gateway is not responding. Please try again.") from None
        # Two tabs may start at once: the first gateway order wins, the other is never used.
        Payment.objects.filter(pk=payment.pk, provider_order_id__isnull=True).update(
            provider_order_id=created, updated_at=timezone.now()
        )
        payment.refresh_from_db()
    return _checkout_info(order, payment)


def confirm_payment(
    user: User, order_id: uuid.UUID, provider_payment_id: str, signature: str
) -> dict[str, Any]:
    """
    The browser reports a finished Razorpay checkout. Checked twice: the HMAC signature, then the
    payment itself as the gateway reports it (status, amount, order).
    """
    _, payment = _load_for_customer(user, order_id)
    if payment.status == P.PAID:
        return payment_view(payment)  # duplicate callback
    online = online_provider()
    if payment.provider != Provider.RAZORPAY or online is None or online.name != Provider.RAZORPAY:
        raise ApiError.bad_request("This payment is not a Razorpay payment")
    if not payment.provider_order_id or not online.verify_checkout_signature(
        payment.provider_order_id, provider_payment_id, signature
    ):
        raise ApiError(400, "Payment could not be verified", code="SIGNATURE_INVALID")
    try:
        remote = online.fetch_payment(provider_payment_id)
    except Exception:
        logger.exception("Could not fetch payment from Razorpay")
        raise _unavailable(
            "Could not confirm the payment yet. It will update automatically once confirmed."
        ) from None
    if (
        remote["provider_order_id"] != payment.provider_order_id
        or remote["amount_paise"] != payment.amount_paise
    ):
        raise ApiError(400, "Payment details do not match this order", code="PAYMENT_MISMATCH")
    if remote["status"] in ("captured", "authorized"):
        return payment_view(mark_paid(payment.pk, provider_payment_id))
    if remote["status"] == "failed":
        return payment_view(mark_failed(payment.pk, remote["failure_reason"]))
    return payment_view(payment)  # still processing: the webhook or reconciliation finishes it


def complete_mock_payment(user: User, order_id: uuid.UUID, outcome: str) -> dict[str, Any]:
    """Development only: finishes a simulated payment with the outcome the tester chose."""
    from django.conf import settings

    order, payment = _load_for_customer(user, order_id)
    if payment.provider != Provider.MOCK or not settings.PAYMENTS_MOCK_ENABLED:
        raise ApiError.bad_request("This is not a simulated payment")
    if order.status != S.PENDING and payment.status != P.PAID:
        raise _conflict("This order can no longer be paid", "PAYMENT_CLOSED")
    if not payment.provider_order_id:
        raise _conflict("Start the payment first", "PAYMENT_NOT_STARTED")
    if outcome == "success":
        updated = mark_paid(payment.pk, f"mock_pay_{payment.provider_order_id[-8:]}")
    else:
        updated = mark_failed(payment.pk, "Simulated failure")
    return payment_view(updated)


def abandon_unpaid(user: User, order_id: uuid.UUID) -> dict[str, bool]:
    """
    The customer closed the payment page: cancel the unpaid attempt and put the dishes back in
    the cart (only if the cart is empty, so nothing newer is overwritten).
    """
    order = Order.objects.filter(pk=order_id, customer=user).first()
    if order is None:
        raise ApiError.not_found("Order not found")
    if (
        order.payment_method != PaymentMethod.ONLINE
        or order.submitted_at is not None
        or order.payment_status == P.PAID
    ):
        raise _conflict("This order is already placed", "ORDER_PLACED")
    if order.status == S.PENDING:
        transition(
            order.pk,
            to=S.CANCELLED,
            actor=Actor.CUSTOMER,
            user=user,
            scope=Q(customer=user),
            where=Q(submitted_at__isnull=True),  # lost the race to a payment: leave it alone
            reason="Payment not completed",
        )
    lines = [
        (item.food_item_id, item.quantity)
        for item in order.items.all()
        if item.food_item_id is not None
    ]
    live = set(
        FoodItem.objects.filter(pk__in=[food for food, _ in lines]).values_list("pk", flat=True)
    )
    try:
        with transaction.atomic():
            cart, _ = Cart.objects.select_for_update().get_or_create(user=user)
            if cart.items.exists():
                return {"restored": False}
            cart.restaurant_id = order.restaurant_id
            cart.coupon_code = order.coupon_code
            cart.coins_to_redeem = 0
            cart.save()
            CartItem.objects.bulk_create(
                [CartItem(cart=cart, food_item_id=f, quantity=q) for f, q in lines if f in live]
            )
    except IntegrityError:  # another request created the cart at the same moment
        return {"restored": False}
    return {"restored": True}


# ---------------------------------------------------------------------------
# Paid / failed
# ---------------------------------------------------------------------------
def mark_paid(payment_id: uuid.UUID, provider_payment_id: str) -> Payment:
    """
    Pending/failed → paid, exactly once; the order then goes to the restaurant. A real payment
    can still arrive after the order closed (it expired while the customer was paying): it is
    recorded, then refunded straight away.
    """
    now = timezone.now()
    with transaction.atomic():
        changed = Payment.objects.filter(
            pk=payment_id, status__in=[P.PENDING, P.FAILED, P.CANCELLED]
        ).update(
            status=P.PAID,
            provider_payment_id=provider_payment_id,
            paid_at=now,
            failure_reason="",
            updated_at=now,
        )
        payment = Payment.objects.get(pk=payment_id)
        if not changed:
            return payment
        submitted = Order.objects.filter(
            pk=payment.order_id, status=S.PENDING, submitted_at__isnull=True
        ).update(payment_status=P.PAID, submitted_at=now, updated_at=now)
        if submitted:
            order = presenters.reload(Order(pk=payment.order_id))
            logger.info(
                "Online payment received; order sent to the restaurant",
                extra={"order_id": str(order.pk)},
            )
            notify_new_order(order, "paid online")
        else:
            Order.objects.filter(pk=payment.order_id).update(payment_status=P.PAID, updated_at=now)
            order = Order.objects.get(pk=payment.order_id)
            if order.status in CLOSED:
                _open_refund(
                    payment,
                    payment.amount_paise,
                    key=f"order-closed:{order.pk}",
                    reason="Paid after the order closed",
                )
    return Payment.objects.get(pk=payment_id)


def mark_failed(payment_id: uuid.UUID, reason: str | None) -> Payment:
    with transaction.atomic():
        failed = Payment.objects.filter(pk=payment_id, status=P.PENDING).update(
            status=P.FAILED, failure_reason=(reason or "Payment failed")[:300]
        )
        payment = Payment.objects.get(pk=payment_id)
        if failed:
            Order.objects.filter(pk=payment.order_id, payment_status=P.PENDING).update(
                payment_status=P.FAILED
            )
    return payment


def settle_cancelled_payment(order: Order) -> None:
    """
    An order was rejected or cancelled (called from the workflow, inside its transaction). A paid
    online payment is refunded in full (what is left of it), once; an unpaid one is closed.
    """
    payment = Payment.objects.filter(order=order).first()
    if payment is None:
        return
    if payment.method == PaymentMethod.ONLINE and payment.status in REFUNDABLE:
        remaining = payment.amount_paise - payment.refunded_paise
        if remaining > 0:
            _open_refund(
                payment,
                remaining,
                key=f"order-closed:{order.pk}",
                reason=f"Order {order.get_status_display().lower()}",
            )
        return
    unpaid = [P.PENDING, P.FAILED]
    Payment.objects.filter(pk=payment.pk, status__in=unpaid).update(
        status=P.CANCELLED, updated_at=timezone.now()
    )
    Order.objects.filter(pk=order.pk, payment_status__in=unpaid).update(payment_status=P.CANCELLED)


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------
def handle_razorpay_webhook(raw_body: bytes, signature: Any, event_id: Any) -> dict[str, bool]:
    """Signed over the raw body. Each event id is applied once; replays are acknowledged."""
    online = online_provider()
    if (
        online is None
        or online.name != Provider.RAZORPAY
        or not online.verify_webhook_signature(raw_body, signature)
    ):
        raise ApiError(400, "Invalid webhook signature", code="SIGNATURE_INVALID")
    try:
        event = json.loads(raw_body)
    except ValueError:
        raise ApiError.bad_request("Invalid webhook body") from None
    kind = str(event.get("event") or "")
    payload = event.get("payload") or {}
    if kind.startswith("refund."):
        return _refund_webhook(kind, (payload.get("refund") or {}).get("entity") or {}, event_id)

    entity = (payload.get("payment") or {}).get("entity") or {}
    if not entity.get("order_id"):
        return {"ignored": True}
    payment = Payment.objects.filter(
        provider=Provider.RAZORPAY, provider_order_id=entity["order_id"]
    ).first()
    if payment is None:
        return {"ignored": True}
    with transaction.atomic():  # a failure below also forgets the event, so a retry applies it
        if not _record_event(kind, entity, event_id, payment):
            return {"duplicate": True}
        if entity.get("amount") != payment.amount_paise:
            logger.warning(
                "Webhook amount does not match the order", extra={"payment_id": str(payment.pk)}
            )
            return {"ignored": True}
        if kind in ("payment.captured", "payment.authorized"):
            mark_paid(payment.pk, str(entity["id"]))
        elif kind == "payment.failed":
            mark_failed(payment.pk, entity.get("error_description"))
    return {"processed": True}


def _record_event(kind: str, entity: dict[str, Any], event_id: Any, payment: Payment) -> bool:
    """False when this event was applied before."""
    try:
        with transaction.atomic():
            WebhookEvent.objects.create(
                provider=Provider.RAZORPAY,
                event_id=str(event_id or f"{kind}:{entity.get('id')}")[:120],
                event_type=kind[:80],
                payment=payment,
                # Ids, amount and status only: no contact or card details are kept.
                payload={
                    k: entity.get(k)
                    for k in ("id", "order_id", "payment_id", "amount", "status")
                    if k in entity
                },
                processed_at=timezone.now(),
            )
    except IntegrityError:
        return False
    return True


def _refund_webhook(kind: str, entity: dict[str, Any], event_id: Any) -> dict[str, bool]:
    refund = (
        Refund.objects.select_related("payment").filter(provider_refund_id=entity.get("id")).first()
    )
    if refund is None:
        return {"ignored": True}
    with transaction.atomic():
        if not _record_event(kind, entity, event_id, refund.payment):
            return {"duplicate": True}
        if kind == "refund.processed":
            _finish_refund(refund, ok=True)
        elif kind == "refund.failed":
            _finish_refund(refund, ok=False)
    return {"processed": True}


# ---------------------------------------------------------------------------
# Refunds
# ---------------------------------------------------------------------------
def _open_refund(
    payment: Payment,
    amount_paise: int,
    *,
    key: str,
    reason: str,
    by: User | None = None,
) -> Refund:
    """
    Records a refund and reserves its amount (in the caller's transaction). Online refunds go to
    the gateway after commit; cash refunds wait for finance to pay them back by hand. A repeated
    `key` returns the first refund.
    """
    existing = Refund.objects.filter(idempotency_key=key).first()
    if existing is not None:
        return existing
    now = timezone.now()
    manual = payment.method == PaymentMethod.COD
    try:
        with transaction.atomic():
            reserved = Payment.objects.filter(
                pk=payment.pk,
                status__in=REFUNDABLE,
                refunded_paise__lte=F("amount_paise") - amount_paise,
            ).update(refunded_paise=F("refunded_paise") + amount_paise, updated_at=now)
            if not reserved:
                raise _conflict("That is more than is left to refund", "REFUND_TOO_LARGE")
            refund = Refund.objects.create(
                payment=payment,
                amount_paise=amount_paise,
                reason=reason[:300],
                idempotency_key=key,
                requested_by=by,
                status=R.MANUAL_PENDING if manual else R.PENDING,
            )
    except IntegrityError:  # the same key at the same moment: the other request's refund
        return Refund.objects.get(idempotency_key=key)
    if not manual:
        transaction.on_commit(lambda: process_refund(refund.pk))
    return refund


def process_refund(refund_id: uuid.UUID) -> None:
    """Sends a pending refund to the gateway. Never raises (it runs after commit)."""
    now = timezone.now()
    if not Refund.objects.filter(pk=refund_id, status=R.PENDING).update(
        status=R.PROCESSING, updated_at=now
    ):
        return  # someone else took it
    refund = Refund.objects.select_related("payment").get(pk=refund_id)
    payment = refund.payment
    try:
        provider = provider_named(payment.provider)
        if provider is None or not payment.provider_payment_id:
            raise RuntimeError(f"Provider {payment.provider} is not configured")
        result = provider.refund(payment.provider_payment_id, refund.amount_paise, str(refund.pk))
    except Exception:
        logger.exception("Refund failed", extra={"refund_id": str(refund.pk)})
        _finish_refund(refund, ok=False)
        return
    Refund.objects.filter(pk=refund.pk).update(
        provider_refund_id=result["provider_refund_id"], updated_at=timezone.now()
    )
    if result["status"] == "processed":
        _finish_refund(refund, ok=True)
    elif result["status"] == "failed":
        _finish_refund(refund, ok=False)
    # else: the bank has not confirmed it yet; the webhook or reconciliation finishes it.


def _finish_refund(refund: Refund, *, ok: bool) -> None:
    """Exactly once per refund: done → the payment's status follows; failed → amount released."""
    now = timezone.now()
    open_states = [R.PENDING, R.PROCESSING, R.MANUAL_PENDING]
    with transaction.atomic():
        if ok:
            done = R.MANUAL_DONE if refund.status == R.MANUAL_PENDING else R.PROCESSED
            if not Refund.objects.filter(pk=refund.pk, status__in=open_states).update(
                status=done, processed_at=now, failure_reason="", updated_at=now
            ):
                return
        else:
            if not Refund.objects.filter(pk=refund.pk, status__in=open_states).update(
                status=R.FAILED, failure_reason=REFUND_FAILED_NOTE, updated_at=now
            ):
                return
            Payment.objects.filter(pk=refund.payment_id).update(
                refunded_paise=F("refunded_paise") - refund.amount_paise,
                failure_reason=REFUND_FAILED_NOTE,
                updated_at=now,
            )
        _sync_payment_status(refund.payment_id, now)
    order = Order.objects.get(pk=Payment.objects.get(pk=refund.payment_id).order_id)
    logger.info(
        "Refund processed" if ok else "Refund failed",
        extra={"order_id": str(order.pk), "refund_id": str(refund.pk)},
    )
    notify_refund(order, refund.amount_paise, ok)
    emit_order_updated(order)


def _sync_payment_status(payment_id: uuid.UUID, now: datetime) -> None:
    payment = Payment.objects.select_for_update().get(pk=payment_id)
    done = (
        Refund.objects.filter(payment=payment, status__in=REFUND_DONE).aggregate(
            total=Sum("amount_paise")
        )["total"]
        or 0
    )
    if done == 0 or payment.status not in REFUNDABLE:
        return
    status = P.REFUNDED if done >= payment.amount_paise else P.PARTIALLY_REFUNDED
    Payment.objects.filter(pk=payment.pk).update(
        status=status,
        refunded_at=now,
        failure_reason="" if status == P.REFUNDED else payment.failure_reason,
        updated_at=now,
    )
    Order.objects.filter(pk=payment.order_id).update(payment_status=status, updated_at=now)


def admin_refund(
    admin: User, payment_id: uuid.UUID, amount_paise: int, reason: str, key: str | None
) -> dict[str, Any]:
    """A full or partial refund chosen by finance (master prompt §3D), up to what is left."""
    payment = Payment.objects.select_related("order").filter(pk=payment_id).first()
    if payment is None:
        raise ApiError.not_found("Payment not found")
    if payment.status not in REFUNDABLE:
        raise _conflict("Only paid payments can be refunded", "NOT_REFUNDABLE")
    left = payment.amount_paise - payment.refunded_paise
    if amount_paise > left:
        raise ApiError(
            422,
            "Validation failed",
            code="VALIDATION_ERROR",
            details=[
                {
                    "field": "amountPaise",
                    "message": f"At most {_rupees(left)} can be refunded"
                    if left
                    else "Nothing is left to refund",
                }
            ],
        )
    with transaction.atomic():
        _open_refund(
            payment,
            amount_paise,
            key=f"admin:{payment.pk}:{key or uuid.uuid4()}",
            reason=reason,
            by=admin,
        )
    return admin_get(payment.pk)


def admin_retry_refund(payment_id: uuid.UUID) -> dict[str, Any]:
    """Sends failed refunds again, or refunds a paid payment of a closed order (Node parity)."""
    payment = Payment.objects.select_related("order").filter(pk=payment_id).first()
    if payment is None:
        raise ApiError.not_found("Payment not found")
    failed = list(Refund.objects.filter(payment=payment, status=R.FAILED))
    closed = payment.order.status in CLOSED
    remaining = payment.amount_paise - payment.refunded_paise
    if not failed and not (payment.status in REFUNDABLE and closed and remaining > 0):
        raise _conflict(
            "Only paid payments of cancelled or rejected orders can be refunded", "NOT_REFUNDABLE"
        )
    now = timezone.now()
    with transaction.atomic():
        for refund in failed:
            reserved = Payment.objects.filter(
                pk=payment.pk, refunded_paise__lte=F("amount_paise") - refund.amount_paise
            ).update(refunded_paise=F("refunded_paise") + refund.amount_paise, updated_at=now)
            if reserved and Refund.objects.filter(pk=refund.pk, status=R.FAILED).update(
                status=R.PENDING, failure_reason="", updated_at=now
            ):
                transaction.on_commit(functools.partial(process_refund, refund.pk))
        Payment.objects.filter(pk=payment.pk).update(failure_reason="")
        if not failed:
            settle_cancelled_payment(payment.order)
    return payment_view(Payment.objects.get(pk=payment.pk))


def admin_complete_manual_refund(refund_id: uuid.UUID) -> dict[str, Any]:
    """Finance paid a cash-on-delivery refund back by hand."""
    refund = Refund.objects.filter(pk=refund_id).first()
    if refund is None:
        raise ApiError.not_found("Refund not found")
    if refund.status != R.MANUAL_PENDING:
        raise _conflict("This refund is not waiting to be paid by hand", "NOT_MANUAL")
    _finish_refund(refund, ok=True)
    return admin_get(refund.payment_id)


# ---------------------------------------------------------------------------
# Views of payments
# ---------------------------------------------------------------------------
def payment_view(payment: Payment) -> dict[str, Any]:
    return presenters.payment_view(payment)


def refund_json(refund: Refund) -> dict[str, Any]:
    return {
        "id": str(refund.pk),
        "amount_paise": refund.amount_paise,
        "status": refund.status,
        "reason": refund.reason or None,
        "created_at": refund.created_at,
        "processed_at": refund.processed_at,
    }


def _refund_needed(payment: Payment) -> bool:
    return (
        payment.method == PaymentMethod.ONLINE
        and payment.status in REFUNDABLE
        and payment.amount_paise > payment.refunded_paise
        and payment.order.status in CLOSED
    )


def _admin_row(p: Payment) -> dict[str, Any]:
    return {
        "id": str(p.pk),
        **payment_view(p),
        "provider_order_id": p.provider_order_id,
        "provider_payment_id": p.provider_payment_id,
        "created_at": p.created_at,
        "customer": {"id": str(p.user_id), "name": p.user.name, "email": p.user.email},
        "order": {
            "id": str(p.order_id),
            "order_number": p.order.order_number,
            "status": p.order.status,
        },
        "refund_needed": _refund_needed(p),
        "refundable_paise": p.amount_paise - p.refunded_paise if p.status in REFUNDABLE else 0,
    }


def admin_list(query: dict[str, Any], page: Page) -> dict[str, Any]:
    """Newest first; filters by status, method, provider, dates and a search over the order
    number and the customer's name, email or phone."""
    qs = Payment.objects.select_related("order", "user")
    for field in ("status", "method", "provider"):
        if query.get(field):
            qs = qs.filter(**{field: query[field]})
    if query.get("from"):
        qs = qs.filter(created_at__gte=query["from"])
    if query.get("to"):
        qs = qs.filter(created_at__lte=query["to"])
    if search := (query.get("search") or "").strip():
        qs = qs.filter(
            Q(order__order_number__icontains=search)
            | Q(user__name__icontains=search)
            | Q(user__email__icontains=search)
            | Q(user__phone__icontains=search)
        )
    rows, meta = paginate(qs.order_by("-created_at"), page)
    return {"items": [_admin_row(p) for p in rows], "pagination": meta}


def admin_get(payment_id: uuid.UUID) -> dict[str, Any]:
    """One payment with its refunds and the gateway events applied to it (the audit trail)."""
    payment = Payment.objects.select_related("order", "user").filter(pk=payment_id).first()
    if payment is None:
        raise ApiError.not_found("Payment not found")
    events = payment.events.order_by("created_at")
    return {
        "payment": {
            **_admin_row(payment),
            "refunds": [refund_json(r) for r in payment.refunds.order_by("created_at")],
            "events": [
                {"type": e.event_type, "event_id": e.event_id, "created_at": e.created_at}
                for e in events
            ],
        }
    }


def list_mine(user: User, page: Page) -> dict[str, Any]:
    """The customer's payment history (abandoned checkout attempts are left out)."""
    qs = (
        Payment.objects.filter(user=user)
        .exclude(
            method=PaymentMethod.ONLINE,
            order__submitted_at__isnull=True,
            order__status=S.CANCELLED,
        )
        .select_related("order")
        .prefetch_related("refunds")
        .order_by("-created_at")
    )
    rows, meta = paginate(qs, page)
    return {
        "items": [
            {
                "id": str(p.pk),
                **payment_view(p),
                "created_at": p.created_at,
                "order": {
                    "id": str(p.order_id),
                    "order_number": p.order.order_number,
                    "status": p.order.status,
                    "restaurant_name": p.order.restaurant_snapshot.get("name", ""),
                },
                "refunds": [refund_json(r) for r in p.refunds.all()],
            }
            for p in rows
        ],
        "pagination": meta,
    }


# ---------------------------------------------------------------------------
# Reconciliation (Celery Beat)
# ---------------------------------------------------------------------------
def reconcile(now: datetime | None = None) -> dict[str, int]:
    """
    Catches what the browser and the webhooks missed:
    1. unpaid online payments the gateway says were captured (or failed);
    2. refunds whose gateway call was never made (the process stopped after commit);
    3. refunds the bank has not confirmed yet.
    """
    now = now or timezone.now()
    summary = {"paid": 0, "failed": 0, "refunds_sent": 0, "refunds_settled": 0}
    online = online_provider()
    if online is not None:
        waiting = Payment.objects.filter(
            method=PaymentMethod.ONLINE,
            provider=online.name,
            status__in=[P.PENDING, P.FAILED, P.CANCELLED],
            provider_order_id__isnull=False,
            created_at__lte=now - RECONCILE_AFTER,
            created_at__gte=now - RECONCILE_WINDOW,
        ).order_by("created_at")[:50]
        for payment in waiting:
            try:
                remote = online.order_payments(payment.provider_order_id)
            except Exception:
                logger.exception("Reconciliation: gateway lookup failed")
                continue
            captured = next(
                (
                    r
                    for r in remote
                    if r["status"] in ("captured", "authorized")
                    and r["amount_paise"] == payment.amount_paise
                ),
                None,
            )
            if captured:
                mark_paid(payment.pk, str(captured["id"]))
                summary["paid"] += 1
            elif (
                payment.status == P.PENDING
                and remote
                and all(r["status"] == "failed" for r in remote)
            ):
                mark_failed(payment.pk, "Payment failed")
                summary["failed"] += 1

    for refund_id in Refund.objects.filter(
        status=R.PENDING, updated_at__lte=now - RECONCILE_AFTER
    ).values_list("pk", flat=True)[:50]:
        process_refund(refund_id)
        summary["refunds_sent"] += 1

    for refund in Refund.objects.filter(
        status=R.PROCESSING,
        provider_refund_id__isnull=False,
        updated_at__lte=now - REFUND_CHECK_AFTER,
    ).select_related("payment")[:50]:
        provider = provider_named(refund.payment.provider)
        if provider is None or refund.provider_refund_id is None:
            continue
        try:
            state = provider.refund_status(refund.provider_refund_id)
        except Exception:
            logger.exception("Reconciliation: refund lookup failed")
            continue
        if state in ("processed", "failed"):
            _finish_refund(refund, ok=state == "processed")
            summary["refunds_settled"] += 1
    return summary
