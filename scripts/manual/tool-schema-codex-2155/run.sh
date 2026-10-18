# What codex actually declares to the model for AgEnD's tools (#2155). One `codex exec` turn, offline: a private network
# namespace (unshare -rn, loopback only), a scratch CODEX_HOME under $HOME, AgEnD's exact tool list from a stub MCP
# server, and the codex-version-audit mock as the Responses API, which keeps each request body. No account, no
# network, never ~/.codex or a live instance.
#   scripts/manual/tool-schema-codex-2155/run.sh <label>          → $OUT/body-<label>.log (OUT defaults to /tmp/tsc2155)
#   python3 scripts/manual/tool-schema-codex-2155/compare.py $OUT/body-<label>.log   → every type codex changed or lost
# CODEX_BIN: the codex to run (default: `codex` on PATH).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
LABEL=${1:?label}; OUT=${OUT:-/tmp/tsc2155}; PORT=${PORT:-18790}; CODEX_BIN=${CODEX_BIN:-$(command -v codex)}
CH=$HOME/.tsc2155-$LABEL; rm -rf "$CH"; mkdir -p "$CH" "$OUT/w"
NODE=$(readlink -f "$(command -v node)")
cat > "$CH/config.toml" <<TOML
model = "gpt-5.1-codex"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$PORT/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
[mcp_servers.agend]
command = "$NODE"
args = ["--import", "$REPO/node_modules/tsx/dist/loader.mjs", "$HERE/stub-mcp.mts"]
env = { REPO_TOOLS = "$REPO/src/channel/mcp-tools.ts" }
TOML
rm -f "$OUT/body-$LABEL.log"
npx tsx -e 'import { TOOLS } from "./src/channel/mcp-tools.ts"; import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify(TOOLS));' "$OUT/tools-$LABEL.json"
env -u TMUX unshare -rn sh -c "
  ip link set lo up
  curl -s -m 2 https://example.com >/dev/null && { echo 'network reachable: refusing'; exit 1; } || true
  PORT=$PORT BODY_LOG=$OUT/body-$LABEL.log node $REPO/scripts/manual/codex-version-audit/mock.mjs & M=\$!
  sleep 1
  cd $OUT/w && CODEX_HOME=$CH MOCK_KEY=test timeout 60 $CODEX_BIN exec --skip-git-repo-check 'say hi' < /dev/null > $OUT/exec-$LABEL.log 2>&1; echo codex-rc=\$?
  kill \$M
"
rm -rf "$CH"
echo "$OUT/body-$LABEL.log (tools: $OUT/tools-$LABEL.json)"
