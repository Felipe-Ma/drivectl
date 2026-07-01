"""Configuration loading: config file -> environment variables -> CLI flags."""

from __future__ import annotations

import os
from dataclasses import dataclass, fields
from pathlib import Path

import yaml

DEFAULTS = {
    "host": "0.0.0.0",
    "port": 8722,
    "data_dir": "./data",
    "verify_tls": False,
    "log_level": "info",
}

ENV_PREFIX = "DRIVECTL_"


def _coerce_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Config:
    host: str = DEFAULTS["host"]
    port: int = DEFAULTS["port"]
    data_dir: str = DEFAULTS["data_dir"]
    verify_tls: bool = DEFAULTS["verify_tls"]
    log_level: str = DEFAULTS["log_level"]

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir).expanduser().resolve()


def load_config(config_file: str | None = None,
                host: str | None = None,
                port: int | None = None) -> Config:
    values = dict(DEFAULTS)

    if config_file:
        path = Path(config_file)
        if not path.is_file():
            raise FileNotFoundError(f"Config file not found: {path}")
        loaded = yaml.safe_load(path.read_text()) or {}
        if not isinstance(loaded, dict):
            raise ValueError(f"Config file {path} must contain a YAML mapping")
        for key in values:
            if key in loaded and loaded[key] is not None:
                values[key] = loaded[key]

    for key in values:
        env_val = os.environ.get(ENV_PREFIX + key.upper())
        if env_val is not None:
            values[key] = env_val

    if host is not None:
        values["host"] = host
    if port is not None:
        values["port"] = port

    values["port"] = int(values["port"])
    values["verify_tls"] = _coerce_bool(values["verify_tls"])
    values["host"] = str(values["host"])
    values["data_dir"] = str(values["data_dir"])
    values["log_level"] = str(values["log_level"]).lower()

    return Config(**{f.name: values[f.name] for f in fields(Config)})
