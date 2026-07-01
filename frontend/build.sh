#!/usr/bin/env bash
# Rebuild backend/drivectl/static/tailwind.css from the app's markup.
# Only needed when you change index.html / app.js classes — the compiled CSS
# is committed, so end users never need this.
set -euo pipefail
cd "$(dirname "$0")"

CLI=./tailwindcss
if [ ! -x "$CLI" ]; then
  ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] && ARCH=arm64 || ARCH=x64
  URL="https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-${ARCH}"
  echo "Downloading Tailwind standalone CLI from $URL"
  curl -fsSL -o "$CLI" "$URL"
  chmod +x "$CLI"
fi

"$CLI" -i input.css -o ../backend/drivectl/static/tailwind.css --minify
echo "Built ../backend/drivectl/static/tailwind.css"
