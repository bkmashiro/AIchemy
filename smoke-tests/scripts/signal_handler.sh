#!/usr/bin/env bash
# smoke: signal_handler — traps SIGTERM, does cleanup, exits gracefully
set -euo pipefail

TMPFILE=$(mktemp /tmp/smoke_signal_XXXXXX)
echo "[smoke/signal_handler] working file: $TMPFILE"

cleanup() {
    echo "[smoke/signal_handler] SIGTERM received — cleaning up"
    rm -f "$TMPFILE"
    echo "[smoke/signal_handler] cleanup done — exiting gracefully"
    exit 0
}

trap cleanup SIGTERM SIGINT

echo "[smoke/signal_handler] running — send SIGTERM to test handler"
echo "working data" > "$TMPFILE"

# Simulate a long-running job
for i in $(seq 1 60); do
    echo "[smoke/signal_handler] tick $i/60"
    sleep 5
done

# Normal completion (if not signalled)
rm -f "$TMPFILE"
echo "[smoke/signal_handler] completed normally"
exit 0
