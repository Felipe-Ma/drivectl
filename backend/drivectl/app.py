"""FastAPI application: JSON API under /api plus the static frontend."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Config
from .redfish import RedfishClient, RedfishError
from .store import ProfileNotFound, ProfileStore

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


def create_app(config: Config) -> FastAPI:
    store = ProfileStore(config.data_path)
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

    @app.get("/api/profiles/{profile_id}/drives")
    async def list_drives(profile_id: str):
        async with client_for(profile_id) as client:
            return await client.list_drives()

    @app.post("/api/profiles/{profile_id}/drives/{storage_id}/{drive_id}/power")
    async def power_drive(profile_id: str, storage_id: str, drive_id: str,
                          body: PowerRequest):
        async with client_for(profile_id) as client:
            drive = await client.power_drive(storage_id, drive_id, body.action)
        return {"ok": True, "action": body.action, "drive": drive}

    # -- static frontend -------------------------------------------------------

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    return app
