#!/bin/bash
# M-2457 §2 matrix, leak leg (the generic repro behind the bundled-tmux decision; `tmux` = the build under test on PATH).
# Minimal reproduction: tmux server RSS grows when `capture-pane -p` is sent
# repeatedly over a control-mode client (-C) while the pane content keeps changing.
# Uses a private socket (-L) and no config (-f /dev/null); does not touch other tmux servers.
#   PANE=static  ./leak-repro.sh   # pane runs `cat` (content never changes)
#   PANE=redraw  ./leak-repro.sh   # pane redraws the full screen every 0.1 s (default)
#   VIA=cli      ./leak-repro.sh   # control: same captures, but as separate `tmux capture-pane -p` CLI processes
# Sends 10 captures/s for N seconds (default 180) and prints the server VmRSS every SAMPLE_EVERY s (default 30).
# Exits non-zero unless it measured what it claims: a numeric server pid, a numeric RSS for every sample, and at least
# half of the captures answered (control: %end replies; cli: successful capture-pane runs).
set -uo pipefail
S=${SOCKET:-capture-leak-repro}; N=${N:-180}; PANE=${PANE:-redraw}; VIA=${VIA:-control}; EVERY=${SAMPLE_EVERY:-30}
T() { tmux -L "$S" -f /dev/null "$@"; }
WORK=$(mktemp -d)
trap 'rc=$?; [ -n "${LOOP:-}" ] && kill "$LOOP" 2>/dev/null; T kill-server 2>/dev/null; rm -rf "$WORK"; exit $rc' EXIT
die() { echo "leak-repro: $*" >&2; exit 1; }
REDRAW='import sys,time
n=0
sys.stdout.write("\x1b[?1049h")
while True:
    n+=1
    rows=["\x1b[%dmframe %09d row %03d %s\x1b[0m\x1b[K" % (31+(n+r)%7, n, r, ("#-" if (n+r)%2 else "-#")*80) for r in range(49)]
    sys.stdout.write("\x1b[H"+"\r\n".join(rows)); sys.stdout.flush(); time.sleep(0.1)'
if [ "$PANE" = static ]; then CMD=cat; else CMD="python3 -c '$REDRAW'"; fi
T new-session -d -s m -x 200 -y 50 "$CMD" || die "new-session failed"
P=$(T display -p '#{pid}') || die "display failed"
case "$P" in ''|*[!0-9]*) die "the server did not say its pid ('$P')" ;; esac
echo "$(tmux -V), server pid $P, pane=$PANE, via=$VIA"
if [ "$VIA" = cli ]; then
  ( end=$((SECONDS+N)); while [ $SECONDS -lt $end ]; do T capture-pane -t m -p > /dev/null && echo . >> "$WORK/ok"; sleep 0.1; done ) &
else
  ( end=$((SECONDS+N)); while [ $SECONDS -lt $end ]; do echo "capture-pane -t m -p"; sleep 0.1; done ) \
    | T -C attach -f ignore-size -t m > "$WORK/control.out" &
fi
LOOP=$!
i=0
while :; do
  rss=$(awk '/VmRSS/{print $2}' "/proc/$P/status" 2>/dev/null)
  case "$rss" in ''|*[!0-9]*) die "no RSS for server pid $P at t=${i}s (did it exit?)" ;; esac
  echo "t=${i}s VmRSS=$rss kB"
  [ "$i" -ge "$N" ] && break
  step=$EVERY; [ $((i + step)) -gt "$N" ] && step=$((N - i))
  sleep "$step"; i=$((i + step))
done
wait "$LOOP" 2>/dev/null; LOOP=""
if [ "$VIA" = cli ]; then done_n=$( [ -f "$WORK/ok" ] && wc -l < "$WORK/ok" || echo 0 ); else done_n=$(grep -c '^%end' "$WORK/control.out" 2>/dev/null || true); fi
done_n=$((${done_n:-0} + 0)); want=$(( N * 5 > 0 ? N * 5 : 1 ))
[ "$done_n" -ge "$want" ] || die "only $done_n captures were answered (want at least $want for ${N}s at 10/s)"
echo "captures answered: $done_n"
