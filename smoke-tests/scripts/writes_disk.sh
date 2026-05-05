#!/usr/bin/env bash
# smoke: writes_disk — writes ~50MB to a temp dir, then cleans up
set -euo pipefail

TMPDIR=$(mktemp -d /tmp/smoke_io_XXXXXX)
echo "[smoke/writes_disk] using temp dir: $TMPDIR"

# Write 50 files of 1MB each
for i in $(seq 1 50); do
  dd if=/dev/urandom bs=1M count=1 2>/dev/null > "$TMPDIR/chunk_$(printf '%02d' $i).bin"
done

TOTAL=$(du -sh "$TMPDIR" | cut -f1)
echo "[smoke/writes_disk] wrote ~50MB total: $TOTAL"

# Verify files exist
COUNT=$(ls "$TMPDIR" | wc -l)
echo "[smoke/writes_disk] file count: $COUNT"

# Cleanup
rm -rf "$TMPDIR"
echo "[smoke/writes_disk] cleaned up, done"
exit 0
