"""
Downloadable PDFs: the customer's invoice for a delivered order and a partner's payout statement.

Each document gets a number the first time it is produced, from a series per Indian financial year
(April to March), e.g. BB/INV/2026-27/000042; later downloads show the same number. The PDF itself
is drawn on request from the stored order or payout.

Legal note (flagged for review by a qualified professional): a GST tax invoice also needs the
supplier's GSTIN, HSN/SAC codes and the tax split (CGST/SGST or IGST). Those come with restaurant
KYC; until then the document says so.
"""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.orders.models import Order, OrderStatus
from common.api import ApiError
from common.pdf import Pdf

from .models import Invoice, InvoiceKind, InvoiceSequence, OrderSettlement, Payout, PayoutType

SERIES = {InvoiceKind.CUSTOMER_TAX_INVOICE: "INV", InvoiceKind.PAYOUT_STATEMENT: "STM"}
LEFT, RIGHT = 48, 547


def financial_year(at: datetime) -> str:
    local = at.astimezone(ZoneInfo(settings.REPORT_TIMEZONE))
    start = local.year if local.month >= 4 else local.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _next_number(kind: str, at: datetime) -> str:
    series = f"{SERIES[InvoiceKind(kind)]}/{financial_year(at)}"
    InvoiceSequence.objects.get_or_create(series=series)
    seq = InvoiceSequence.objects.select_for_update().get(series=series)
    seq.last += 1
    seq.save(update_fields=["last"])
    return f"BB/{series}/{seq.last:06d}"


def _issue(kind: str, amount: int, tax: int, **target: Any) -> Invoice:
    existing = Invoice.objects.filter(kind=kind, **target).first()
    if existing:
        return existing
    now = timezone.now()
    try:
        with transaction.atomic():
            return Invoice.objects.create(
                kind=kind,
                number=_next_number(kind, now),
                amount_paise=amount,
                tax_paise=tax,
                issued_at=now,
                **target,
            )
    except IntegrityError:  # issued by a parallel request
        return Invoice.objects.get(kind=kind, **target)


def rs(paise: int) -> str:
    sign = "-" if paise < 0 else ""
    return f"{sign}Rs. {abs(paise) / 100:,.2f}"


def _when(at: datetime | None) -> str:
    return at.astimezone(ZoneInfo(settings.REPORT_TIMEZONE)).strftime("%d %b %Y") if at else "-"


def _header(pdf: Pdf, title: str, number: str, issued: datetime) -> None:
    pdf.text(LEFT, 60, "BiteBox", 22, bold=True)
    pdf.text(RIGHT, 52, title, 14, bold=True, right=True)
    pdf.text(RIGHT, 70, f"No. {number}", 9, right=True)
    pdf.text(RIGHT, 84, f"Date {_when(issued)}", 9, right=True)
    pdf.line(LEFT, 100, RIGHT, 1, 0.2)


def _rows(pdf: Pdf, y: float, rows: list[tuple[str, str]], bold_last: bool = False) -> float:
    for i, (label, value) in enumerate(rows):
        bold = bold_last and i == len(rows) - 1
        pdf.text(330, y, label, 10, bold=bold)
        pdf.text(RIGHT, y, value, 10, bold=bold, right=True)
        y += 16
    return y


