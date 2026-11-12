"""
Roles and permissions must match the Node API exactly while both exist: the Angular app and
existing users rely on these strings. Once backend/ is removed, the parity test is skipped.
"""

import re
from pathlib import Path

import pytest

from apps.rbac.roles import (
    ADMIN_ROLES,
    MEMBER_ROLES,
    ROLE_PERMISSIONS,
    Permission,
    Role,
    has_permission,
    permissions_for,
)

NODE_CONFIG = Path(__file__).resolve().parents[4] / "backend" / "config"


def test_super_admin_has_everything_and_members_nothing() -> None:
    assert permissions_for(Role.ADMIN) == frozenset(Permission)
    for role in MEMBER_ROLES:
        assert permissions_for(role) == frozenset()
    assert permissions_for(None) == frozenset()
    assert permissions_for("not-a-role") == frozenset()


def test_staff_roles() -> None:
    assert has_permission("support_admin", Permission.ORDERS_VIEW)
    assert not has_permission("support_admin", Permission.ORDERS_MANAGE)
    assert not has_permission("finance_admin", Permission.ORDERS_VIEW)
    assert set(ADMIN_ROLES) == {
        Role.ADMIN,
        Role.OPERATIONS_ADMIN,
        Role.FINANCE_ADMIN,
        Role.SUPPORT_ADMIN,
    }


@pytest.mark.skipif(not NODE_CONFIG.exists(), reason="Node API removed; nothing to compare with")
def test_matches_the_node_api() -> None:
    roles_js = (NODE_CONFIG / "roles.js").read_text()
    perms_js = (NODE_CONFIG / "permissions.js").read_text()

    node_roles = set(
        re.findall(r'^\s+[A-Z_]+: "([a-z_]+)",', roles_js.split("export const ALL_ROLES")[0], re.M)
    )
    assert node_roles == {r.value for r in Role}

    perms_block = perms_js.split("export const PERMISSIONS")[1].split("});")[0]
    name_to_value = dict(re.findall(r'^\s+([A-Z_]+): "([a-z:]+)",', perms_block, re.M))
    assert set(name_to_value.values()) == {p.value for p in Permission}

    role_block = perms_js.split("export const ROLE_PERMISSIONS")[1]
    for role in (Role.OPERATIONS_ADMIN, Role.FINANCE_ADMIN, Role.SUPPORT_ADMIN):
        key = role.name
        match = re.search(rf"\[ROLES\.{key}\]: Object\.freeze\(\[(.*?)\]\)", role_block, re.S)
        assert match, key
        node_values = {name_to_value[n] for n in re.findall(r"P\.([A-Z_]+)", match.group(1))}
        assert node_values == {p.value for p in ROLE_PERMISSIONS[role]}, role
