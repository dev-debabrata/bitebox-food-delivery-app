"""Users and refresh-token sessions (Node: models/user.model.js, models/session.model.js)."""

from typing import Any, ClassVar

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models

from apps.rbac.roles import Role, permissions_for
from common.models import BaseModel, one_of

PHONE_PATTERN = r"^\+?[0-9]{10,15}$"


class UserStatus(models.TextChoices):
    ACTIVE = "active"
    SUSPENDED = "suspended"


USER_STATUS_VALUES = UserStatus.values  # plain list (OpenAPI enum name)


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def create_user(self, email: str, password: str | None, name: str, **extra: Any) -> "User":
        user = self.model(email=self.normalize_email(email).lower(), name=name, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(
        self, email: str, password: str | None, name: str = "Super Admin", **extra: Any
    ) -> "User":
        return self.create_user(email, password, name, role=Role.ADMIN, **extra)


class User(AbstractBaseUser, BaseModel):
    """
    Every account: customers, partners, riders and admins. `role` decides the panel; admin roles
    carry permissions from apps.rbac (code, not tables). Accounts are suspended, never deleted.
    `last_login` (from AbstractBaseUser) is the Node `lastLoginAt`.
    """

    name = models.CharField(max_length=80)
    email = models.EmailField(max_length=254, unique=True)  # always stored lower-case (save())
    phone = models.CharField(max_length=16, null=True, blank=True)
    role = models.CharField(
        max_length=24, choices=[(r.value, r.value) for r in Role], default=Role.CUSTOMER
    )
    status = models.CharField(max_length=16, choices=UserStatus.choices, default=UserStatus.ACTIVE)
    # Bumped on password change, suspension and role change: every access token and session dies.
    token_version = models.PositiveIntegerField(default=0)
    password_reset_token_hash = models.CharField(
        max_length=64, null=True, blank=True, db_index=True
    )
    password_reset_expires_at = models.DateTimeField(null=True, blank=True)
    referral_code = models.CharField(max_length=40, null=True, blank=True)
    birth_date = models.DateField(null=True, blank=True)
    # Web Push categories (Node pushPreferences.*)
    push_orders = models.BooleanField(default=True)
    push_account = models.BooleanField(default=True)
    push_promotions = models.BooleanField(default=False)

    objects: ClassVar[UserManager] = UserManager()

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        db_table = "users"
        constraints = [
            models.UniqueConstraint(
                fields=["phone"], condition=models.Q(phone__isnull=False), name="users_phone_unique"
            ),
            models.UniqueConstraint(
                fields=["referral_code"],
                condition=models.Q(referral_code__isnull=False),
                name="users_referral_code_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(role__in=[r.value for r in Role]), name="users_role_valid"
            ),
            one_of("status", UserStatus, "users_status_valid"),
        ]
        indexes = [
            models.Index(fields=["role", "status", "-created_at"], name="users_role_status_created")
        ]

    def __str__(self) -> str:
        return f"{self.name} <{self.email}>"

    def save(self, *args: Any, **kwargs: Any) -> None:
        self.email = (self.email or "").strip().lower()  # unique regardless of case, like Node
        super().save(*args, **kwargs)

    @property
    def is_active(self) -> bool:  # type: ignore[override]
        return self.status == UserStatus.ACTIVE

    @property
    def permissions(self) -> list[str]:
        return sorted(p.value for p in permissions_for(self.role))

    # Django admin (Phase 5) treats only the super admin as staff.
    @property
    def is_staff(self) -> bool:
        return self.role == Role.ADMIN and self.is_active

    @property
    def is_superuser(self) -> bool:
        return self.is_staff

    def has_perm(self, perm: str, obj: Any = None) -> bool:
        return self.is_staff

    def has_module_perms(self, app_label: str) -> bool:
        return self.is_staff


class RevokedReason(models.TextChoices):
    ROTATED = "rotated"
    LOGOUT = "logout"
    REUSE = "reuse"
    PASSWORD_CHANGE = "password-change"  # noqa: S105 (a reason, not a password)
    SUSPENDED = "suspended"
    ROLE_CHANGE = "role-change"


class Session(BaseModel):
    """
    One row per refresh token. Rotation revokes the old row; reusing a revoked token revokes the
    whole family.
    """

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sessions")
    token_hash = models.CharField(max_length=64, unique=True)
    family = models.CharField(max_length=64, db_index=True)
    expires_at = models.DateTimeField(
        db_index=True
    )  # rows past this are purged daily (Node: TTL index)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_reason = models.CharField(
        max_length=20, choices=RevokedReason.choices, null=True, blank=True
    )
    user_agent = models.CharField(max_length=512, blank=True, default="")
    ip = models.GenericIPAddressField(null=True, blank=True)

    class Meta:
        db_table = "sessions"
        indexes = [models.Index(fields=["user", "revoked_at"], name="sessions_user_revoked")]
