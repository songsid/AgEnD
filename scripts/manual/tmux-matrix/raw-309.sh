#!/bin/bash
# M-2457 §2 matrix, "#309 raw": no AgEnD settle. A fresh real Claude Code (mock API) in a private-socket pane; the moment
# its prompt paints: load-buffer + paste-buffer -p + send-keys Enter, no delay. Swallowed = no mock reply within 25 s.
# N trials, each a new pane and a new session. Same RIG as delivery-309.sh (its fleet is stopped first).
#   RIG=<rig script> TMUX_BUNDLE=<bundle dir> N=10 scripts/manual/tmux-matrix/raw-309.sh
# Exits 0 only when all N trials were submitted (and every setup step succeeded).
set -uo pipefail
RIG=${RIG:?the rig script (README.md)}; N=${N:-10}
trap 'rc=$?; "$RIG" stop >/dev/null 2>&1; exit $rc' EXIT
die() { echo "raw-309: $*" >&2; exit 1; }
"$RIG" start >/dev/null || die "the rig did not start"
"$RIG" r 'agend fleet stop >/dev/null 2>&1' || die "the fleet did not stop"
sleep "${SETTLE:-3}"
v=$("$RIG" r 'tmux -V') || die "tmux -V failed in the rig"
case "$v" in "tmux "*) echo "tmux: $v" ;; *) die "tmux -V said '$v'" ;; esac
"$RIG" r 'node -e "
const fs=require(\"fs\"),f=process.env.HOME+\"/.claude.json\",j=JSON.parse(fs.readFileSync(f,\"utf8\"));j.projects??={};
for(let i=1;i<=40;i++){const d=process.env.HOME+\"/w/raw\"+i;fs.mkdirSync(d,{recursive:true});j.projects[d]={...(j.projects[d]||{}),hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};}
fs.writeFileSync(f,JSON.stringify(j));"' || die "the trust entries could not be written"
# One trial, run by the rig as the fleet user (I = the trial, TAG = its unique text, READY = 0.1 s polls for the
# prompt, TRIES = 0.5 s polls for the reply). It exits non-zero on ANY failed
# step — setup, the prompt never painting, a reply already on screen, load/paste/Enter — and says SENT only when this
# trial's own text and then a reply are on the screen.
TRIAL='set -u
fail() { echo "SETUP-FAILED: $*"; tmux -L raw kill-server 2>/dev/null; exit 3; }
tmux -L raw kill-server 2>/dev/null
cd ~/w/raw$I || fail "cd"
tmux -L raw new-session -d -s raw -x 200 -y 50 -c ~/w/raw$I claude || fail "new-session"
# Ready = Claude Code'"'"'s composer: "❯" and a NO-BREAK space (U+00A0). A dialog'"'"'s cursor ("❯ No, exit" in the trust
# dialog) has an ordinary space and is never taken for it: Enter there would answer the dialog.
PROMPT=$(printf "\342\235\257\302\240")
ready=0; p=""
for k in $(seq 1 "$READY"); do
  p=$(tmux -L raw capture-pane -p -t raw) || fail "capture-pane"
  case "$p" in *"$PROMPT"*) ready=1; break ;; esac
  sleep 0.1
done
[ "$ready" = 1 ] || fail "the prompt never painted"
case "$p" in *"mock reply"*) fail "a reply was on screen before this trial submitted" ;; esac
printf "Reply PONG %s" "$TAG" | tmux -L raw load-buffer -b d - || fail "load-buffer"
tmux -L raw paste-buffer -p -d -b d -t raw || fail "paste-buffer"
tmux -L raw send-keys -t raw Enter || fail "send-keys"
for k in $(seq 1 "$TRIES"); do
  p=$(tmux -L raw capture-pane -p -t raw) || fail "capture-pane"
  case "$p" in *"Reply PONG $TAG"*"mock reply"*) echo "SENT $TAG"; tmux -L raw kill-server; exit 0 ;; esac
  sleep 0.5
done
echo SWALLOWED; printf "%s\n" "$p" | grep -v "^ *$" | tail -n 8
tmux -L raw kill-server; exit 1'
ok=0; sw=0
for i in $(seq 1 "$N"); do
  tag="RAW309T$i$RANDOM"
  out=$("$RIG" r "READY=${RAW_READY_TRIES:-300} TRIES=${RAW_WAIT_TRIES:-50} I=$i TAG=$tag; $TRIAL"); rc=$?
  # Counted only when the rig ran the trial cleanly AND the trial saw its own text answered.
  if [ "$rc" = 0 ] && printf '%s\n' "$out" | grep -qx "SENT $tag"; then ok=$((ok+1))
  else sw=$((sw+1)); echo "trial $i (rig exit $rc): $out" | tr '\n' ' '; echo; fi
done
echo "raw #309: $ok of $N submitted, $sw not"
[ "$ok" = "$N" ] || die "$sw of $N trials were not submitted (or not proved)"
echo "raw-309: PASS"
