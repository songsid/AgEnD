#!/usr/bin/env bash
# M-3653: when does codex start an AgEnD-shaped stdio MCP server? Codex 0.172.0 added lazy stdio startup
# (mcp_lazy_stdio_startup, on by default), and AgEnD's daemon learns of an agent from its MCP server's mcp_ready.
# Launches through the production config with stub-mcp.mjs registered, then: a turn, an in-place /model switch,
# another turn, quit, a production resume launch, a turn. The stub logs start/initialize/tools-list/exit to MARK,
# with a line per step, so a start that waits past a launch shows up.
# Usage, inside netns.sh with the audited codex first on PATH:
#   AUDIT=… PORT=… MARK=<log file> netns.sh mcp-start.sh <VERSION>
set -uo pipefail
V="${1:?version}"; HERE="$(cd "$(dirname "$0")" && pwd)"; R="$HERE/rig.sh"
: "${MARK:?set MARK}"; : > "$MARK"
export GEN_MCP="$HERE/stub-mcp.mjs" GEN_MCP_MARK="$MARK"
r() { bash "$R" "$V" "$@"; }
step() { echo "--- $1 @ $(date +%s%3N)" >> "$MARK"; }
trap 'r stop' EXIT
r mock
step launch-fresh;  r launch main fresh trust; sleep 10
step turn;          r mode ok; r send "hello"; sleep 6
step model-switch;  r send "/model mock-model --reasoning=high"; sleep 6
step turn2;         r send "again"; sleep 6
step quit;          r key C-c; sleep 0.5; r key C-c; sleep 3
step launch-resume; r launch main resume trust; sleep 10
step turn3;         r send "after resume"; sleep 6
cat "$MARK"
