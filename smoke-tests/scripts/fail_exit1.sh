#!/usr/bin/env bash
# smoke: fail_exit1 — exits 1 after 2s
echo "[smoke/fail_exit1] start"
sleep 2
echo "[smoke/fail_exit1] simulating failure"
exit 1
