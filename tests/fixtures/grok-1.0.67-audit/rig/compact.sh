#!/bin/bash
# Compaction failures (1.0.67 paints "Compaction failed: …"): the mock fails the compaction request with a chosen status.
V=$1; W=${2:-120}
export COMPACT_ERR_FILE=/tmp/compact-err-$V-$W
MOCK_LOG=/out/mock-compact-$V-$W.log node /rig/mock.js & sleep 1
. /rig/lib.sh "$V" "$W" /out/$V-compact-$W
start
cap 01-trust 8; $T send-keys -t g y; sleep 6
say "hello one"; cap 02-turn 5
for L in a g f b; do
  echo $L > $COMPACT_ERR_FILE
  say "/compact "; cap 60-compact-fail-$L 8; cap 61-compact-fail-$L-later 6
  $T send-keys -t g Escape; sleep 0.5; $T send-keys -t g C-u; sleep 0.3
  rm -f $COMPACT_ERR_FILE; say "hello after $L"; cap 62-turn-after-$L 5
done
$T kill-server 2>/dev/null
