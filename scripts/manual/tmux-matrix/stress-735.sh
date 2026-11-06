#!/bin/bash
# M-2457 §2 matrix, #735 leg: W windows emitting random bytes and escape sequences at once for N seconds while every
# pane is captured; the server must still be alive at the end. `tmux` = the build under test on PATH. Private socket.
# Not reproducing #735 does not prove a build fixed it (the note says so); a crash here is a finding.
N=${N:-600}; W=${W:-24}; S=stress-735-$$
GEN='import os,random,sys,time
seqs=[b"\x1b[%dm",b"\x1b[%d;%dH",b"\x1b]0;t%d\x07",b"\x1b]2;%d\x1b\\",b"\x1bP%dq\x1b\\",b"\x1b_%d\x1b\\",b"\x1b[?%dh",b"\x1b[?%dl",b"\x1b[%dX",b"\x1b[%d@",b"\xe4\xb8\xad\xe6\x96\x87",b"\xf0\x9f\x98\x80",b"\x1b[%d;%d;%dr"]
o=sys.stdout.buffer
while True:
    buf=bytearray()
    for _ in range(random.randint(50,400)):
        r=random.random()
        if r<0.5: buf+=os.urandom(random.randint(1,64))
        else:
            s=random.choice(seqs); k=s.count(b"%d"); buf+=s % tuple(random.randint(0,9999) for _ in range(k))
    o.write(bytes(buf)); o.flush(); time.sleep(random.random()*0.02)'
trap 'tmux -L "$S" kill-server 2>/dev/null' EXIT
tmux -L "$S" -f /dev/null new-session -d -s f -x 200 -y 50 "python3 -c '$GEN'"
for i in $(seq 2 "$W"); do tmux -L "$S" new-window -t f "python3 -c '$GEN'"; done
P=$(tmux -L "$S" display -p '#{pid}'); echo "[stress] $(tmux -V) server $P, $W windows, ${N}s"
end=$((SECONDS+N)); alive=1
while [ $SECONDS -lt $end ]; do
  for w in $(seq 0 $((W-1))); do tmux -L "$S" capture-pane -p -t "f:$w" >/dev/null 2>&1; done; sleep 5
  kill -0 "$P" 2>/dev/null || { alive=0; echo "[stress] SERVER DIED at t=$((N-(end-SECONDS)))s"; break; }
done
[ $alive = 1 ] && echo "[stress] server alive after ${N}s, RSS $(awk '/VmRSS/{print $2}' /proc/$P/status) kB"
[ $alive = 1 ]
