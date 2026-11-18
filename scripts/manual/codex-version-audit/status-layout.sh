#!/usr/bin/env bash
# Real-binary status geometry, using the rig's account-free mock and private socket.
# Run inside the audit's loopback-only namespace. AUDIT must contain this version's scratch install.
# Production keeps --no-alt-screen. The explicit lab-owned captures remove it to exercise workspace focus.
set -euo pipefail
V="${1:?version}"; HERE="$(cd "$(dirname "$0")" && pwd)"; R="$HERE/rig.sh"
: "${AUDIT:?set AUDIT}"; export WIN=layout
r() { bash "$R" "$V" "$@"; }
for item in $(r paths); do
  case "$item" in SOCK=*) SOCK="${item#SOCK=}";; AH=*) AH="${item#AH=}";; RUN=*) RUN="${item#RUN=}";; esac
done
T() { tmux -f /dev/null -L "$SOCK" "$@"; }
frame() {
  r cap "$1" 3
  mkdir -p "$RUN/ansi"
  T capture-pane -e -p -t "$WIN" > "$RUN/ansi/$1.txt"
}
trap 'r stop' EXIT
r mock; r mode ok
for order in context-first model-first; do
  if [ "$order" = context-first ]; then
    items='["context-remaining", "model-with-reasoning", "current-dir", "git-branch"]'
  else
    items='["model-with-reasoning", "current-dir", "git-branch", "context-remaining"]'
  fi
  config="[tui]
status_line = $items
animations = false"
  GEN_EXTRA_TOML="$config" r launch layout fresh trust '' 150x45 "layout-$order"
  frame "$order-production-150"
  T resize-window -t "$WIN" -x 80 -y 28
  frame "$order-production-80"
  T resize-window -t "$WIN" -x 50 -y 28
  frame "$order-production-50"

  config="$config
fullscreen_transcript = true
alternate_screen = \"always\"
[features]
tui_workspace = true
[tui.keymap.global]
focus_sidebar_content = \"f6\"
focus_main_composer = \"f7\""
  # First preserve the production flag, proving it overrides the requested workspace mode.
  GEN_EXTRA_TOML="$config" r launch layout fresh trust '' 150x45 "owned-$order"
  frame "$order-workspace-production-flag"
  original="$(cat "$RUN/cmd-layout.txt")"
  case "$original" in *' --no-alt-screen'*) ;; *) echo 'Expected production no-alt-screen flag' >&2; exit 1;; esac
  command="${original/ --no-alt-screen/}"
  printf '%s\n' "$command" > "$RUN/cmd-layout-owned-$order.txt"
  T kill-session -t "$WIN"
  BIN="$AUDIT/codex-$V/node_modules/.bin"
  T new-session -d -s "$WIN" -x 150 -y 45 -c "$RUN/owned-$order" "PATH=$BIN:\$PATH AGEND_HOME=$AH $command; sleep 600"
  frame "$order-owned-main-150"
  r key F6; frame "$order-owned-unfocused-150"
  r key F7; frame "$order-owned-refocused-150"
  T resize-window -t "$WIN" -x 110 -y 28
  frame "$order-owned-main-110"
  r key F6; frame "$order-owned-unfocused-110"
  r key F7
  T resize-window -t "$WIN" -x 95 -y 28
  frame "$order-owned-main-95"
  r key F6; frame "$order-owned-sidebar-only-95"
  r key F7; frame "$order-owned-refocused-95"
done
