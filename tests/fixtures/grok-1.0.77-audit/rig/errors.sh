#!/bin/bash
# Recapture error turns WITHOUT opening the weekly modal first (402 sticks if Esc-then-X).
set -u
BASE="${AUDIT_BASE:-/tmp/agend-grok-audit-1077}"
V=$1; W=$2
OUT="$BASE/out/$V-$W-errors"
mkdir -p "$OUT"
MOCK_LOG="$OUT/mock.log" node "$BASE/rig/mock.cjs" &
MOCK_PID=$!
sleep 1
. "$BASE/rig/lib.sh" "$V" "$W" "$OUT"
start
cap 01-trust 8; $T send-keys -t g y
cap 02-ready 6
for L in a c d e f g h; do
  case $L in a) S=401;; c) S=403;; d) S=426;; e) S=429;; f) S=500;; g) S=403-usage;; h) S=429-text;; esac
  say "error turn $L"; cap 07-err-$S 7
  if [ $L = f ]; then $T send-keys -t g C-c; sleep 1; fi
  $T send-keys -t g C-u; sleep 0.3
done
say "use tool please"; cap 09-tool 8
$T kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
echo "ERRORS_DONE $V $W"
ls "$OUT"/*.pane.txt
