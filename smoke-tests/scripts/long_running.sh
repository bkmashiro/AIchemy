#!/usr/bin/env bash
# smoke: long_running — runs 5 minutes with periodic stdout
set -euo pipefail

DURATION=300  # 5 minutes
INTERVAL=15   # print every 15s
STEPS=$((DURATION / INTERVAL))

echo "[smoke/long_running] start — will run ${DURATION}s"

for i in $(seq 1 $STEPS); do
    ELAPSED=$((i * INTERVAL))
    PCT=$(( (i * 100) / STEPS ))
    echo "[smoke/long_running] step $i/$STEPS | elapsed ${ELAPSED}s | progress ${PCT}%"
    sleep $INTERVAL
done

echo "[smoke/long_running] done"
exit 0
