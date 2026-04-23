#!/usr/bin/env bash
# Alchemy v2 deploy: build → kill old → start server + web + tunnel
set -e
cd "$(dirname "$0")"

echo "==> Stopping old processes..."
pkill -f "node dist/index.js" 2>/dev/null || true
pkill -f "npx serve dist" 2>/dev/null || true
pkill -f "serve dist" 2>/dev/null || true
pkill -f "cloudflared tunnel run" 2>/dev/null || true
sleep 2

echo "==> Building server..."
cd server && npm run build 2>&1 | tail -3 && cd ..

echo "==> Building web..."
cd web && npx vite build 2>&1 | tail -3 && cd ..

# Read tunnel token from v1 config (shared CF tunnel)
TUNNEL_TOKEN=$(cd /workspace/extra/projects/alchemy && node -e "
const yaml = require('yaml');
const cfg = yaml.parse(require('fs').readFileSync('alchemy.config.yaml','utf8'));
process.stdout.write(cfg.tunnel?.token || '');
")

echo "==> Starting server on :3002..."
cd server && nohup node dist/index.js >> /tmp/alchemy-v2-server.log 2>&1 &
cd ..
SERVER_PID=$!

echo "==> Starting web on :3000..."
cd web && nohup npx serve dist -l 3000 -s >> /tmp/alchemy-v2-web.log 2>&1 &
cd ..
WEB_PID=$!

if [ -n "$TUNNEL_TOKEN" ]; then
  echo "==> Starting Cloudflare tunnel..."
  nohup cloudflared tunnel run --token "$TUNNEL_TOKEN" >> /tmp/cloudflared-v2.log 2>&1 &
  TUNNEL_PID=$!
  echo "    Tunnel started (PID=$TUNNEL_PID)"
else
  echo "    No tunnel token, skipping."
fi

sleep 4

echo ""
echo "==> Status:"
pgrep -f "node dist/index.js" >/dev/null && echo "    ✓ Server   (port 3002)" || echo "    ✗ Server failed"
pgrep -f "serve dist" >/dev/null && echo "    ✓ Web      (port 3000)" || echo "    ✗ Web failed"
pgrep -f "cloudflared tunnel" >/dev/null && echo "    ✓ Tunnel   (alchemy-v2.yuzhes.com)" || echo "    ✗ Tunnel not running"
echo ""
echo "Done."
