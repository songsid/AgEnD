#!/bin/bash
# Run the web smokes against the shared realistic fixture (scripts/manual/smoke-fixture/), each in its own
# memory-capped systemd scope (2026-10-17: one unbounded job OOM-killed the whole fleet), at most JOBS at a time.
#   scripts/manual/smoke/run.sh [smoke ...]     (default: every smoke-*.mts here; smoke-chat-switch always alone)
# Env: PW_DIR (dir with node_modules/playwright-core), REPO (checkout, default: this repo), OUT (default /tmp/smoke-out),
#      MATRIX (full | quick | case list), JOBS (default 2), MEM (per smoke, default 3G), CHROME (optional).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${REPO:-$(cd "$HERE/../../.." && pwd)}
OUT=${OUT:-/tmp/smoke-out}; JOBS=${JOBS:-2}; MEM=${MEM:-3G}
: "${PW_DIR:?set PW_DIR to a directory whose node_modules has playwright-core}"
case $JOBS in ''|*[!0-9]*|0) echo "JOBS must be a positive integer (got '$JOBS')"; exit 2 ;; esac
export REPO OUT PW_DIR MATRIX="${MATRIX:-full}" FONTCONFIG_FILE=${FONTCONFIG_FILE:-/etc/fonts/fonts.conf}
avail=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)
if [ "$avail" -lt 6 ]; then echo "only ${avail} GB available: not starting (need 6)"; exit 2; fi
mkdir -p "$OUT/logs"
list=("$@"); [ ${#list[@]} -eq 0 ] && list=($(cd "$HERE" && ls smoke-*.mts))
port=48200; alone=(); failed=0
declare -A names=()
run_one() { # $1 smoke file, $2 port; returns the smoke's own status (timeout 124, OOM 137, systemd-run failure included)
  local name=${1%.mts} rc
  HP=$2 timeout 1800 systemd-run --user --scope -q -p MemoryMax=$MEM -- npx --prefix "$REPO" tsx "$HERE/$1" > "$OUT/logs/$name.log" 2>&1
  rc=$?
  echo "$name: exit $rc"
  return $rc
}
reap() { # wait for one finished job and count it
  local pid rc
  wait -n -p pid; rc=$?
  [ "$rc" -ne 0 ] && { failed=$((failed + 1)); echo "FAILED: ${names[$pid]:-?} ($rc)"; }
  unset "names[$pid]"
}
for s in "${list[@]}"; do
  case $s in smoke-chat-switch*) alone+=("$s"); continue ;; esac
  while [ ${#names[@]} -ge "$JOBS" ]; do reap; done
  run_one "$s" $port & names[$!]=$s; port=$((port + 10))
done
while [ ${#names[@]} -gt 0 ]; do reap; done
for s in "${alone[@]}"; do
  run_one "$s" $port || { failed=$((failed + 1)); echo "FAILED: $s"; }
  port=$((port + 10))
done
echo "logs and shots under $OUT"
if [ "$failed" -gt 0 ]; then echo "$failed smoke(s) failed"; exit 1; fi
