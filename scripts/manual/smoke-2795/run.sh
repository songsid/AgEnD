#!/usr/bin/env bash
# #2795 smoke. Usage: run.sh <repo> <label>. Everything lives under ~/.cache/agend-smoke-2795/<label> (codex refuses
# helper binaries under /tmp); nothing touches ~/.codex, ~/.agend or the live tmux server.
set -euo pipefail
REPO="$(cd "${1:?repo}" && pwd)"; LABEL="${2:?label}"; HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HOME/.cache/agend-smoke-2795/$LABEL"; rm -rf "$R"; mkdir -p "$R/home" "$R/agend" "$R/codex"
PORT="${PORT:-18789}"
cat > "$R/codex/config.toml" <<TOML
model = "mock-model"
model_provider = "mock"
check_for_update_on_startup = false
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$PORT/v1"
wire_api = "responses"
requires_openai_auth = false
TOML
echo ok > "$R/mode"
MOCK_TEXT=$'Here is the line from the log:\nError: 401 Unauthorized (quoted from an old run)' PORT=$PORT MOCK_MODE_FILE="$R/mode" MOCK_LOG="$R/mock.log" node "$HERE/../codex-version-audit/mock.mjs" & MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do grep -q "^listening $PORT$" "$R/mock.log" 2>/dev/null && break; sleep 0.25; done
env -i HOME="$R/home" AGEND_HOME="$R/agend" CODEX_HOME="$R/codex" PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v codex)"):/usr/bin:/bin" \
  TERM=xterm-256color LANG=C.UTF-8 "$REPO/node_modules/.bin/tsx" "$HERE/smoke.mts" "$REPO" "$R" "$LABEL" 2>"$R/stderr.log" | tee "$R/result.json"
