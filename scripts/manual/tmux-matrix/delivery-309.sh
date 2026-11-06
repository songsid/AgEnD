#!/bin/bash
# M-2457 §2 matrix, "#309 through AgEnD": real CLIs on mock APIs in a throwaway container, with the tmux build under
# test as the container's tmux. Round = a fresh fleet start, then the FIRST message to each of 4 agents at once, then
# two at once to one Claude and one Codex agent; then `agend fleet stop`/`start` and the round again.
#   RIG=<rig script> TMUX_BUNDLE=<bundle tgz or dir> scripts/manual/tmux-matrix/delivery-309.sh
# RIG implements the interface in README.md (start/stop/r/x/send/calls) with agents ccm, ccc (Claude: MCP, CLI mode)
# and cxm, cxc (Codex: MCP, CLI mode) on Telegram topics 101, 102, 201, 202.
set -u
RIG=${RIG:?the rig script (README.md)}
declare -A TOPIC=([ccm]=101 [ccc]=102 [cxm]=201 [cxc]=202)
texts() { "$RIG" calls 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let c=[];try{c=JSON.parse(s)}catch{};console.log((c.result||[]).filter(x=>/sendMessage/.test(x.method)).map(x=>String(x.params?.text??"")).join("\n"))})'; }
waitall() { local lim=$1; shift; local t0; t0=$(date +%s); local ok t tag
  while :; do ok=0; t=$(texts); for tag in "$@"; do echo "$t" | grep -q "PONG-$tag\b" && ok=$((ok+1)); done
    [ "$ok" = $# ] && { echo "  all $# replied in $(( $(date +%s)-t0 ))s"; return 0; }
    [ $(( $(date +%s)-t0 )) -ge "$lim" ] && { echo "  FAIL: $ok of $# replied in ${lim}s; missing: $(for tag in "$@"; do echo "$t" | grep -q "PONG-$tag\b" || printf '%s ' "$tag"; done)"; return 1; }
    sleep 2; done; }
round() { local r=$1 i k
  echo "-- round $r: the first message to each agent right after the fleet is up (4 at once)"
  for i in ccm ccc cxm cxc; do "$RIG" send "${TOPIC[$i]}" "PING-r${r}first$i" >/dev/null & done; wait
  waitall 150 "r${r}firstccm" "r${r}firstccc" "r${r}firstcxm" "r${r}firstcxc"
  echo "-- round $r: two messages at once to ccm and two to cxm"
  for i in ccm cxm; do for k in a b; do "$RIG" send "${TOPIC[$i]}" "PING-r${r}two$i$k" >/dev/null & done; done; wait
  waitall 180 "r${r}twoccma" "r${r}twoccmb" "r${r}twocxma" "r${r}twocxmb"; }
"$RIG" start
echo "tmux in the container: $("$RIG" r 'tmux -V')"
round 1
echo "-- restart: agend fleet stop, start (fresh windows again)"
"$RIG" r 'agend fleet stop >/tmp/stop.out 2>&1; sleep 3; cd ~ && nohup agend fleet start > /tmp/fleet2.out 2>&1 &'
"$RIG" wait-fresh
round 2
"$RIG" stop >/dev/null
