# drivectl

A self-hosted web GUI to view the drives on HPE servers (via each server's iLO
Redfish API) and power individual drives **on** or **off**.

- **Backend:** Python 3.10+ / FastAPI / httpx (async), served by uvicorn.
- **Frontend:** plain HTML/JS + Tailwind CSS, pre-built and served as static
  files by the same FastAPI process — one command runs everything.
- **HPE only:** talks directly to the iLO Redfish schema
  (`/redfish/v1/Systems/1/Storage/...` and `Drive.Reset` with
  `ForceOn` / `ForceOff`).

All Redfish traffic goes through the backend: it handles the iLO's HTTP Basic
Auth and self-signed TLS certificates (verification off by default, per-profile
toggle), and BMC credentials are never sent to the browser.

## Install

Python 3.10+ required. No Node/npm needed — the frontend is pre-built.

```bash
git clone <this repo> && cd drivectl
python -m venv .venv && source .venv/bin/activate
pip install -e .            # or: pip install -r requirements.txt
```

## Run

```bash
python -m drivectl                      # defaults: 0.0.0.0:8722, ./data
# or with a config file:
cp config.example.yaml config.yaml
python -m drivectl --config config.yaml
# or via the console script:
drivectl --config config.yaml --port 9000
```

Then open `http://<host>:8722`, click **Add server**, and enter your iLO's
IP/hostname and credentials. Use **Test connection** before saving.

## Configuration

`config.yaml` (see `config.example.yaml`):

```yaml
host: 0.0.0.0        # interface to bind
port: 8722           # port to listen on
data_dir: ./data     # where the profile store (profiles.json) lives
verify_tls: false    # global default for new profiles
log_level: info
```

Priority (lowest → highest): built-in defaults → config file → environment
variables (`DRIVECTL_HOST`, `DRIVECTL_PORT`, `DRIVECTL_DATA_DIR`,
`DRIVECTL_VERIFY_TLS`, `DRIVECTL_LOG_LEVEL`) → CLI flags (`--host`, `--port`).

## Credentials are stored in plaintext

BMC usernames and passwords are stored **unencrypted** in
`<data_dir>/profiles.json`, written with `0600` permissions. This is a
deliberate design choice for a trusted dev box — there is no encryption,
keyring, or secret manager. Protect the host and the data directory
accordingly. A one-line reminder is printed at startup.

## Rebuilding the frontend CSS (contributors only)

The compiled Tailwind stylesheet (`backend/drivectl/static/tailwind.css`) is
committed, so end users never need a frontend build. If you change classes in
`index.html` / `app.js`:

```bash
./frontend/build.sh    # downloads the standalone Tailwind CLI on first run
```

## Running as a systemd service

A unit file is included (`drivectl.service`). It assumes the repo lives at
`/opt/drivectl` and a `config.yaml` exists there:

```bash
sudo cp drivectl.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now drivectl
```

Useful commands:

```bash
systemctl status drivectl        # is it running?
journalctl -u drivectl -f        # follow logs
sudo systemctl restart drivectl  # after config changes
```

The service starts at boot, restarts automatically on failure, and binds to
`0.0.0.0:8722` by default, so the UI is reachable from other machines at
`http://<server-ip>:8722`.

## Docker (optional)

```bash
docker compose up --build       # serves on port 8722, profiles persisted in ./data
```

Change the port by editing `ports:` in `docker-compose.yml` or setting
`DRIVECTL_PORT`.

## API

The frontend uses a JSON API you can also script against (interactive docs at
`/api/docs`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/profiles` | List profiles (passwords never returned) |
| POST | `/api/profiles` | Create `{label, bmc_ip, username, password, verify_tls}` |
| PUT / DELETE | `/api/profiles/{id}` | Edit / remove a profile |
| POST | `/api/profiles/{id}/test` | Test connection/auth to the iLO |
| GET | `/api/profiles/{id}/drives` | Discover + classify all drives (`role`: test/protected/unknown) |
| GET | `/api/profiles/{id}/drives/{storage_id}/{drive_id}` | Single-drive refresh (used for polling) |
| POST | `/api/profiles/{id}/drives/{storage_id}/{drive_id}/power` | `{"action":"on"\|"off"}` → `ForceOn`/`ForceOff`; blocked for protected/unknown drives unless override flags are set |
| GET / PUT | `/api/drive-meta` / `/api/drive-meta/{serial}` | Local labels/notes/favorite/role override, keyed by serial |
| GET | `/api/history` | Recent power action attempts (success/failure/blocked) |

## Protected drives & safety

drivectl is a **test-focused drive power tool**, so likely boot/system drives
are automatically classified as `protected` and hidden in a collapsed section
with no power controls:

- boot/system terms (`boot`, `os`, `system`, `ns204`, `b140i`) in the drive
  name/model/description/location or its controller name;
- a pair of exactly two small NVMe drives (≤ ¼ the largest drive) is treated
  as a boot mirror;
- manual role overrides (test/protected/unknown), stored **by serial number**.

The backend re-classifies on every power request and refuses to act on
protected or unknown drives unless the explicit override flags are sent
(surfaced in the UI under *Settings*). Every attempt — including blocked
ones — is logged to `<data_dir>/history.json` and shown in *Recent actions*.


## Troubleshooting

- **"Authentication failed (401)"** — wrong iLO username/password; fix the
  profile (Edit) and use *Test connection*.
- **"TLS certificate verification failed"** — the iLO uses a self-signed cert;
  uncheck *Verify TLS certificate* on the profile (this is the default).
- **"Connection timed out" / "Could not connect"** — BMC unreachable from the
  drivectl host; check IP, VLAN/firewall, and that iLO is up
  (`curl -k https://<bmc_ip>/redfish/v1/` from the same host).
- **Drive state doesn't change immediately** — the backend re-polls a few times
  with backoff after a power action, but some drives take longer; hit
  **Refresh** (or enable auto-refresh).
- **Empty drive list** — the controller may expose no drives, or the system id
  isn't `1` (drivectl targets iLO's fixed `Systems/1`).
- **Port already in use** — change `port:` in `config.yaml` or pass `--port`.
