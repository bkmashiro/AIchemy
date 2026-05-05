#!/usr/bin/env bash
# smoke: success_slow — exits 0 after 30s
set -euo pipefail
echo "[smoke/success_slow] start"
for i in $(seq 1 6); do
  echo "[smoke/success_slow] tick $i/6"
  sleep 5
done
echo "[smoke/success_slow] done"
exit 0
