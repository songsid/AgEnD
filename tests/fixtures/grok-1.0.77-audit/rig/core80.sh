#!/bin/bash
# 80-col: trust, ready, busy, 429, weekly modal + Shift+x.
set -u
BASE="${AUDIT_BASE:-/tmp/agend-grok-audit-1077}"
V=$1; W=80
OUT="$BASE/out/$V-$W"
mkdir -p "$OUT"
MOCK_LOG="$OUT/mock.log" node "$BASE/rig/mock.cjs" &
MOCK_PID=$!
sleep 1
. "$BASE/rig/lib.sh" "$V" "$W" "$OUT"
start
cap 01-trust 8; $T send-keys -t g y
cap 02-ready 6
say "please stall a"; cap 03-busy-a 3; cap 04-done 9
say "error turn e"; cap 07-err-429 7
$T send-keys -t g C-u; sleep 0.3
say "error turn b"; cap 07-err-402 7
$T send-keys -t g X; cap 07-err-402-after-x 2
$T kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
echo "CORE80_DONE $V"
ls "$OUT"/*.pane.txt
