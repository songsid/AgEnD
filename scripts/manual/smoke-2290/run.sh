#!/usr/bin/env bash
# Real-CLI delivery smoke (M-2290). Usage: run.sh <repo> <codex|claude-code>.
# Everything lives under ~/.cache/agend-smoke-2290/<backend> (codex refuses helper binaries under /tmp); a private tmux
# socket; mock APIs on loopback; fake credentials made at run time. Nothing touches ~/.codex, ~/.claude, ~/.agend or the
# live tmux server, and no account is used.
set -euo pipefail
REPO="$(cd "${1:?repo}" && pwd)"; BACKEND="${2:?backend}"; HERE="$(cd "$(dirname "$0")" && pwd)"
R="$HOME/.cache/agend-smoke-2290/$BACKEND"; rm -rf "$R"; mkdir -p "$R/home" "$R/agend" "$R/codex"
CXPORT="${CXPORT:-18793}"; CLPORT="${CLPORT:-18794}"
echo ok > "$R/mode"
if [ "$BACKEND" = codex ]; then
  cat > "$R/codex/config.toml" <<TOML
model = "mock-model"
model_provider = "mock"
check_for_update_on_startup = false
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$CXPORT/v1"
wire_api = "responses"
requires_openai_auth = false
TOML
  SLOW_MS=25000 PORT=$CXPORT MOCK_MODE_FILE="$R/mode" MOCK_LOG="$R/mock.log" node "$HERE/../codex-version-audit/mock.mjs" & MOCK=$!
  for _ in $(seq 1 40); do grep -q "^listening $CXPORT$" "$R/mock.log" 2>/dev/null && break; sleep 0.25; done
  CLI_DIR="$(dirname "$(command -v codex)")"
else
  # Fake, never-valid credentials, made here so no key-shaped literal is committed; the mock API accepts anything.
  EXP=$(( ($(date +%s) + 86400) * 1000 )); FILL=$(printf 'c%.0s' $(seq 1 40))
  mkdir -p "$R/home/.claude"
  printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-%s","refreshToken":"sk-ant-ort01-%s","expiresAt":%s,"scopes":["user:inference","user:profile","user:sessions:claude_code"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}' "$FILL" "$FILL" "$EXP" > "$R/home/.claude/.credentials.json"
  CLV="$(claude --version | awk '{print $1}')"
  printf '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"%s","theme":"dark","projects":{"%s/work":{"hasTrustDialogAccepted":true}},"oauthAccount":{"accountUuid":"00000000-0000-4000-8000-000000000001","emailAddress":"smoke@example.invalid","organizationUuid":"00000000-0000-4000-8000-000000000002","organizationRole":"admin","billingType":"stripe_subscription"}}' "$CLV" "$R" > "$R/home/.claude.json"
  MOCK_LOG="$R/mock.log" python3 -I "$HERE/claude-mockapi.py" "$CLPORT" & MOCK=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$CLPORT/" && break; sleep 0.25; done
  CLI_DIR="$(dirname "$(readlink -f "$(command -v claude)")")"
fi
trap 'kill $MOCK 2>/dev/null || true' EXIT
env -i HOME="$R/home" AGEND_HOME="$R/agend" CODEX_HOME="$R/codex" PATH="$(dirname "$(command -v node)"):$CLI_DIR:$(dirname "$(command -v claude)"):/usr/bin:/bin" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$CLPORT" DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  TERM=xterm-256color LANG=C.UTF-8 "$REPO/node_modules/.bin/tsx" "$HERE/smoke.mts" "$REPO" "$R" "$BACKEND" 2>"$R/stderr.log" | tee "$R/result.json"
