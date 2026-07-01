"""FastAPI application: JSON API under /api plus the static frontend."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .classify import classify_drives
from .config import Config
from .redfish import OFF_STATES, ON_STATES, RedfishClient, RedfishError
from .store import (DriveMetaStore, HistoryStore, ProfileNotFound,
                    ProfileStore)

log = logging.getLogger("drivectl")

STATIC_DIR = Path(__file__).parent / "static"


class ProfileCreate(BaseModel):
    label: str = Field(min_length=1)
    bmc_ip: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    verify_tls: bool = False


class ProfileUpdate(BaseModel):
    label: str | None = None
    bmc_ip: str | None = None
    username: str | None = None
    password: str | None = None  # empty/omitted = keep existing password
    verify_tls: bool | None = None


class PowerRequest(BaseModel):
    action: Literal["on", "off"]
    # Explicit safety flags the frontend sets from its settings toggles.
    # The backend re-checks classification and blocks unless these are set.
    override_protected: bool = False
    allow_unknown: bool = False


class DriveMetaUpdate(BaseModel):
    label: str | None = None
    notes: str | None = None
    favorite: bool | None = None
    role_override: Literal["test", "protected", "unknown"] | None = None
    clear_role_override: bool = False


def create_app(config: Config) -> FastAPI:
    store = ProfileStore(config.data_path)
    meta_store = DriveMetaStore(config.data_path)
    history = HistoryStore(config.data_path)
    app = FastAPI(title="drivectl", docs_url="/api/docs", openapi_url="/api/openapi.json")

    def client_for(profile_id: str) -> RedfishClient:
        try:
            profile = store.get(profile_id, include_password=True)
        except ProfileNotFound:
            raise HTTPException(404, f"Profile '{profile_id}' not found")
        return RedfishClient(
            bmc_ip=profile["bmc_ip"],
            username=profile["username"],
            password=profile["password"],
            verify_tls=profile.get("verify_tls", False),
        )

    @app.exception_handler(RedfishError)
    async def redfish_error_handler(_, exc: RedfishError):
        return JSONResponse(status_code=exc.status, content={"detail": exc.message})

    # -- profiles ------------------------------------------------------------

    @app.get("/api/profiles")
    async def list_profiles():
        return store.list()

    @app.post("/api/profiles", status_code=201)
    async def create_profile(body: ProfileCreate):
        return store.create(
            label=body.label,
            bmc_ip=body.bmc_ip,
            username=body.username,
            password=body.password,
            verify_tls=body.verify_tls,
        )

    @app.put("/api/profiles/{profile_id}")
    async def update_profile(profile_id: str, body: ProfileUpdate):
        try:
            return store.update(profile_id, **body.model_dump())
        except ProfileNotFound:
            raise HTTPException(404, f"Profile '{profile_id}' not found")

    @app.delete("/api/profiles/{profile_id}", status_code=204)
    async def delete_profile(profile_id: str):
        try:
            store.delete(profile_id)
        except ProfileNotFound:
            raise HTTPException(404, f"Profile '{profile_id}' not found")

    @app.post("/api/profiles/{profile_id}/test")
    async def test_profile(profile_id: str):
        async with client_for(profile_id) as client:
            try:
                return await client.test_connection()
            except RedfishError as exc:
                return JSONResponse(
                    status_code=200, content={"ok": False, "error": exc.message}
                )

    # -- ad-hoc connection test (used by the Add-server modal before saving) --

    @app.post("/api/test-connection")
    async def test_connection(body: ProfileCreate):
        client = RedfishClient(
            bmc_ip=body.bmc_ip,
            username=body.username,
            password=body.password,
            verify_tls=body.verify_tls,
        )
        async with client:
            try:
                return await client.test_connection()
            except RedfishError as exc:
                return JSONResponse(
                    status_code=200, content={"ok": False, "error": exc.message}
                )

    # -- drives ----------------------------------------------------------------

    def _attach_meta(drives: list[dict]) -> list[dict]:
        """Classify drives and merge in local metadata (keyed by serial)."""
        overrides = meta_store.all()
        classify_drives(drives, overrides)
        for d in drives:
            meta = overrides.get(d.get("serial_number") or "") or {}
            d["meta"] = {
                "label": meta.get("label"),
                "notes": meta.get("notes"),
                "favorite": bool(meta.get("favorite")),
                "role_override": meta.get("role_override"),
            }
        return drives

    @app.get("/api/profiles/{profile_id}/drives")
    async def list_drives(profile_id: str):
        async with client_for(profile_id) as client:
            drives = await client.list_drives()
        return _attach_meta(drives)

    @app.get("/api/profiles/{profile_id}/drives/{storage_id}/{drive_id}")
    async def get_drive(profile_id: str, storage_id: str, drive_id: str):
        """Single-drive refresh, used by the UI to poll during power actions."""
        async with client_for(profile_id) as client:
            return await client.get_drive(storage_id, drive_id)

    @app.post("/api/profiles/{profile_id}/drives/{storage_id}/{drive_id}/power")
    async def power_drive(profile_id: str, storage_id: str, drive_id: str,
                          body: PowerRequest):
        try:
            profile = store.get(profile_id)
        except ProfileNotFound:
            raise HTTPException(404, f"Profile '{profile_id}' not found")
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "server": profile.get("label"),
            "bmc_ip": profile.get("bmc_ip"),
            "storage_id": storage_id,
            "drive_id": drive_id,
            "model": None,
            "serial": None,
            "previous_state": None,
            "action": body.action,
            "result": None,
            "error": None,
            "endpoint": f"/redfish/v1/Systems/1/Storage/{storage_id}"
                        f"/Drives/{drive_id}/Actions/Drive.Reset",
        }

        def finish(result: str, error: str | None = None):
            entry["result"] = result
            entry["error"] = error
            history.append(entry)

        async with client_for(profile_id) as client:
            # Re-discover and classify server-side: the safety decision must
            # never rely on what the browser claims about the drive.
            try:
                drives = _attach_meta(await client.list_drives())
            except RedfishError as exc:
                finish("failure", f"discovery failed: {exc.message}")
                raise

            target = next((d for d in drives
                           if d["storage_id"] == storage_id
                           and d["drive_id"] == drive_id), None)
            if target is None:
                finish("failure", "drive not found on server")
                raise HTTPException(404, f"Drive {storage_id}/{drive_id} not found")

            entry["model"] = target.get("model")
            entry["serial"] = target.get("serial_number")
            entry["previous_state"] = target.get("state")

            role = target.get("role")
            if role == "protected" and not body.override_protected:
                finish("blocked", f"protected drive ({target.get('role_reason')})")
                raise HTTPException(
                    403,
                    "Action blocked: this drive is protected "
                    f"({target.get('role_reason')}). Enable the admin override "
                    "in settings to force it.",
                )
            if role == "unknown" and not body.allow_unknown:
                finish("blocked", f"unknown drive ({target.get('role_reason')})")
                raise HTTPException(
                    403,
                    "Action blocked: this drive's role is unknown "
                    f"({target.get('role_reason')}). Enable actions on unknown "
                    "drives in settings to proceed.",
                )

            try:
                drive = await client.power_drive(storage_id, drive_id, body.action)
            except RedfishError as exc:
                finish("failure", exc.message)
                raise

        state = (drive.get("state") or "").lower()
        expected = ON_STATES if body.action == "on" else OFF_STATES
        confirmed = state in expected
        finish("success" if confirmed else "unconfirmed")
        return {"ok": True, "action": body.action, "confirmed": confirmed,
                "drive": drive}

    # -- local drive metadata (keyed by serial number) ---------------------------

    @app.get("/api/drive-meta")
    async def get_drive_meta():
        return meta_store.all()

    @app.put("/api/drive-meta/{serial}")
    async def put_drive_meta(serial: str, body: DriveMetaUpdate):
        changes = body.model_dump(exclude_unset=True)
        changes.pop("clear_role_override", None)
        if body.clear_role_override:
            changes["role_override"] = None
        return meta_store.update(serial, changes)

    # -- action history -----------------------------------------------------------

    @app.get("/api/history")
    async def get_history(limit: int = 50):
        return history.list(min(max(limit, 1), 200))

    # -- static frontend -------------------------------------------------------

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    return app
