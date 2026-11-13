"""
Port of the Node API's support-ticket tests (tests/admin-roles.test.js "support tickets" and the
ticket-about-my-order case), plus the validation, privacy and permission rules of
services/support.service.js and validators/support.validators.js.
"""

import uuid
from typing import Any

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.accounts.tests.test_auth import create_and_login
from apps.audit.models import AuditLog
from apps.notifications.models import Notification
from apps.orders.models import Order
from apps.orders.tests.test_orders import World, client_for
from apps.support.models import SupportMessage, SupportTicket

pytestmark = pytest.mark.django_db

TICKETS = "/api/v1/support/tickets"
ADMIN = "/api/v1/admin/support"


class Desk(World):
    """The order World plus support, finance and super admins."""

    def __init__(self) -> None:
        super().__init__()
        self.support = create_and_login("support_admin")
        self.finance = create_and_login("finance_admin")
        self.admin = create_and_login("admin")
        self.s = client_for(self.support["token"])
        self.f = client_for(self.finance["token"])
        self.a = client_for(self.admin["token"])

    def open_ticket(self, client: APIClient | None = None, **body: Any) -> Any:
        payload = {
            "type": "account",
            "subject": "Cannot change email",
            "message": "Please help me.",
            **body,
        }
        return (client or self.c).post(TICKETS, payload, format="json")

    def ticket(self, client: APIClient | None = None, **body: Any) -> dict[str, Any]:
        res = self.open_ticket(client, **body)
        assert res.status_code == 201, res.json()
        return dict(res.json()["data"]["ticket"])

    def staff(
        self, method: str, path: str, body: Any = None, client: APIClient | None = None
    ) -> Any:
        return getattr(client or self.s, method)(f"{ADMIN}{path}", body, format="json")


@pytest.fixture
def w() -> Desk:
    return Desk()


def _has_notification(user: dict[str, Any], type: str) -> bool:
    return Notification.objects.filter(user_id=user["user"]["id"], type=type).exists()


# --- requesters ----------------------------------------------------------------------------------


def test_opens_a_ticket_only_about_your_own_order(w: Desk) -> None:
    order_id = w.place_order()
    number = Order.objects.get(pk=order_id).order_number
    ok = w.open_ticket(
        type="refund",
        subject="Missing item",
        message="One dish was missing.",
        orderNumber=number.lower(),
    )
    assert ok.status_code == 201, ok.json()
    body = ok.json()
    assert body["message"] == "Ticket created. Our support team will reply soon."
    ticket = body["data"]["ticket"]
    assert ticket["orderNumber"] == number
    assert ticket["number"].startswith("TK-")
    assert SupportTicket.objects.get(pk=ticket["id"]).priority == "high"  # refunds go up the queue

    missing = w.open_ticket(orderNumber="BB-000000-AAAAAA")
    assert missing.status_code == 422
    assert missing.json()["message"] == "We could not find that order on your account"
    assert missing.json()["error"]["details"] == [
        {"field": "orderNumber", "message": "No matching order on your account"}
    ]
    # The restaurant that cooked it and a stranger: only the kitchen may attach it.
    assert w.open_ticket(w.o, orderNumber=number).status_code == 201
    assert w.open_ticket(w.r, orderNumber=number).status_code == 422


def test_creating_a_ticket_validates_like_node(w: Desk) -> None:
    res = w.c.post(TICKETS, {"subject": 5, "message": "x", "orderNumber": "123"}, format="json")
    assert res.status_code == 422
    details = {d["field"]: d["message"] for d in res.json()["error"]["details"]}
    assert details == {
        "type": "Choose what this is about",
        "subject": "Add a subject",
        "message": "Message must be 2-2000 characters",
        "orderNumber": "Order numbers look like BB-261105-ABC123",
    }
    short = w.open_ticket(subject="  Hi  ")
    assert short.json()["error"]["details"] == [
        {"field": "subject", "message": "Subject must be 5-120 characters"}
    ]
    # Falsy order numbers count as "not sent"; unknown fields are ignored.
    res = w.open_ticket(orderNumber="", status="closed", priority="urgent")
    assert res.status_code == 201
    stored = SupportTicket.objects.get(pk=res.json()["data"]["ticket"]["id"])
    assert (stored.status, stored.priority, stored.order_number) == ("open", "medium", "")
    assert w.open_ticket(subject="  Need some help  ").json()["data"]["ticket"]["subject"] == (
        "Need some help"
    )


