#!/usr/bin/env bash
# Alchemy v2 deploy: build → kill old → start server + tunnel
# Server serves both API and static web files.
set -e
cd "$(dirname "$0")"

PORT="${ALCHEMY_PORT:-3002}"
STATE_FILE="${ALCHEMY_STATE:-/workspace/extra/projects/alchemy-v2/state-v2.json}"
LOG_FILE="/tmp/alchemy-v2-server.log"
TUNNEL_LOG="/tmp/cloudflared-v2.log"

# Read tunnel token from v1 config (shared CF account)
TUNNEL_TOKEN=$(node -e "
const yaml = require('yaml');
const cfg = yaml.parse(require('fs').readFileSync('/workspace/extra/projects/alchemy/alchemy.config.yaml','utf8'));
process.stdout.write(cfg.tunnel?.token || '');
" 2>/dev/null || true)

echo "==> Stopping old v2 processes..."
pkill -f "node server/dist/index.js" 2>/dev/null || true
sleep 1

echo "==> Building server..."
cd server && npx tsc 2>&1 | tail -3 && cd ..

echo "==> Building web..."
cd web && npx vite build 2>&1 | tail -5 && cd ..

echo "==> Copying web → server/dist/dashboard..."
rm -rf server/dist/dashboard
cp -r web/dist server/dist/dashboard

echo "==> Starting server on :${PORT}..."
PORT="$PORT" STATE_FILE="$STATE_FILE" ALCHEMY_TOKEN="${ALCHEMY_TOKEN:-alchemy-v2-token}" \
  nohup node server/dist/index.js >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "    PID=$SERVER_PID"

sleep 3

# Health check
if NO_PROXY="*" curl -s "http://localhost:${PORT}/health" | grep -q '"ok":true'; then
  echo "    ✓ Server healthy"
else
  echo "    ✗ Server failed to start. Check $LOG_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi

# CF tunnel — only restart if not already running
if [ -n "$TUNNEL_TOKEN" ]; then
  if pgrep -f "cloudflared tunnel run" >/dev/null; then
    echo "    ✓ Tunnel already running (shared with v1)"
  else
    echo "==> Starting Cloudflare tunnel..."
    nohup cloudflared tunnel run --token "$TUNNEL_TOKEN" >> "$TUNNEL_LOG" 2>&1 &
    echo "    Tunnel started (PID=$!)"
  fi
else
  echo "    ⚠ No tunnel token found"
fi

echo ""
echo "==> Status:"
pgrep -f "node server/dist/index.js" >/dev/null && echo "    ✓ Server  :${PORT}" || echo "    ✗ Server failed"
pgrep -f "cloudflared tunnel" >/dev/null && echo "    ✓ Tunnel  running" || echo "    ✗ Tunnel not running"
echo ""
echo "    State: $STATE_FILE"
echo "    Logs:  $LOG_FILE"
echo "    Token: ${ALCHEMY_TOKEN:-alchemy-v2-token}"
echo ""
echo "Done. Stubs connect to: wss://<tunnel-domain>/stubs"
