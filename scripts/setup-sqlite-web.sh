#!/usr/bin/env bash
# setup-sqlite-web.sh — Install sqlite-web as a companion service to NanoClaw.
# Binds to 127.0.0.1:8088 (read-only). Access via SSH tunnel:
#   ssh -L 8088:localhost:8088 user@your-server
# Then open http://localhost:8088 in your browser.

set -euo pipefail

SERVICE_NAME="sqlite-web"
SERVICE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sqlite-web.service"

echo "Installing sqlite-web..."
pip3 install sqlite-web

echo "Registering systemd service..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/sqlite-web.service
sudo systemctl daemon-reload
sudo systemctl enable sqlite-web
sudo systemctl start sqlite-web

echo ""
echo "Done. sqlite-web is running at http://127.0.0.1:8088"
echo ""
echo "To access remotely, SSH tunnel:"
echo "  ssh -L 8088:localhost:8088 user@your-server"
echo "Then open http://localhost:8088"
echo ""
echo "Service commands:"
echo "  sudo systemctl status sqlite-web"
echo "  sudo systemctl restart sqlite-web"
echo "  sudo systemctl stop sqlite-web"
