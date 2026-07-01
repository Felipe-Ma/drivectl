"""JSON-file profile store with 0600 permissions.

Credentials are stored locally in plaintext by design (see README).
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path


class ProfileNotFound(KeyError):
    pass


class ProfileStore:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "profiles.json"
        self._lock = threading.Lock()
        data_dir.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write({})

    def _read(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            return {}

    def _write(self, data: dict) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    # -- public API ---------------------------------------------------------

    def list(self) -> list[dict]:
        with self._lock:
            data = self._read()
        return [self._public(p) for p in data.values()]

    def get(self, profile_id: str, include_password: bool = False) -> dict:
        with self._lock:
            data = self._read()
        if profile_id not in data:
            raise ProfileNotFound(profile_id)
        profile = data[profile_id]
        return dict(profile) if include_password else self._public(profile)

    def create(self, label: str, bmc_ip: str, username: str, password: str,
               verify_tls: bool) -> dict:
        profile = {
            "id": uuid.uuid4().hex[:12],
            "label": label,
            "bmc_ip": bmc_ip,
            "username": username,
            "password": password,
            "verify_tls": verify_tls,
        }
        with self._lock:
            data = self._read()
            data[profile["id"]] = profile
            self._write(data)
        return self._public(profile)

    def update(self, profile_id: str, **changes) -> dict:
        with self._lock:
            data = self._read()
            if profile_id not in data:
                raise ProfileNotFound(profile_id)
            profile = data[profile_id]
            for key in ("label", "bmc_ip", "username", "verify_tls"):
                if key in changes and changes[key] is not None:
                    profile[key] = changes[key]
            # Only overwrite the password when a non-empty one is provided.
            if changes.get("password"):
                profile["password"] = changes["password"]
            self._write(data)
        return self._public(profile)

    def delete(self, profile_id: str) -> None:
        with self._lock:
            data = self._read()
            if profile_id not in data:
                raise ProfileNotFound(profile_id)
            del data[profile_id]
            self._write(data)

    @staticmethod
    def _public(profile: dict) -> dict:
        return {k: v for k, v in profile.items() if k != "password"}
