#!/bin/bash
# rig.sh <cmd>: the cold-resume prompt rig (2.1.319 audit). RIG=<scratch dir>, BIN=<dir holding 2.1.<v> binaries>.
#   up <v>    a loopback-only namespace (unshare -rn) holding the Messages mock, the flag proxy and a private tmux
#             server (socket $RIG/sock); a claude.ai-shaped home with FAKE tokens; one 180k-token turn on 2.1.<v>;
#             the transcript backdated 3 h → $RIG/h1-aged-backup, the launch env → $RIG/envs3. Then run live.mts.
#   down      kill the private tmux server and the namespace's processes (by the pids this script recorded).
# Never the live tmux server, never a real account; IS_SANDBOX=1 only because the namespace maps us to uid 0.
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); AUD=$(dirname "$HERE")
# Keep RIG short: the tmux socket $RIG/sock must fit a Unix socket path (108 bytes).
R=${RIG:?set RIG to a scratch directory}; T() { tmux -S "$R/sock" "$@"; }
case ${1:-} in
up)
  v=${2:?version patch, e.g. 319}; mkdir -p "$R/frames" "$R/w1"; git -C "$R/w1" init -q 2>/dev/null || true
  printf '{}' > "$R/flags.json"
  cat > "$R/netns.sh" <<EOF
ip link set lo up
MOCK_LOG=$R/requests.log python3 $AUD/mockapi.py 18330 > $R/mock.out 2>&1 &
echo \$! > $R/mock.pid
DIR=$R FLAGS=$R/flags.json $(command -v node) $HERE/flags-proxy.mjs > $R/flags.out 2>&1 &
echo \$! > $R/flags.pid
tmux -S $R/sock new-session -d -s hold -x 80 -y 10 "sleep 14400"
echo \$\$ > $R/netns.pid; echo NETNS READY; sleep 14400
EOF
  (setsid unshare -rn bash "$R/netns.sh" > "$R/netns.out" 2>&1 < /dev/null &)
  for _ in $(seq 1 50); do [ -s "$R/proxy.port" ] && T has-session -t hold 2>/dev/null && break; sleep 0.2; done
  H=$R/h1; rm -rf "$H"; mkdir -p "$H/.claude"
  tok() { printf 'sk-ant-%s01-%s' "$1" "$(printf 'rig%.0s' $(seq 30))"; }   # fake, built at run time
  printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"%s","expiresAt":4102444800000,"scopes":["user:inference","user:profile","user:sessions:claude_code"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}\n' "$(tok oat)" "$(tok ort)" > "$H/.claude/.credentials.json"
  chmod 600 "$H/.claude/.credentials.json"
  printf '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.%s","theme":"dark","numStartups":5,"oauthAccount":{"accountUuid":"00000000-0000-4000-8000-000000000001","emailAddress":"rig@example.test","organizationUuid":"00000000-0000-4000-8000-000000000002","organizationName":"rig","organizationRole":"admin","billingType":"stripe_subscription","organizationRateLimitTier":"default_claude_max_20x","userRateLimitTier":"default_claude_max_20x"},"projects":{"%s":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true,"allowedTools":[]}}}\n' "$v" "$R/w1" > "$H/.claude/.claude.json"
  printf '{"theme":"dark","skipDangerousModePermissionPrompt":true}\n' > "$H/.claude/settings.json"
  # No DISABLE_TELEMETRY / NONESSENTIAL_TRAFFIC: they stop the flag fetch. The namespace has no route out anyway.
  echo "HOME=$H CLAUDE_CONFIG_DIR=$H/.claude XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share XDG_CACHE_HOME=$H/.cache XDG_STATE_HOME=$H/.local/state DISABLE_AUTOUPDATER=1 IS_SANDBOX=1 ANTHROPIC_BASE_URL=http://127.0.0.1:18330 TERM=xterm-256color HTTPS_PROXY=http://127.0.0.1:$(cat "$R/proxy.port") NO_PROXY=127.0.0.1,localhost NODE_EXTRA_CA_CERTS=$R/ca.pem" > "$R/envs3"
  T new-session -d -s first -x 160 -y 50 -c "$R/w1" "env -i PATH=/usr/bin:/bin $(cat "$R/envs3") $BIN/2.1.$v --dangerously-skip-permissions; sleep 3600"
  sleep 10; T send-keys -t first -l "BIG hello"; sleep 0.5; T send-keys -t first Enter; sleep 8   # mockapi: BIG = 180k input tokens
  T send-keys -t first C-c; sleep 0.5; T send-keys -t first C-c; sleep 2; T kill-session -t first
  python3 -I "$AUD/age-session.py" 3 "$H"/.claude/projects/*/*.jsonl
  rm -rf "$R/h1-aged-backup"; cp -a "$H" "$R/h1-aged-backup"; echo "rig up: $(ls "$H"/.claude/projects/*/*.jsonl | wc -l) session(s), backdated 3 h";;
down)
  T kill-server 2>/dev/null || true
  [ -s "$R/netns.pid" ] && pkill -P "$(cat "$R/netns.pid")" 2>/dev/null || true   # its sleep
  for f in mock flags netns; do [ -s "$R/$f.pid" ] && kill "$(cat "$R/$f.pid")" 2>/dev/null || true; done; echo down;;
*) echo "usage: RIG=… BIN=… rig.sh up <v> | down" >&2; exit 2;;
esac
