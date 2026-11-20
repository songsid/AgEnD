#!/usr/bin/env bash
# Run a rig command in a loopback-only network namespace as the caller's own uid.
# A new network namespace starts with lo DOWN: codex then never reaches the mock, and every turn shows
# "Reconnecting... waiting for network" while the pane still looks plausible. Raise lo as mapped root, then map back
# to the caller's uid, so tmux sockets and homes keep their usual owner. The command refuses to run if a non-loopback
# route exists. Usage: netns.sh <script> [args...]
set -euo pipefail
U="$(id -u)"; G="$(id -g)"
exec unshare -rn bash -c 'ip link set lo up && exec unshare -U --map-user="$0" --map-group="$1" bash -c '"'"'awk "NR>1 && \$1!=\"lo\"{bad=1} END{exit bad}" /proc/net/route || { echo "network present" >&2; exit 2; }; exec bash "$@"'"'"' _ "${@:2}"' "$U" "$G" "$@"
