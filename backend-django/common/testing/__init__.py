from django.contrib.auth.hashers import Argon2PasswordHasher


class FastArgon2PasswordHasher(Argon2PasswordHasher):
    """Argon2 with minimal cost, for tests only (hashes still start with "argon2")."""

    time_cost = 1
    memory_cost = 64
    parallelism = 1
