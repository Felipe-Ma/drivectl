"""Async HPE iLO Redfish client (drive discovery + Drive.Reset power actions)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger("drivectl.redfish")

SYSTEM_ID = "1"  # iLO always exposes the host as Systems/1
REQUEST_TIMEOUT = httpx.Timeout(15.0, connect=8.0)

# Status.State values that mean the drive is powered on / off.
ON_STATES = {"enabled"}
OFF_STATES = {"standbyoffline", "disabled", "offline", "absent"}


class RedfishError(Exception):
    """Redfish/BMC error with an HTTP-ish status and user-facing message."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def _friendly_transport_error(exc: httpx.HTTPError, bmc_ip: str) -> RedfishError:
    if isinstance(exc, httpx.ConnectTimeout):
        return RedfishError(f"Connection to {bmc_ip} timed out — is the BMC reachable?", 504)
    if isinstance(exc, httpx.ConnectError):
        msg = str(exc)
        if "CERTIFICATE" in msg.upper() or "certificate" in msg:
            return RedfishError(
                f"TLS certificate verification failed for {bmc_ip}. "
                "Disable 'Verify TLS' on this profile if the iLO uses a self-signed cert.",
                502,
            )
        return RedfishError(f"Could not connect to {bmc_ip}: {msg}", 502)
    if isinstance(exc, httpx.TimeoutException):
        return RedfishError(f"Request to {bmc_ip} timed out.", 504)
    return RedfishError(f"HTTP error talking to {bmc_ip}: {exc}", 502)


def _extract_ilo_error(payload: Any) -> str | None:
    """Pull a readable message out of an iLO error response body."""
    if not isinstance(payload, dict):
        return None
    err = payload.get("error", payload)
    if not isinstance(err, dict):
        return None
    infos = err.get("@Message.ExtendedInfo") or []
    parts = []
    for info in infos:
        if isinstance(info, dict):
            msg = info.get("Message") or info.get("MessageId")
            if msg:
                parts.append(str(msg))
    if parts:
        return "; ".join(parts)
    return err.get("message")


class RedfishClient:
    """One client per profile, used per-request (short-lived)."""

    def __init__(self, bmc_ip: str, username: str, password: str, verify_tls: bool):
        self.bmc_ip = bmc_ip
        self.base_url = f"https://{bmc_ip}"
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            auth=(username, password),
            verify=verify_tls,
            timeout=REQUEST_TIMEOUT,
        )

    async def __aenter__(self) -> "RedfishClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, json_body: dict | None = None) -> dict:
        try:
            resp = await self._client.request(method, path, json=json_body)
        except httpx.HTTPError as exc:
            raise _friendly_transport_error(exc, self.bmc_ip) from exc

        payload: Any = None
        if resp.content:
            try:
                payload = resp.json()
            except ValueError:
                payload = None

        if resp.status_code == 401:
            raise RedfishError(
                f"Authentication failed for {self.bmc_ip} (401) — check username/password.", 401
            )
        if resp.status_code == 404:
            raise RedfishError(f"Not found on {self.bmc_ip}: {path} (404)", 404)
        if resp.status_code >= 400:
            detail = _extract_ilo_error(payload)
            msg = f"iLO returned {resp.status_code} for {method} {path}"
            if detail:
                msg += f": {detail}"
            raise RedfishError(msg, 502)

        return payload if isinstance(payload, dict) else {}

    # -- high level operations ----------------------------------------------

    async def test_connection(self) -> dict:
        data = await self._request("GET", f"/redfish/v1/Systems/{SYSTEM_ID}")
        return {
            "ok": True,
            "model": data.get("Model"),
            "manufacturer": data.get("Manufacturer"),
            "power_state": data.get("PowerState"),
        }

    async def list_drives(self) -> list[dict]:
        storage_root = await self._request("GET", f"/redfish/v1/Systems/{SYSTEM_ID}/Storage")
        members = storage_root.get("Members") or []

        storage_ids = []
        for member in members:
            odata_id = (member or {}).get("@odata.id", "")
            sid = odata_id.rstrip("/").split("/")[-1]
            if sid:
                storage_ids.append(sid)

        controllers = await asyncio.gather(
            *(self._request("GET", f"/redfish/v1/Systems/{SYSTEM_ID}/Storage/{sid}")
              for sid in storage_ids)
        )

        drive_refs: list[tuple[str, str, str | None]] = []
        for sid, controller in zip(storage_ids, controllers):
            ctrl_name = controller.get("Name")
            for drive in controller.get("Drives") or []:
                odata_id = (drive or {}).get("@odata.id", "")
                drive_id = odata_id.rstrip("/").split("/")[-1]
                if drive_id:
                    drive_refs.append((sid, drive_id, ctrl_name))

        details = await asyncio.gather(
            *(self.get_drive(sid, did, ctrl) for sid, did, ctrl in drive_refs)
        )
        return list(details)

    async def get_drive(self, storage_id: str, drive_id: str,
                        controller_name: str | None = None) -> dict:
        uri = f"/redfish/v1/Systems/{SYSTEM_ID}/Storage/{storage_id}/Drives/{drive_id}"
        data = await self._request("GET", uri)
        status = data.get("Status") or {}
        part_location = (data.get("PhysicalLocation") or {}).get("PartLocation") or {}
        return {
            "storage_id": storage_id,
            "drive_id": drive_id,
            "redfish_uri": uri,
            "name": data.get("Name"),
            "model": data.get("Model"),
            "serial_number": data.get("SerialNumber"),
            "capacity_bytes": data.get("CapacityBytes"),
            "media_type": data.get("MediaType"),
            "protocol": data.get("Protocol"),
            "description": data.get("Description"),
            "location": part_location.get("ServiceLabel"),
            "controller_name": controller_name,
            "state": status.get("State"),
            "health": status.get("Health"),
            "raw": data,
        }

    async def reset_drive(self, storage_id: str, drive_id: str, reset_value: str) -> None:
        await self._request(
            "POST",
            f"/redfish/v1/Systems/{SYSTEM_ID}/Storage/{storage_id}"
            f"/Drives/{drive_id}/Actions/Drive.Reset",
            json_body={"ResetValue": reset_value},
        )

    async def power_drive(self, storage_id: str, drive_id: str, action: str) -> dict:
        """Send ForceOn/ForceOff then re-poll the drive state with backoff."""
        reset_value = {"on": "ForceOn", "off": "ForceOff"}[action]
        await self.reset_drive(storage_id, drive_id, reset_value)

        expected = ON_STATES if action == "on" else OFF_STATES
        drive: dict = {}
        for delay in (0.5, 1.0, 2.0, 3.0):
            await asyncio.sleep(delay)
            try:
                drive = await self.get_drive(storage_id, drive_id)
            except RedfishError as exc:
                log.warning("Re-poll of %s/%s failed: %s", storage_id, drive_id, exc.message)
                continue
            state = (drive.get("state") or "").lower()
            if state in expected:
                break
        return drive
