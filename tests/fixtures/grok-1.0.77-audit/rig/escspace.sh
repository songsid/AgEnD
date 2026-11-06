#!/bin/bash
# 1.0.77: Esc (scrollback) then Space (legend says Tab/Space:question) then X.
set -u
BASE="${AUDIT_BASE:-/tmp/agend-grok-audit-1077}"
V=1.0.77; W=120
OUT="$BASE/out/escspace-$V"
mkdir -p "$OUT"
MOCK_LOG="$OUT/mock.log" node "$BASE/rig/mock.cjs" &
MOCK_PID=$!
sleep 1
. "$BASE/rig/lib.sh" "$V" "$W" "$OUT"
start
cap 01-trust 8; $T send-keys -t g y
sleep 6
say "error turn b"; cap 03-modal 7
echo "=== after Esc ==="
$T send-keys -t g Escape; cap 07-after-esc 1
tail -3 "$OUT/07-after-esc.pane.txt"
echo "=== after Space ==="
$T send-keys -t g -l " "
cap 08-after-space 1
tail -3 "$OUT/08-after-space.pane.txt"
echo "=== after X ==="
$T send-keys -t g X; cap 09-after-x 2
tail -8 "$OUT/09-after-x.pane.txt"
$T kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
echo ESCSPACE_DONE
