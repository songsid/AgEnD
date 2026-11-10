#!/bin/bash
# M-2457 §2 matrix, leak leg (the generic repro behind the bundled-tmux decision; `tmux` = the build under test on PATH).
# Minimal reproduction: tmux server RSS grows when `capture-pane -p` is sent
# repeatedly over a control-mode client (-C) while the pane content keeps changing.
# Uses a private socket (-L) and no config (-f /dev/null); does not touch other tmux servers.
#   PANE=static  ./leak-repro.sh   # pane runs `cat` (content never changes)
#   PANE=redraw  ./leak-repro.sh   # pane redraws the full screen every 0.1 s (default)
#   VIA=cli      ./leak-repro.sh   # control: same captures, but as separate `tmux capture-pane -p` CLI processes
# Sends CAPTURES captures (default N*10, i.e. 10/s for N s; default N=180) 0.1 s apart and prints the server VmRSS every
# SAMPLE_EVERY*10 captures (default 30 s' worth) and at the end — driven by the count, never by the clock.
# Exits non-zero unless it measured what it claims: a numeric server pid, a numeric RSS for every sample, and EVERY
# capture answered (control: %end replies; cli: successful capture-pane runs).
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
# Count-driven (M-2849): exactly C captures, 0.1 s apart, an RSS sample every K captures and one at the end. A slow
# machine only takes longer; it never changes what is measured or what passes (no deadline decides the verdict).
C=${CAPTURES:-$((N * 10))}; K=$(( EVERY * 10 > 0 ? EVERY * 10 : 1 ))
case "$C" in ''|*[!0-9]*|0) die "CAPTURES must be a positive number" ;; esac
exec 3>&1
rss_at() { local rss; rss=$(awk '/VmRSS/{print $2}' "/proc/$P/status" 2>/dev/null)
  case "$rss" in ''|*[!0-9]*) echo "$1" > "$WORK/norss"; return 1 ;; esac
  echo "after $1 of $C captures: VmRSS=$rss kB" >&3; }
# The stream of captures: each one asked (cli: run; control: printed for the -C client), counted, and sampled every K.
captures() { local n=0; rss_at 0 || return 1
  while [ "$n" -lt "$C" ]; do
    if [ "$VIA" = cli ]; then T capture-pane -t m -p > /dev/null && echo . >> "$WORK/ok"; else echo "capture-pane -t m -p"; fi
    n=$((n + 1)); sleep 0.1
    if [ $((n % K)) -eq 0 ] || [ "$n" -eq "$C" ]; then rss_at "$n" || return 1; fi
  done; }
if [ "$VIA" = cli ]; then captures
else captures | T -C attach -f ignore-size -t m > "$WORK/control.out"; fi
[ ! -f "$WORK/norss" ] || die "no RSS for server pid $P after $(cat "$WORK/norss") captures (did it exit?)"
if [ "$VIA" = cli ]; then done_n=$( [ -f "$WORK/ok" ] && wc -l < "$WORK/ok" || echo 0 ); else done_n=$(grep -cE '^%end [0-9]+ [0-9]+ 1$' "$WORK/control.out" 2>/dev/null || true); fi
# (control: a reply block's last field is its flags — 1 for a command this client sent, 0 for the attach handshake's
# own block, which is no capture; a failed capture ends in %error, which never counts.)
done_n=$((${done_n:-0} + 0))
[ "$done_n" -ge "$C" ] || die "only $done_n of $C captures were answered"
echo "captures answered: $done_n"
