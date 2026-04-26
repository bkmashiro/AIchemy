#!/usr/bin/env bash
# smoke: success_fast — exits 0 after 3s
set -euo pipefail
echo "[smoke/success_fast] start"
sleep 3
echo "[smoke/success_fast] done"
exit 0
