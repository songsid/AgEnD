#!/usr/bin/env bash
# One private network namespace, two real CLI processes/MCP restarts, shared durable reminder state; no account.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CODEX_BIN=${CODEX_BIN:?set audited Codex binary}
OUT=${OUT:?set owned output directory}
mkdir -p "$OUT"
RIG_ROOT=$(mktemp -d /tmp/agend-quota-cli-3299-XXXXXX)
export RIG_ROOT REPO CODEX_BIN OUT
export RIG_RESET=$(node -e 'console.log(Date.now()+86400000)')
trap 'rm -rf "$RIG_ROOT"' EXIT
mkdir -p "$RIG_ROOT/codex" "$RIG_ROOT/home" "$RIG_ROOT/work"
NODE=$(command -v node)
cat > "$RIG_ROOT/codex/config.toml" <<EOF
model = "gpt-5.1-codex"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:18791/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
[mcp_servers.quota]
command = "$NODE"
args = ["--import", "$REPO/node_modules/tsx/dist/loader.mjs", "$REPO/scripts/manual/quota-notices-3299/mcp.mts"]
env = { AGEND_HOME = "$RIG_ROOT/home", RIG_ROOT = "$RIG_ROOT", RIG_RESET = "$RIG_RESET" }
EOF
unshare -Urn bash -eu -c '
  ip link set lo up
  node "$REPO/scripts/manual/quota-notices-3299/mock.mjs" & mock=$!
  trap "kill $mock; wait $mock || true" EXIT
  for n in $(seq 1 30); do curl --max-time 1 -s http://127.0.0.1:18791/ >/dev/null && break || sleep 0.1; done
  cd "$RIG_ROOT/work"
  for leg in first restarted; do
    HOME="$RIG_ROOT/home" CODEX_HOME="$RIG_ROOT/codex" MOCK_KEY=fixture AGEND_HOME="$RIG_ROOT/home" timeout 60 "$CODEX_BIN" exec --skip-git-repo-check "Read get_usage and summarize the remaining weekly quota." </dev/null > "$OUT/$leg.log" 2>&1
  done
'
cp "$RIG_ROOT/dispatch.jsonl" "$RIG_ROOT/calls.jsonl" "$RIG_ROOT/api.jsonl" "$RIG_ROOT/tools.jsonl" "$RIG_ROOT/quota-notices.json" "$OUT/"
test ! -s "$RIG_ROOT/errors.log"
test "$(wc -l < "$OUT/dispatch.jsonl")" -eq 1
test "$(wc -l < "$OUT/calls.jsonl")" -eq 2
test "$(wc -l < "$OUT/api.jsonl")" -eq 5 # readiness GET + 2 Responses exchanges per process
"$CODEX_BIN" --version
cat "$OUT/dispatch.jsonl" "$OUT/calls.jsonl"
