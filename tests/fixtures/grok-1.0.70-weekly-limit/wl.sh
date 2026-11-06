#!/bin/bash
# #2872: the weekly-limit modal (mock 402) — what each safe key does. Never Enter, never a digit.
V=$1; W=$2
MOCK_LOG=/out/mock-wl-$V-$W.log node /rig/mock.js & sleep 1
. /rig/lib.sh "$V" "$W" /out/wl-$V-$W
start
cap 01-trust 8; $T send-keys -t g y
cap 02-ready 6
say "error turn b"; cap 03-modal 7
echo "requests after modal: $(grep -c . /out/mock-wl-$V-$W.log)" > $OUT/requests.txt
$T send-keys -t g X; cap 04-after-shift-x 2
echo "requests after Shift+x: $(grep -c . /out/mock-wl-$V-$W.log)" >> $OUT/requests.txt
say "hello after"; cap 05-next-turn 7
echo "requests after next turn: $(grep -c . /out/mock-wl-$V-$W.log)" >> $OUT/requests.txt
# Second episode: Esc first (focus to scrollback), then Shift+x.
say "error turn b"; cap 06-modal2 7
$T send-keys -t g Escape; cap 07-after-esc 1
$T send-keys -t g X; cap 08-esc-then-shift-x 2
echo "requests at end: $(grep -c . /out/mock-wl-$V-$W.log)" >> $OUT/requests.txt
$T kill-server 2>/dev/null