def test_lists_your_own_tickets_with_status_filter(w: Desk) -> None:
    first = w.ticket()
    second = w.ticket(subject="Second problem here")
    w.ticket(w.r, subject="Rider ticket here")
    w.staff("patch", f"/tickets/{first['id']}", {"status": "resolved"})

    res = w.c.get(TICKETS)
    assert res.status_code == 200
    data = res.json()["data"]
    assert [t["id"] for t in data["items"]] == [first["id"], second["id"]]  # latest activity first
    assert data["pagination"] == {"page": 1, "limit": 20, "total": 2, "totalPages": 1}
    assert data["items"][0]["messages"] == []
    assert [t["id"] for t in w.c.get(f"{TICKETS}?status=open").json()["data"]["items"]] == [
        second["id"]
    ]
    assert [t["id"] for t in w.c.get(f"{TICKETS}?status=closed").json()["data"]["items"]] == [
        first["id"]
    ]
    bad = w.c.get(f"{TICKETS}?status=resolved")
    assert bad.status_code == 422
    assert bad.json()["error"]["details"] == [{"field": "status", "message": "Invalid value"}]


def test_keeps_other_peoples_tickets_private(w: Desk) -> None:
    ticket = w.ticket()
    assert w.r.get(f"{TICKETS}/{ticket['id']}").status_code == 404
    reply = w.r.post(f"{TICKETS}/{ticket['id']}/messages", {"body": "Hello there"}, format="json")
    assert reply.status_code == 404
    assert reply.json()["message"] == "Ticket not found"
    assert w.c.get(f"{TICKETS}/not-an-id").status_code == 422
    assert w.s.get(TICKETS).status_code == 403, "staff use the admin endpoints"
    assert APIClient().get(TICKETS).status_code == 401


# --- the full flow -------------------------------------------------------------------------------


def test_runs_a_ticket_from_open_to_resolved_hiding_internal_notes(w: Desk) -> None:
    ticket = w.ticket()
    assert ticket["status"] == "open"
    assert _has_notification(w.support, "support.new")
    assert _has_notification(w.admin, "support.new")
    assert not _has_notification(w.finance, "support.new")

    note = w.staff(
        "post",
        f"/tickets/{ticket['id']}/messages",
        {"body": "Checked the account.", "internal": True},
    )
    assert note.json()["message"] == "Note added"
    assert note.json()["data"]["ticket"]["status"] == "open"
    reply = w.staff(
        "post", f"/tickets/{ticket['id']}/messages", {"body": "Which email should we use?"}
    )
    assert reply.json()["message"] == "Reply sent"
    data = reply.json()["data"]["ticket"]
    assert data["status"] == "waiting_for_response"
    assert data["assignee"]["name"] == w.support["user"]["name"]
    assert _has_notification(w.customer, "support.reply")

    mine = w.c.get(f"{TICKETS}/{ticket['id']}").json()["data"]["ticket"]
    assert len(mine["messages"]) == 2, "note hidden"
    assert mine["messages"][1]["authorName"] == "BiteBox Support"
    assert mine["messages"][1]["fromSupport"] is True
    assert "Checked the account." not in str(mine)

    answer = w.c.post(
        f"{TICKETS}/{ticket['id']}/messages",
        {"body": "The new one is nora@example.com"},
        format="json",
    )
    assert answer.status_code == 200
    assert answer.json()["message"] == "Reply sent"
    assert answer.json()["data"]["ticket"]["status"] == "in_progress"
    # The assignee hears about the reply.
    assert Notification.objects.filter(
        user_id=w.support["user"]["id"], type="support.reply"
    ).exists()

    done = w.staff("patch", f"/tickets/{ticket['id']}", {"status": "resolved", "priority": "low"})
    assert done.status_code == 200
    assert done.json()["message"] == "Ticket updated"
    detail = done.json()["data"]["ticket"]
    assert detail["status"] == "resolved"
    assert detail["resolvedAt"]
    assert [h["action"] for h in detail["history"]] == [
        "created",
        "status",
        "status",
        "status",
        "priority",
    ]
    assert detail["history"][-1]["from"] == "medium"
    assert detail["history"][-1]["byName"] == w.support["user"]["name"]
    assert _has_notification(w.customer, "support.status")
    assert w.staff("get", "/dashboard").json()["data"]["resolved"] == 1
    assert AuditLog.objects.filter(
        action="ticket.update", description="status → resolved, priority → low"
    ).exists()

    # A resolved ticket reopens when the requester replies; a closed one does not.
    again = w.c.post(f"{TICKETS}/{ticket['id']}/messages", {"body": "Still broken"}, format="json")
    assert again.json()["data"]["ticket"]["status"] == "in_progress"
    w.staff("patch", f"/tickets/{ticket['id']}", {"status": "closed"})
    closed = w.c.post(f"{TICKETS}/{ticket['id']}/messages", {"body": "Hello?"}, format="json")
    assert closed.status_code == 400
    assert closed.json()["message"] == "This ticket is closed. Please open a new one."
    staff_reply = w.staff("post", f"/tickets/{ticket['id']}/messages", {"body": "Okay then"})
    assert staff_reply.status_code == 400
    assert staff_reply.json()["message"] == "Reopen the ticket before replying"
    assert (
        w.staff(
            "post",
            f"/tickets/{ticket['id']}/messages",
            {"body": "Closed for good", "internal": "true"},
        ).status_code
        == 200
    )


