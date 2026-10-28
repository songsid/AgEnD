#!/bin/bash
# Offline muse capture run (1.4.14 audit, 2026-10-28). Run INSIDE a disposable container as an unprivileged user `u`:
#   docker run -d --name m --network none --memory 2g --cpus 2 --pids-limit 256 \
#     -v <dir with this script and mock.py>:/rig:ro -v <binary dir>:/opt/musebin:ro -v <out>:/home/u/out <node+tmux+python3 image> sleep infinity
#   docker exec m sh -c 'mkdir -p /home/u/bin && cp /opt/musebin/muse /home/u/bin/muse && chmod +x /home/u/bin/muse'
#   docker exec m bash /rig/capture.sh
# mock.py is used with its /home/rh/audit paths rewritten to /home/u/audit (sed). Nothing reaches a network or account.
A=/home/u/audit; T="tmux -L audit"; MUSE=/home/u/bin/muse; W=/home/u/work
mkdir -p $A $W /home/u/out
mode(){ printf '%s' "$1" > $A/mockmode; }
args(){ printf '%s' "$1" > $A/mockargs; }
fresh(){ H=/home/u/h-$1; rm -rf $H; mkdir -p $H/.config; }
envline(){ echo "env -i HOME=$H XDG_CONFIG_HOME=$H/.config PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 MUSE_UPDATE_INTERVAL_SECONDS=31536000 $1"; }
start(){ local keyenv=$1; shift; $T kill-session -t m 2>/dev/null || true
  $T new-session -d -s m -x 120 -y 36 -c $W; $T set-option -t m remain-on-exit on >/dev/null
  $T send-keys -t m "clear; $(envline "$keyenv") $MUSE $*; echo EXITED=\$?" Enter; }
paste(){ $T set-buffer -- "$1"; $T paste-buffer -p -t m; sleep 0.3; $T send-keys -t m Enter; }
cap(){ $T capture-pane -p -t m | sed 's/[[:space:]]*$//' | grep -v '^Pane is dead' > /home/u/out/$1.pane.txt; echo "captured $1"; }
# Sessions live under sessions/YYYY/MM/DD/<id> (AgEnD's museSessionDirs walks the same layout).
sid(){ find $H/.local/share/muse/sessions -mindepth 4 -maxdepth 4 -type d -printf "%T@ %f\n" 2>/dev/null | sort -n | tail -1 | cut -d" " -f2; }
sfile(){ find $H/.local/share/muse/sessions -path "*/$1/session.jsonl" | head -1; }
META="--provider meta --base-url http://127.0.0.1:18800 --model mock-model"; PROD="--disable-approval --trust-workspace"; KEY="META_API_KEY=dummy-key"
sed 's#/home/rh/audit#/home/u/audit#g' /rig/mock.py > $A/mock.py
printf '{"data":[{"id":"mock-model"}]}' > $A/mockcatalog
mode text; (python3 $A/mock.py >/home/u/out/mock.stderr 2>&1 &); sleep 1
fresh echo; start "" --provider echo $PROD --echo-delay-ms 3000; sleep 8; cap echo-idle
paste "hello echo"; sleep 1.2; cap echo-busy; sleep 6; cap echo-done
paste "cancel me"; sleep 1; $T send-keys -t m Escape; sleep 1.5; cap echo-after-escape
$T send-keys -t m C-u; sleep 0.3; paste "/quit"; sleep 3; cap echo-quit; ID=$(sid)
start "" --provider echo $PROD --echo-delay-ms 3000 resume $ID; sleep 8; cap echo-resumed; paste "/quit"; sleep 2
fresh rm; start "" --provider echo $PROD resume 01a00000-0000-7000-8000-000000000000; sleep 6; cap resume-missing
fresh trust; start "$KEY" $META; sleep 8; cap first-run-trust-dialog
fresh lo; start "" --trust-workspace; sleep 8; cap logged-out
fresh meta; mode text; start "$KEY" $META $PROD; sleep 9; cap meta-idle; paste "say something"; sleep 6; cap meta-done; paste "/quit"; sleep 2
fresh esc; mode tool; args '{"command":"echo hi","sandbox_permissions":"require_escalated","justification":"audit"}'; start "$KEY" $META $PROD; sleep 9; paste "do it"; sleep 8; cap prod-escalation-denied; paste "/quit"; sleep 2
fresh appr; start "$KEY" $META --trust-workspace; sleep 9; paste "do it"; sleep 8; cap approval-escalated; $T send-keys -t m Escape; sleep 4; cap approval-escalated-after-esc; paste "/quit"; sleep 2
fresh untr; args '{"command":"ls -la"}'; start "$KEY" $META --trust-workspace --approval-mode untrusted; sleep 9; paste "do it"; sleep 8; cap approval-untrusted-staged; $T send-keys -t m 1; sleep 6; cap approval-untrusted-after-1; paste "/quit"; sleep 2
fresh rl; mode 429; start "$KEY" $META $PROD; sleep 9; paste "do it"; sleep 7; cap prod-rate-limited; $T send-keys -t m Escape; sleep 1; paste "/quit"; sleep 2
fresh ul; mode 402; start "$KEY" $META $PROD; sleep 9; paste "do it"; sleep 7; cap prod-usage-limit; paste "/quit"; sleep 2
orphan(){ local name=$1 m=$2 a=$3; fresh $name; mode $m; [ -n "$a" ] && args "$a"; start "$KEY" $META $PROD --disable-sandbox; sleep 9; paste "please do the long thing"; sleep 6; cap $name-inflight
  local id=$(sid); pkill -9 -f "^$MUSE"; sleep 2; mode text; start "$KEY" $META $PROD --disable-sandbox resume $id; sleep 9; cap $name-resumed
  paste "carry on"; sleep 7; cap $name-after-turn; paste "/quit"; sleep 3; cap $name-quit
  local f=$(sfile $id); { grep -m1 route_facts $f; grep orphaned_by_process_loss $f; } > /home/u/out/$name-session.jsonl 2>/dev/null; pkill -f "^$MUSE" 2>/dev/null; sleep 1; }
orphan orphan-stream slow ""
orphan orphan-tool tool '{"command":"sleep 300"}'
orphan orphan-bg tool '{"command":"sleep 300","yield_time_ms":1000}'
$T kill-session -t m 2>/dev/null; echo RUN-DONE
