#!/bin/bash
# M-3180 (S-157): kiro's in-session `/model ID` and `/effort LEVEL` on the TUI (v2 engine), offline. Run INSIDE a disposable container
# started with --network none, as an unprivileged user (uid 1000), with a kiro binary dir mounted:
#   docker run -d --name k --network none --memory 2g --cpus 2 --pids-limit 512 --entrypoint sleep \
#     -v <this folder>:/rig:ro -v <dir with kiro-cli[, kiro-cli-chat]>:/opt/kbin:ro -v <out>:/home/u/out <node+tmux+python3 image> infinity
#   docker exec -u 0 k sh -c 'mkdir -p /home/u/bin && cp /opt/kbin/* /home/u/bin/ && chown -R 1000:1000 /home/u'
#   docker exec -u 1000 k bash /rig/switch.sh
# No account and no network: a dummy sign-in token, and kiro's own KIRO_TEST_MODE model list (claude-opus-4.7 … with effort levels)
# in place of the service. The TUI's command handling is kiro's own. Copies the session record to out/session-*.json.
set -u
O=/home/u/out; W=/home/u/work; H=${H:-/home/u/h}; T="tmux -L k"; V=$(/home/u/bin/kiro-cli --version | awk '{print $2}')
mkdir -p $O $W; git -C $W init -q 2>/dev/null
envs="env -i HOME=$H XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share XDG_STATE_HOME=$H/.local/state XDG_CACHE_HOME=$H/.cache PATH=/home/u/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 KIRO_NO_AUTO_UPDATE=1 KIRO_TEST_MODE=1"
cap() { $T capture-pane -p -S -60 -t u | sed 's/[[:space:]]*$//' > "$O/$V-$1.pane.txt"; echo "  captured $V-$1"; }
paste() { $T send-keys -t u -l "$1"; sleep 0.5; $T send-keys -t u Enter; }
record() { local l; l=$(ls -t $H/.kiro/sessions/cli/*.lock 2>/dev/null | head -1); [ -n "$l" ] && cp "${l%.lock}.json" "$O/$V-session-$1.json"; }
rm -rf $H; mkdir -p $H
$T new-session -d -s mk -x 120 -y 40 -c $W "$envs kiro-cli chat --v3; sleep 20"; sleep 7; $T send-keys -t mk C-c; sleep 1; $T send-keys -t mk C-c; sleep 2; $T kill-session -t mk
python3 -I - "$H/.local/share/kiro-cli/data.sqlite3" <<'P'
import sqlite3,sys,json
db=sqlite3.connect(sys.argv[1]); db.execute("create table if not exists auth_kv (key text primary key, value text)")
tok={"access_token":"dummy-access","expires_at":"2099-01-01T00:00:00Z","refresh_token":"dummy-refresh","region":"us-east-1","start_url":"https://view.awsapps.com/start","oauth_flow":"DeviceCode","scopes":["codewhisperer:completions","codewhisperer:conversations"]}
db.execute("insert or replace into auth_kv(key,value) values(?,?)",("kirocli:odic:token",json.dumps(tok))); db.commit()
P
$T new-session -d -s u -x 120 -y 40 -c $W "$envs kiro-cli chat --tui --agent-engine=v2 --trust-all-tools; echo EXITED=\$?; sleep 600"
for i in $(seq 1 60); do p=$($T capture-pane -p -t u); echo "$p" | grep -qF "Yes, I accept" && { $T send-keys -t u Down; sleep 0.8; $T send-keys -t u Enter; sleep 1; }; echo "$p" | grep -qE "describe a task" && break; sleep 0.5; done
sleep 3; cap 0-idle; record 0-idle
# KEEP=1: leave this idle session up for drive.mts (the production gate, checkpoint and verdict) and stop here.
[ "${KEEP:-}" = 1 ] && { echo KEPT; exit 0; }
paste "/model claude-sonnet-4.6"; sleep 4; cap 1-model; record 1-model
paste "/effort low"; sleep 4; cap 2-effort; record 2-effort
paste "/effort bogus"; sleep 4; cap 3-effort-bogus
$T send-keys -t u Escape; sleep 1
paste "/model nosuch-model"; sleep 4; cap 4-model-unknown
$T send-keys -t u Escape; sleep 1
paste "/model claude-sonnet-4"; sleep 4; paste "/effort high"; sleep 4; cap 5-no-effort-model
paste "/quit"; sleep 3; $T kill-server 2>/dev/null; echo RUN-DONE
