#!/bin/bash
set -u
BASE="${AUDIT_BASE:-/tmp/agend-grok-audit-1077}"
V=$1; W=$2
OUT="$BASE/out/wl-$V-$W"
mkdir -p "$OUT"
MOCK_LOG="$OUT/mock.log" node "$BASE/rig/mock.cjs" &
MOCK_PID=$!
sleep 1
. "$BASE/rig/lib.sh" "$V" "$W" "$OUT"
start
cap 01-trust 8; $T send-keys -t g y
cap 02-ready 6
say "error turn b"; cap 03-modal 7
echo "requests after modal: $(grep -c . "$OUT/mock.log")" > "$OUT/requests.txt"
$T send-keys -t g X; cap 04-after-shift-x 2
echo "requests after Shift+x: $(grep -c . "$OUT/mock.log")" >> "$OUT/requests.txt"
say "hello after"; cap 05-next-turn 7
echo "requests after next turn: $(grep -c . "$OUT/mock.log")" >> "$OUT/requests.txt"
say "error turn b"; cap 06-modal2 7
$T send-keys -t g Escape; cap 07-after-esc 1
$T send-keys -t g X; cap 08-esc-then-shift-x 2
echo "requests at end: $(grep -c . "$OUT/mock.log")" >> "$OUT/requests.txt"
$T kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
echo "WL_DONE $V $W"
cat "$OUT/requests.txt"
