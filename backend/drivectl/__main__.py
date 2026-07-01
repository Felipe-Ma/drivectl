"""CLI entry point: python -m drivectl --config config.yaml"""

from __future__ import annotations

import argparse
import logging
import sys

import uvicorn

from .app import create_app
from .config import load_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="drivectl",
        description="Web GUI to power HPE server drives on/off via iLO Redfish.",
    )
    parser.add_argument("--config", metavar="FILE", help="Path to config.yaml")
    parser.add_argument("--host", help="Interface to bind (overrides config file)")
    parser.add_argument("--port", type=int, help="Port to listen on (overrides config file)")
    args = parser.parse_args(argv)

    try:
        config = load_config(config_file=args.config, host=args.host, port=args.port)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    logging.basicConfig(
        level=config.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    app = create_app(config)
    store_path = config.data_path / "profiles.json"
    print(f"drivectl: BMC credentials are stored locally in plaintext at {store_path} (mode 0600)")
    print(f"drivectl: listening on http://{config.host}:{config.port}")

    uvicorn.run(app, host=config.host, port=config.port, log_level=config.log_level)
    return 0


if __name__ == "__main__":
    sys.exit(main())