def order_invoice(order: Order) -> tuple[str, bytes]:
    """(file name, PDF) for a delivered order."""
    if order.status != OrderStatus.DELIVERED:
        raise ApiError.conflict(
            "An invoice is available once the order is delivered", "NOT_DELIVERED"
        )
    invoice = _issue(
        InvoiceKind.CUSTOMER_TAX_INVOICE, order.total_paise, order.tax_paise, order=order
    )
    pdf = Pdf()
    _header(pdf, "Tax invoice", invoice.number, invoice.issued_at)
    snap, addr = order.restaurant_snapshot or {}, order.delivery_address or {}
    pdf.text(LEFT, 124, "Sold by", 9, bold=True)
    pdf.text(LEFT, 138, snap.get("name", ""), 10)
    pdf.text(LEFT, 152, snap.get("address", ""), 9)
    pdf.text(320, 124, "Billed to", 9, bold=True)
    pdf.text(320, 138, addr.get("recipient_name", ""), 10)
    pdf.text(320, 152, ", ".join(p for p in (addr.get("line1"), addr.get("area")) if p), 9)
    pdf.text(320, 166, ", ".join(p for p in (addr.get("city"), addr.get("postal_code")) if p), 9)
    pdf.text(LEFT, 190, f"Order {order.order_number} · placed {_when(order.created_at)}", 9)

    y: float = 220
    pdf.text(LEFT, y, "Item", 9, bold=True)
    pdf.text(380, y, "Qty", 9, bold=True, right=True)
    pdf.text(460, y, "Price", 9, bold=True, right=True)
    pdf.text(RIGHT, y, "Amount", 9, bold=True, right=True)
    pdf.line(LEFT, y + 6, RIGHT)
    y += 22
    for item in sorted(order.items.all(), key=lambda i: i.created_at):
        if y > 720:
            pdf.new_page()
            y = 60
        pdf.text(LEFT, y, item.name[:60], 10)
        pdf.text(380, y, item.quantity, 10, right=True)
        pdf.text(460, y, rs(item.unit_price_paise), 10, right=True)
        pdf.text(RIGHT, y, rs(item.line_total_paise), 10, right=True)
        y += 18
    pdf.line(LEFT, y - 6, RIGHT)
    rows = [("Food", rs(order.subtotal_paise))]
    if order.discount_paise:
        rows.append(("Discount", rs(-order.discount_paise)))
    rows += [
        ("Delivery fee", rs(order.delivery_fee_paise)),
        ("Platform fee", rs(order.platform_fee_paise)),
        ("GST", rs(order.tax_paise)),
    ]
    if order.coin_discount_paise:
        rows.append(("Paid with coins", rs(-order.coin_discount_paise)))
    rows.append(("Total", rs(order.total_paise)))
    y = _rows(pdf, y + 12, rows, bold_last=True)
    pdf.text(
        LEFT,
        y + 10,
        f"Payment: {'cash on delivery' if order.payment_method == 'cod' else 'online'}",
        9,
    )
    pdf.text(
        LEFT,
        780,
        "GSTIN, HSN/SAC codes and the CGST/SGST split are added once the restaurant's KYC "
        "is complete.",
        8,
    )
    return f"BiteBox-invoice-{order.order_number}.pdf", pdf.render()


def payout_statement(payout: Payout) -> tuple[str, bytes]:
    """(file name, PDF): what a payout covered, order by order."""
    invoice = _issue(InvoiceKind.PAYOUT_STATEMENT, payout.amount_paise, 0, payout=payout)
    pdf = Pdf()
    _header(pdf, "Payout statement", invoice.number, invoice.issued_at)
    pdf.text(LEFT, 124, "Paid to", 9, bold=True)
    pdf.text(LEFT, 138, payout.payee_name, 11, bold=True)
    pdf.text(
        LEFT, 152, "Restaurant" if payout.type == PayoutType.RESTAURANT else "Delivery partner", 9
    )
    pdf.text(320, 124, "Status", 9, bold=True)
    pdf.text(320, 138, payout.status.capitalize(), 10)
    pdf.text(320, 152, f"Period {_when(payout.period_from)} to {_when(payout.period_to)}", 9)
    if payout.reference:
        pdf.text(320, 166, f"Bank reference {payout.reference}", 9)

    link = "restaurant_payout" if payout.type == PayoutType.RESTAURANT else "rider_payout"
    settlements = OrderSettlement.objects.filter(**{link: payout}).select_related("order")
    y: float = 200
    restaurant = payout.type == PayoutType.RESTAURANT
    pdf.text(LEFT, y, "Order", 9, bold=True)
    pdf.text(200, y, "Delivered", 9, bold=True)
    if restaurant:
        pdf.text(380, y, "Commission", 9, bold=True, right=True)
        pdf.text(460, y, "Refunds", 9, bold=True, right=True)
    pdf.text(RIGHT, y, "Amount", 9, bold=True, right=True)
    pdf.line(LEFT, y + 6, RIGHT)
    y += 22
    for s in settlements.order_by("settled_at"):
        if y > 740:
            pdf.new_page()
            y = 60
        food = s.order.subtotal_paise - s.order.discount_paise
        net = s.restaurant_paise - s.refund_adjustment_paise if restaurant else s.rider_paise
        pdf.text(LEFT, y, s.order.order_number, 10)
        pdf.text(200, y, _when(s.settled_at), 10)
        if restaurant:
            pdf.text(380, y, rs(food - s.restaurant_paise), 10, right=True)
            pdf.text(
                460,
                y,
                rs(-s.refund_adjustment_paise) if s.refund_adjustment_paise else "-",
                10,
                right=True,
            )
        pdf.text(RIGHT, y, rs(net), 10, right=True)
        y += 18
    pdf.line(LEFT, y - 6, RIGHT)
    _rows(
        pdf,
        y + 12,
        [("Orders", str(payout.orders_count)), ("Total paid", rs(payout.amount_paise))],
        True,
    )
    return f"BiteBox-payout-{invoice.number.replace('/', '-')}.pdf", pdf.render()
