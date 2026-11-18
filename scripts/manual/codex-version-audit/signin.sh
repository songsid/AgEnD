#!/usr/bin/env bash
# Empty-profile onboarding only: never choose an account sign-in action or enter credentials.
# Run in a loopback-only namespace with AUDIT's scratch binary and a fresh short home parent.
set -euo pipefail
V="${1:?version}"; HERE="$(cd "$(dirname "$0")" && pwd)"; R="$HERE/rig.sh"
: "${AUDIT:?set AUDIT}"; export WIN=signin
r() { bash "$R" "$V" "$@"; }
for item in $(r paths); do
  case "$item" in SOCK=*) SOCK="${item#SOCK=}";; SH=*) SH="${item#SH=}";; RUN=*) RUN="${item#RUN=}";; esac
done
T() { tmux -f /dev/null -L "$SOCK" "$@"; }
trap 'r stop' EXIT
if [ -e "$SH" ]; then echo 'Use a fresh audit root for the empty sign-in profile' >&2; exit 1; fi
mkdir -m 700 "$SH"
T new-session -d -s "$WIN" -x 120 -y 36 -c "$RUN" \
  "CODEX_HOME=$SH BROWSER=/usr/bin/false $AUDIT/codex-$V/node_modules/.bin/codex --no-alt-screen -c check_for_update_on_startup=false; sleep 600"
r cap 40-signin-menu 4
T capture-pane -p -t "$WIN" > "$RUN/signin-menu.txt"
grep -Eq '^[>›] 1\. Sign in with ChatGPT' "$RUN/signin-menu.txt"
T send-keys -t "$WIN" Down Down
r cap 40b-signin-other-selected 1
T capture-pane -p -t "$WIN" > "$RUN/signin-selected.txt"
# Positive target check before Enter: this action opens a method menu, not a browser or login flow.
grep -Eq '^[>›] 3\. Sign in another way' "$RUN/signin-selected.txt"
T send-keys -t "$WIN" Enter
r cap 41-signin-another-way 3
T capture-pane -p -t "$WIN" > "$RUN/signin-another-way.txt"
grep -q 'Use an OpenAI API key' "$RUN/signin-another-way.txt"
