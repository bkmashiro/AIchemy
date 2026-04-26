#!/usr/bin/env bash
# smoke: multi_tag — many tags for testing tag-based dispatch
set -euo pipefail
echo "[smoke/multi_tag] start"
echo "[smoke/multi_tag] tags: smoke, a40, high-mem, priority"
echo "[smoke/multi_tag] hostname: $(hostname)"
echo "[smoke/multi_tag] uptime: $(uptime)"
sleep 3
echo "[smoke/multi_tag] done"
exit 0
