#!/bin/bash
# M-3180 (S-156): muse's in-session `/model <id>` and `/effort <level>`, on the same offline rig as capture.sh (run INSIDE the disposable
# container, as capture.sh says: --network none, the binary at /home/u/bin/muse, this folder at /rig, out at /home/u/out). The mock's catalog
# lists two models so a switch has somewhere to go; a turn after the switches shows which model and effort the next request carried.
A=/home/u/audit; T="tmux -L audit"; MUSE=/home/u/bin/muse; W=/home/u/work
mkdir -p $A $W /home/u/out
H=/home/u/h-switch; rm -rf $H; mkdir -p $H/.config
envline(){ echo "env -i HOME=$H XDG_CONFIG_HOME=$H/.config PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 MUSE_UPDATE_INTERVAL_SECONDS=31536000 $1"; }
paste(){ $T set-buffer -- "$1"; $T paste-buffer -p -t m; sleep 0.3; $T send-keys -t m Enter; }
cap(){ $T capture-pane -p -S -80 -t m | sed 's/[[:space:]]*$//' | grep -v '^Pane is dead' > /home/u/out/$1.pane.txt; echo "captured $1"; }
sed 's#/home/rh/audit#/home/u/audit#g' /rig/mock.py > $A/mock.py
printf 'text' > $A/mockmode
printf '{"data":[{"id":"mock-model"},{"id":"mock-alt"}]}' > $A/mockcatalog
(python3 $A/mock.py >/home/u/out/mock.stderr 2>&1 &); sleep 1
$T kill-session -t m 2>/dev/null || true
$T new-session -d -s m -x 120 -y 36 -c $W; $T set-option -t m remain-on-exit on >/dev/null
$T send-keys -t m "clear; $(envline META_API_KEY=dummy-key) $MUSE --provider meta --base-url http://127.0.0.1:18800 --model mock-model --disable-approval --trust-workspace; echo EXITED=\$?" Enter
sleep 9; cap switch-0-idle
paste "/model mock-alt"; sleep 3; cap switch-1-model
paste "/effort high"; sleep 3; cap switch-2-effort
paste "/effort bogus"; sleep 3; cap switch-3-effort-bogus
paste "/model nosuch-model"; sleep 3; cap switch-4-model-unknown
paste "say something"; sleep 7; cap switch-5-turn
paste "/model mock-model"; sleep 3; paste "/effort low"; sleep 3; cap switch-6-back
paste "say more"; sleep 7; cap switch-7-turn
S=$(find $H/.local/share/muse/sessions -name session.jsonl 2>/dev/null | head -1); [ -n "$S" ] && cp "$S" /home/u/out/session.jsonl
cp $A/mock.log /home/u/out/mock.log
paste "/quit"; sleep 2; $T kill-session -t m 2>/dev/null; echo RUN-DONE
