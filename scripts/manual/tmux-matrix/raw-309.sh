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
ok=0; sw=0
for i in $(seq 1 "$N"); do
  tag="RAW309T$i$RANDOM"
  out=$("$RIG" r "tmux -L raw kill-server 2>/dev/null; cd ~/w/raw$i
    tmux -L raw new-session -d -s raw -x 200 -y 50 -c ~/w/raw$i claude
    for k in \$(seq 1 300); do p=\$(tmux -L raw capture-pane -p -t raw 2>/dev/null); case \"\$p\" in *'for shortcuts'*|*'❯ '*) break;; esac; sleep 0.1; done
    printf 'Reply PONG %s' $tag | tmux -L raw load-buffer -b d - && tmux -L raw paste-buffer -p -d -b d -t raw && tmux -L raw send-keys -t raw Enter
    for k in \$(seq 1 50); do tmux -L raw capture-pane -p -t raw | grep -q \"mock reply\" && { echo SENT; break; }; sleep 0.5; done
    tmux -L raw capture-pane -p -t raw | grep -q \"mock reply\" || { echo SWALLOWED; tmux -L raw capture-pane -p -t raw | grep -v '^\s*\$' | tail -n 8; }
    tmux -L raw kill-server")
  case "$out" in *SENT*) ok=$((ok+1));; *) sw=$((sw+1)); echo "trial $i: $out" | tr '\n' ' '; echo;; esac
done
echo "raw #309: $ok of $N submitted, $sw swallowed"
[ "$ok" = "$N" ] || die "$sw of $N trials were not submitted"
echo "raw-309: PASS"
