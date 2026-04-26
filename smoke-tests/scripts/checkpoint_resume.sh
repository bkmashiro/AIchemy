#!/usr/bin/env bash
# smoke: checkpoint_resume — writes checkpoint on first run, detects it on re-run
set -euo pipefail

CKPT_DIR="${SMOKE_CKPT_DIR:-/tmp/smoke_checkpoint}"
CKPT_FILE="$CKPT_DIR/checkpoint.json"

mkdir -p "$CKPT_DIR"

if [[ -f "$CKPT_FILE" ]]; then
    echo "[smoke/checkpoint_resume] checkpoint detected — resuming"
    STEP=$(python3 -c "import json,sys; d=json.load(open('$CKPT_FILE')); print(d['step'])")
    echo "[smoke/checkpoint_resume] resuming from step $STEP"
    sleep 2
    echo "[smoke/checkpoint_resume] resumed run complete"
else
    echo "[smoke/checkpoint_resume] no checkpoint — fresh run"
    sleep 2
    STEP=100
    python3 -c "
import json
with open('$CKPT_FILE', 'w') as f:
    json.dump({'step': $STEP, 'loss': 0.42, 'run': 'smoke_test'}, f)
"
    echo "[smoke/checkpoint_resume] checkpoint written at step $STEP"
    echo "[smoke/checkpoint_resume] first run complete — re-run to test resume"
fi

exit 0
