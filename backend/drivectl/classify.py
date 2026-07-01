"""Drive role classification: 'test' | 'protected' | 'unknown'.

Layered heuristics to keep boot/system drives out of the test pool:
1. Manual override (keyed by serial number) always wins.
2. Boot-specific terms (boot/ns204/b140i) in name/model/description/location/
   controller name. Generic terms (os/system) only count in the drive's own
   name/description: HPE calls the embedded NVMe controller "NVMe Storage
   System", which would otherwise flag every attached data drive.
3. Exactly two "small" NVMe drives (<= 1/4 of the largest drive) look like
   an HPE NS204-style boot mirror pair.
4. Drives without a serial number cannot be tracked safely -> 'unknown'.
"""

from __future__ import annotations

import re

ROLES = ("test", "protected", "unknown")

# Strong terms are unambiguous boot indicators, safe to match anywhere.
STRONG_TERM_RE = re.compile(r"\b(boot|ns204|b140i)\b", re.IGNORECASE)
# Weak terms are generic words that appear in benign controller names
# (e.g. "NVMe Storage System"), so they only apply to drive-level text.
WEAK_TERM_RE = re.compile(r"\b(os|system)\b", re.IGNORECASE)

# (field, allow_weak_terms): controller/model/location often contain generic
# words like "System" that say nothing about the individual drive.
_TERM_FIELDS = (
    ("controller_name", False),
    ("name", True),
    ("model", False),
    ("description", True),
    ("location", False),
)


def _term_match(drive: dict) -> tuple[str, str] | None:
    """Return (field, matched_term) for the first boot-term hit, if any."""
    for field, allow_weak in _TERM_FIELDS:
        value = drive.get(field)
        if not value:
            continue
        m = STRONG_TERM_RE.search(str(value))
        if not m and allow_weak:
            m = WEAK_TERM_RE.search(str(value))
        if m:
            return field, m.group(0)
    return None


def _boot_mirror_serials(drives: list[dict]) -> set[str]:
    """Serials of a likely boot mirror: exactly 2 small NVMe drives.

    'Small' means <= 1/4 the capacity of the largest drive in the system,
    so a uniform all-NVMe array is never flagged.
    """
    capacities = [d["capacity_bytes"] for d in drives if d.get("capacity_bytes")]
    if not capacities:
        return set()
    max_cap = max(capacities)
    small_nvme = [
        d for d in drives
        if (d.get("protocol") or "").lower() == "nvme"
        and d.get("capacity_bytes")
        and d["capacity_bytes"] <= max_cap / 4
        and d.get("serial_number")
    ]
    if len(small_nvme) == 2:
        return {d["serial_number"] for d in small_nvme}
    return set()


def classify_drives(drives: list[dict], overrides: dict[str, dict]) -> list[dict]:
    """Annotate each drive dict with 'role' and 'role_reason' (in place).

    `overrides` maps serial_number -> local metadata dict which may contain
    a 'role_override' key.
    """
    mirror_serials = _boot_mirror_serials(drives)

    for drive in drives:
        serial = drive.get("serial_number")

        override = (overrides.get(serial) or {}).get("role_override") if serial else None
        if override in ROLES:
            drive["role"] = override
            drive["role_reason"] = f"Manual {override} override"
            continue

        hit = _term_match(drive)
        if hit:
            field, term = hit
            drive["role"] = "protected"
            if field == "controller_name":
                drive["role_reason"] = f"Matched boot controller ('{term}')"
            else:
                drive["role_reason"] = f"Likely boot drive ('{term}' in {field})"
            continue

        if serial in mirror_serials:
            drive["role"] = "protected"
            drive["role_reason"] = "Likely boot mirror drive (pair of small NVMe drives)"
            continue

        if not serial:
            drive["role"] = "unknown"
            drive["role_reason"] = "No serial number — drive cannot be tracked safely"
            continue

        drive["role"] = "test"
        drive["role_reason"] = "No boot/system indicators"

    return drives