def test_a_reply_without_assignee_notifies_the_support_team(w: Desk) -> None:
    ticket = w.ticket(w.o, type="payment", subject="Payout looks wrong")
    Notification.objects.all().delete()
    res = w.o.post(f"{TICKETS}/{ticket['id']}/messages", {"body": "Any news?"}, format="json")
    assert res.status_code == 200
    assert res.json()["data"]["ticket"]["status"] == "open"
    assert _has_notification(w.support, "support.reply")
    staff_view = w.staff("get", f"/tickets/{ticket['id']}").json()["data"]["ticket"]
    assert staff_view["requesterRole"] == "restaurant"
    assert staff_view["priority"] == "high"
    link = Notification.objects.filter(user_id=w.support["user"]["id"]).first()
    assert link is not None
    assert link.link == f"/admin/support/ticket/{ticket['id']}"


def test_escalates_a_ticket_to_finance(w: Desk) -> None:
    ticket = w.ticket()
    res = w.staff("post", f"/tickets/{ticket['id']}/escalate", {"note": "Please check the refund."})
    assert res.status_code == 200
    assert res.json()["message"] == "Sent to the finance team"
    detail = res.json()["data"]["ticket"]
    assert detail["history"][-1] == {
        **detail["history"][-1],
        "action": "escalated",
        "to": "finance",
        "note": "Please check the refund.",
    }
    assert detail["messages"][-1]["internal"] is True
    assert _has_notification(w.finance, "support.escalated")
    assert AuditLog.objects.filter(
        action="ticket.escalate", description="Escalated to finance: Please check the refund."
    ).exists()
    mine = w.c.get(f"{TICKETS}/{ticket['id']}").json()["data"]["ticket"]
    assert "Escalated" not in str(mine["messages"])

    short = w.staff("post", f"/tickets/{ticket['id']}/escalate", {"note": "no"})
    assert short.status_code == 422
    assert short.json()["error"]["details"] == [
        {"field": "note", "message": "Explain what finance should check (5-500 characters)"}
    ]


def test_assigns_only_to_admins_who_handle_support(w: Desk) -> None:
    ticket = w.ticket()
    path = f"/tickets/{ticket['id']}"
    bad = w.staff("patch", path, {"assigneeId": w.finance["user"]["id"]})
    assert bad.status_code == 400
    assert bad.json()["message"] == "Assign the ticket to an active support admin"
    assert w.staff("patch", path, {"assigneeId": str(uuid.uuid4())}).status_code == 400
    assert w.staff("patch", path, {"assigneeId": "nope"}).json()["error"]["details"] == [
        {"field": "assigneeId", "message": "Invalid assignee"}
    ]
    good = w.staff("patch", path, {"assigneeId": w.admin["user"]["id"]})
    assert good.json()["data"]["ticket"]["assignee"]["name"] == w.admin["user"]["name"]
    assert _has_notification(w.admin, "support.assigned")
    assert AuditLog.objects.filter(
        action="ticket.update", description=f"assignee → {w.admin['user']['id']}"
    ).exists()

    cleared = w.staff("patch", path, {"assigneeId": None})
    assert cleared.json()["data"]["ticket"]["assignee"] is None
    assert cleared.json()["data"]["ticket"]["history"][-1]["to"] == "Unassigned"
    assert AuditLog.objects.filter(action="ticket.update", description="assignee → none").exists()
    # No change: nothing recorded in the history.
    before = len(cleared.json()["data"]["ticket"]["history"])
    same = w.staff("patch", path, {"assigneeId": ""})
    assert len(same.json()["data"]["ticket"]["history"]) == before


