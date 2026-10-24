#!/bin/bash
# grok worker controller (1.0.70's new subcommand, never launched by AgEnD): its Ctrl+C prompts, offline (--network none).
V=$1; OUT=/out/$V-controller; mkdir -p $OUT; export HOME=/tmp/home-ctl; mkdir -p $HOME; T="tmux -L grokaudit"
$T new-session -d -s c -x 120 -y 30 -e HOME=$HOME -e CURSOR_API_KEY=dummy-audit-key "/bin/grok-$V worker controller --all-pools --spawn /bin/true"
$T set-option -t c remain-on-exit on >/dev/null
sleep 6; $T capture-pane -p -t c > $OUT/01-running.pane.txt
$T send-keys -t c C-c; sleep 2; $T capture-pane -p -t c > $OUT/02-ctrl-c.pane.txt
$T send-keys -t c C-c; sleep 2; $T capture-pane -p -t c > $OUT/03-ctrl-c-2.pane.txt
$T send-keys -t c C-c; sleep 2; $T capture-pane -p -t c > $OUT/04-ctrl-c-3.pane.txt
$T kill-server
