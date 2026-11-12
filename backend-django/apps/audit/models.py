"""Admin audit log (Node: models/audit-log.model.js). Append-only."""

from django.conf import settings
from django.db import models

from common.models import AppendOnlyModel


class AuditLog(AppendOnlyModel):
    admin = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    admin_role = models.CharField(max_length=24)
    action = models.CharField(max_length=60)  # e.g. restaurant.approve
    description = models.CharField(max_length=500)
    resource_type = models.CharField(max_length=40, blank=True, default="")
    resource_id = models.CharField(max_length=64, blank=True, default="")
    ip = models.GenericIPAddressField(null=True, blank=True)

    class Meta:
        db_table = "audit_logs"
        indexes = [
            models.Index(fields=["-created_at"], name="audit_logs_recent"),
            models.Index(fields=["admin", "-created_at"], name="audit_logs_admin"),
            models.Index(fields=["action", "-created_at"], name="audit_logs_action"),
            models.Index(fields=["resource_id", "-created_at"], name="audit_logs_resource"),
        ]