def test_staff_queue_filters_search_and_dashboard(w: Desk) -> None:
    one = w.ticket(type="refund", subject="Refund for cold food")
    two = w.ticket(w.r, type="delivery", subject="Address was wrong")
    three = w.ticket(w.o, type="other", subject="Menu upload stuck")
    w.staff("post", f"/tickets/{two['id']}/messages", {"body": "Looking into it"})
    w.staff("patch", f"/tickets/{three['id']}", {"status": "closed"})

    def ids(query: str) -> list[str]:
        res = w.staff("get", f"/tickets{query}")
        assert res.status_code == 200, res.json()
        return [t["id"] for t in res.json()["data"]["items"]]

    assert set(ids("")) == {one["id"], two["id"], three["id"]}
    assert set(ids("?status=active")) == {one["id"], two["id"]}
    assert ids("?status=closed") == [three["id"]]
    assert ids("?priority=high") == [one["id"]]
    assert ids("?requesterRole=delivery") == [two["id"]]
    assert ids("?type=other") == [three["id"]]
    assert ids("?assignee=me") == [two["id"]]
    assert set(ids("?assignee=unassigned")) == {one["id"], three["id"]}
    assert ids("?search=cold") == [one["id"]]
    assert ids(f"?search={one['number'].lower()}") == [one["id"]]
    assert ids(f"?search={w.rider['user']['name'][:4]}") == [two["id"]]
    row = next(
        t for t in w.staff("get", "/tickets").json()["data"]["items"] if t["id"] == two["id"]
    )
    assert row["messages"] == 2
    assert row["assignee"] == {"id": w.support["user"]["id"], "name": w.support["user"]["name"]}
    bad = w.staff("get", "/tickets?priority=critical&assignee=you")
    assert bad.status_code == 422
    assert {d["field"] for d in bad.json()["error"]["details"]} == {"priority", "assignee"}

    dash = w.staff("get", "/dashboard").json()["data"]
    assert dash == {
        "total": 3,
        "open": 1,
        "inProgress": 0,
        "pending": 1,
        "resolved": 0,
        "closed": 1,
        "highPriority": 1,
        "unassigned": 1,
        "openByRequester": {"customer": 1, "restaurant": 0, "delivery": 1},
        "openRefundRequests": 1,
    }


def test_staff_detail_shows_requester_order_and_notes(w: Desk) -> None:
    order_id = w.place_order()
    order = Order.objects.get(pk=order_id)
    ticket = w.ticket(orderNumber=order.order_number)
    w.staff("post", f"/tickets/{ticket['id']}/messages", {"body": "Private note", "internal": True})
    detail = w.staff("get", f"/tickets/{ticket['id']}").json()["data"]["ticket"]
    assert detail["requester"]["id"] == w.customer["user"]["id"]
    assert detail["requester"]["role"] == "customer"
    assert detail["order"]["id"] == order_id
    assert detail["order"]["totalPaise"] == order.total_paise
    assert detail["order"]["restaurantName"] == order.restaurant_snapshot["name"]
    assert [m["internal"] for m in detail["messages"]] == [False, True]
    assert detail["messages"][0]["authorName"] == w.customer["user"]["name"]
    assert detail["closedAt"] is None
    assert w.staff("get", f"/tickets/{uuid.uuid4()}").status_code == 404


def test_staff_list_has_active_support_admins_only(w: Desk) -> None:
    User.objects.filter(pk=w.admin["user"]["id"]).update(name="Aarav Admin")
    items = w.staff("get", "/staff").json()["data"]["items"]
    assert {i["role"] for i in items} == {"admin", "support_admin"}
    assert items == sorted(items, key=lambda i: i["name"])


def test_admin_support_needs_the_support_permission(w: Desk) -> None:
    ticket = w.ticket()
    for client in (w.f, w.c, client_for(create_and_login("operations_admin")["token"])):
        assert client.get(f"{ADMIN}/dashboard").status_code == 403
        assert client.get(f"{ADMIN}/tickets/{ticket['id']}").status_code == 403
    assert w.a.get(f"{ADMIN}/tickets").status_code == 200
    assert APIClient().get(f"{ADMIN}/staff").status_code == 401


def test_staff_message_validation(w: Desk) -> None:
    ticket = w.ticket()
    res = w.staff("post", f"/tickets/{ticket['id']}/messages", {"body": 7, "internal": "maybe"})
    assert res.status_code == 422
    assert {d["field"]: d["message"] for d in res.json()["error"]["details"]} == {
        "body": "Write a message",
        "internal": "Invalid value",
    }
    assert SupportMessage.objects.filter(ticket_id=ticket["id"]).count() == 1
    bad = w.staff("patch", f"/tickets/{ticket['id']}", {"status": "pending"})
    assert bad.json()["error"]["details"] == [{"field": "status", "message": "Invalid value"}]
