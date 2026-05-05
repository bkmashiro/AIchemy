#!/usr/bin/env bash
# Alchemy v2 deploy: build → kill old → start server (tunnel managed by server)
# Usage: ./deploy.sh [--deploy-stubs]
set -e
cd "$(dirname "$0")"

PORT="${ALCHEMY_PORT:-3002}"
STATE_FILE="${ALCHEMY_STATE:-/workspace/extra/projects/alchemy-v2/state-v2.json}"
LOG_FILE="/tmp/alchemy-v2-server.log"

echo "==> Stopping old v2 processes..."
pkill -f "node server/dist/index.js" 2>/dev/null || true
# Server manages tunnel — kill it too if orphaned
pkill -f "cloudflared tunnel run" 2>/dev/null || true
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
  DEPLOY_CONFIG="$(pwd)/deploy-config.yaml" \
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

# Check tunnel status via API
TUNNEL_STATUS=$(NO_PROXY="*" curl -s -H "Authorization: Bearer ${ALCHEMY_TOKEN:-alchemy-v2-token}" \
  "http://localhost:${PORT}/api/deploy/tunnel" 2>/dev/null || echo '{}')
if echo "$TUNNEL_STATUS" | grep -q '"running":true'; then
  echo "    ✓ Tunnel running (managed by server)"
else
  echo "    ⚠ Tunnel not running — check deploy-config.yaml"
fi

# Optional: deploy stubs via API
if [[ "$*" == *"--deploy-stubs"* ]]; then
  echo ""
  echo "==> Deploying stubs via API..."
  NO_PROXY="*" curl -s -X POST \
    -H "Authorization: Bearer ${ALCHEMY_TOKEN:-alchemy-v2-token}" \
    -H "Content-Type: application/json" \
    -d "{\"server_url\": \"wss://alchemy-v2.yuzhes.com\"}" \
    "http://localhost:${PORT}/api/deploy/stubs" | python3 -m json.tool 2>/dev/null || echo "    ✗ Deploy failed"
fi

echo ""
echo "==> Status:"
pgrep -f "node server/dist/index.js" >/dev/null && echo "    ✓ Server  :${PORT}" || echo "    ✗ Server failed"
echo "$TUNNEL_STATUS" | grep -q '"running":true' && echo "    ✓ Tunnel  running" || echo "    ✗ Tunnel not running"
echo ""
echo "    State: $STATE_FILE"
echo "    Logs:  $LOG_FILE"
echo "    Token: ${ALCHEMY_TOKEN:-alchemy-v2-token}"
echo "    Config: $(pwd)/deploy-config.yaml"
echo ""
echo "Done. Stubs connect to: wss://alchemy-v2.yuzhes.com/stubs"
