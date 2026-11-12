"""Base classes every BiteBox table uses (docs/django-migration/03-data-model.md §3.1)."""

from typing import Any

from django.db import models

from .ids import uuid7


class BaseModel(models.Model):
    """UUIDv7 primary key, UTC timestamps, and the MongoDB id of rows imported from Node."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=False)
    updated_at = models.DateTimeField(auto_now=True)
    # ObjectId of the source document when imported by `manage.py import_mongo`; null for new rows.
    legacy_id = models.CharField(max_length=24, unique=True, null=True, blank=True, editable=False)

    class Meta:
        abstract = True


class AppendOnlyModel(models.Model):
    """For logs: no updated_at."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    legacy_id = models.CharField(max_length=24, unique=True, null=True, blank=True, editable=False)

    class Meta:
        abstract = True


class RatingSummary(models.Model):
    """The Node `rating` sub-document (average, count, distribution of 1–5 stars) as columns."""

    rating_average = models.DecimalField(max_digits=3, decimal_places=2, default=0)
    rating_count = models.PositiveIntegerField(default=0)
    rating_distribution = models.JSONField(default=list)  # [ones, twos, threes, fours, fives]

    class Meta:
        abstract = True

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self.rating_distribution:
            self.rating_distribution = [0, 0, 0, 0, 0]
        super().save(*args, **kwargs)


def non_negative(field: str, name: str) -> models.CheckConstraint:
    return models.CheckConstraint(condition=models.Q(**{f"{field}__gte": 0}), name=name)


def one_of(field: str, choices: type[models.TextChoices], name: str) -> models.CheckConstraint:
    """The database also refuses values outside the enum (not just the serializer)."""
    return models.CheckConstraint(condition=models.Q(**{f"{field}__in": choices.values}), name=name)
