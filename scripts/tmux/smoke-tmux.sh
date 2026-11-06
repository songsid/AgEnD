#!/bin/sh
# Smoke-run one built bundled tmux on its own runner (M-2457 §3): the version, a private-socket server that starts,
# answers, captures a CJK + emoji line at the widths the CLIs assume, and is killed. Never the default socket.
#   scripts/tmux/smoke-tmux.sh <dir holding bin/tmux and share/terminfo> <expected version, e.g. 3.8>
set -eu
DIR=${1:?bundle dir}; WANT=${2:?expected tmux version}
T="$DIR/bin/tmux"
# A UTF-8 locale the host has: macOS names it en_US.UTF-8, Linux (glibc and musl) C.UTF-8.
case "$(uname -s)" in Darwin) LOC=en_US.UTF-8 ;; *) LOC=C.UTF-8 ;; esac
export TERMINFO_DIRS="$DIR/share/terminfo" LANG=$LOC LC_ALL=$LOC
SOCK="agend-smoke-$$"
fail() { echo "smoke: $*" >&2; "$T" -L "$SOCK" kill-server >/dev/null 2>&1 || true; exit 1; }
trap '"$T" -L "$SOCK" kill-server >/dev/null 2>&1 || true' EXIT

got=$("$T" -V) || fail "tmux -V failed"
[ "$got" = "tmux $WANT" ] || fail "tmux -V says '$got', not 'tmux $WANT'"

"$T" -L "$SOCK" -f /dev/null new-session -d -s s -x 40 -y 5 \; set -g default-terminal tmux-256color \
  || fail "the server did not start on a private socket"
"$T" -L "$SOCK" has-session -t s || fail "has-session"

# 中文 = 2 + 2 cells, then 🫨 (Unicode 15) = 2 — utf8proc's tables; musl's wcwidth says 1 — then "ok": column 8.
"$T" -L "$SOCK" respawn-pane -k -t s "printf '中文🫨ok'; sleep 30"
i=0; line=""
while [ $i -lt 50 ]; do
  line=$("$T" -L "$SOCK" capture-pane -p -t s | head -n 1)
  case "$line" in *ok*) break ;; esac
  i=$((i + 1)); sleep 0.1
done
case "$line" in 中文🫨ok*) ;; *) fail "capture-pane read '$line'" ;; esac
x=$("$T" -L "$SOCK" display-message -p -t s '#{cursor_x}')
[ "$x" = "8" ] || fail "the line is $x cells wide, not 8 (CJK/emoji width)"

"$T" -L "$SOCK" kill-server || fail "kill-server"
i=0
while "$T" -L "$SOCK" has-session >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -lt 50 ] || fail "the server is still up after kill-server"; sleep 0.1
done
trap - EXIT
echo "smoke ok: tmux $WANT, private socket, CJK/emoji width 8, killed"
