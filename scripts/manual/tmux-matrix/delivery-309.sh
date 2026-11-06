#!/bin/bash
# M-2457 §2 matrix, "#309 through AgEnD": real CLIs on mock APIs in a throwaway container, with the tmux build under
# test as the container's tmux. Round = a fresh fleet start, then the FIRST message to each of 4 agents at once, then
# two at once to one Claude and one Codex agent; then `agend fleet stop`/`start` and the round again.
#   RIG=<rig script> TMUX_BUNDLE=<bundle dir> scripts/manual/tmux-matrix/delivery-309.sh
# RIG implements the interface in README.md (start/stop/r/x/send/calls/wait-fresh) with agents ccm, ccc (Claude: MCP,
# CLI mode) and cxm, cxc (Codex: MCP, CLI mode) on Telegram topics 101, 102, 201, 202.
# Exits 0 only when every setup step, every send and every wait succeeded (WAIT_FIRST/WAIT_TWO: the limits, seconds).
set -uo pipefail
RIG=${RIG:?the rig script (README.md)}; WAIT_FIRST=${WAIT_FIRST:-150}; WAIT_TWO=${WAIT_TWO:-180}
declare -A TOPIC=([ccm]=101 [ccc]=102 [cxm]=201 [cxc]=202)
failures=0
fail() { echo "  FAIL: $*"; failures=$((failures+1)); }
trap 'rc=$?; "$RIG" stop >/dev/null 2>&1; [ $rc = 0 ] && [ $failures = 0 ] && { echo "delivery-309: PASS"; exit 0; }; echo "delivery-309: FAIL ($failures failed checks, exit $rc)"; exit 1' EXIT
texts() { "$RIG" calls | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log((c.result||[]).filter(x=>/sendMessage/.test(x.method)).map(x=>String(x.params?.text??"")).join("\n"))})'; }
waitall() { local lim=$1; shift; local t0; t0=$(date +%s); local ok t tag
  while :; do
    t=$(texts) || { fail "the rig's calls could not be read"; return 1; }
    ok=0; for tag in "$@"; do echo "$t" | grep -q "PONG-$tag\b" && ok=$((ok+1)); done
    [ "$ok" = $# ] && { echo "  all $# replied in $(( $(date +%s)-t0 ))s"; return 0; }
    [ $(( $(date +%s)-t0 )) -ge "$lim" ] && { fail "$ok of $# replied in ${lim}s; missing: $(for tag in "$@"; do echo "$t" | grep -q "PONG-$tag\b" || printf '%s ' "$tag"; done)"; return 1; }
    sleep 2; done; }
sendall() { local pids=() p; while [ $# -gt 0 ]; do "$RIG" send "$1" "$2" >/dev/null & pids+=($!); shift 2; done
  for p in "${pids[@]}"; do wait "$p" || fail "a send did not go through"; done; }
round() { local r=$1
  echo "-- round $r: the first message to each agent right after the fleet is up (4 at once)"
  sendall "${TOPIC[ccm]}" "PING-r${r}firstccm" "${TOPIC[ccc]}" "PING-r${r}firstccc" "${TOPIC[cxm]}" "PING-r${r}firstcxm" "${TOPIC[cxc]}" "PING-r${r}firstcxc"
  waitall "$WAIT_FIRST" "r${r}firstccm" "r${r}firstccc" "r${r}firstcxm" "r${r}firstcxc"
  echo "-- round $r: two messages at once to ccm and two to cxm"
  sendall "${TOPIC[ccm]}" "PING-r${r}twoccma" "${TOPIC[ccm]}" "PING-r${r}twoccmb" "${TOPIC[cxm]}" "PING-r${r}twocxma" "${TOPIC[cxm]}" "PING-r${r}twocxmb"
  waitall "$WAIT_TWO" "r${r}twoccma" "r${r}twoccmb" "r${r}twocxma" "r${r}twocxmb"; }
"$RIG" start || { fail "the rig did not start"; exit 1; }
v=$("$RIG" r 'tmux -V') || { fail "tmux -V failed in the rig"; exit 1; }
case "$v" in "tmux "*) echo "tmux in the container: $v" ;; *) fail "tmux -V said '$v'"; exit 1 ;; esac
round 1
echo "-- restart: agend fleet stop, start (fresh windows again)"
"$RIG" r 'agend fleet stop >/tmp/stop.out 2>&1; sleep 3; cd ~ && nohup agend fleet start > /tmp/fleet2.out 2>&1 &' || fail "the restart did not run"
"$RIG" wait-fresh || fail "the agents did not come back with fresh windows"
round 2
