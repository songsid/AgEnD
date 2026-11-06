#!/bin/bash
# M-2457 §2 matrix, leak leg (the generic repro behind the bundled-tmux decision; `tmux` = the build under test on PATH).
# Minimal reproduction: tmux server RSS grows when `capture-pane -p` is sent
# repeatedly over a control-mode client (-C) while the pane content keeps changing.
# Uses a private socket (-L) and no config (-f /dev/null); does not touch other tmux servers.
#   PANE=static  ./repro.sh   # pane runs `cat` (content never changes)
#   PANE=redraw  ./repro.sh   # pane redraws the full screen every 0.1 s (default)
#   VIA=cli      ./repro.sh   # control: same captures, but as separate `tmux capture-pane -p` CLI processes
# Sends 10 captures/s for N seconds (default 180) and prints the server VmRSS every 30 s.
S=${SOCKET:-capture-leak-repro}; N=${N:-180}; PANE=${PANE:-redraw}; VIA=${VIA:-control}
T() { tmux -L "$S" -f /dev/null "$@"; }
trap 'T kill-server 2>/dev/null' EXIT
REDRAW='import sys,time
n=0
sys.stdout.write("\x1b[?1049h")
while True:
    n+=1
    rows=["\x1b[%dmframe %09d row %03d %s\x1b[0m\x1b[K" % (31+(n+r)%7, n, r, ("#-" if (n+r)%2 else "-#")*80) for r in range(49)]
    sys.stdout.write("\x1b[H"+"\r\n".join(rows)); sys.stdout.flush(); time.sleep(0.1)'
if [ "$PANE" = static ]; then CMD=cat; else CMD="python3 -c '$REDRAW'"; fi
T new-session -d -s m -x 200 -y 50 "$CMD"
P=$(T display -p '#{pid}'); echo "$(tmux -V), server pid $P, pane=$PANE, via=$VIA"
if [ "$VIA" = cli ]; then
  ( end=$((SECONDS+N)); while [ $SECONDS -lt $end ]; do T capture-pane -t m -p > /dev/null; sleep 0.1; done ) &
else
  ( end=$((SECONDS+N)); while [ $SECONDS -lt $end ]; do echo "capture-pane -t m -p"; sleep 0.1; done ) \
    | T -C attach -f ignore-size -t m > /dev/null &
fi
for i in $(seq 0 30 "$N"); do echo "t=${i}s VmRSS=$(awk '/VmRSS/{print $2}' /proc/$P/status) kB"; sleep 30; done
