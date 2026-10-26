#!/bin/bash
# #581 end-to-end check of the container quick install, on this checkout, with no real vendor account and no chat
# platform: claude talks to mock-anthropic.mjs, the dashboard is driven by e2e-browser.mts (Playwright).
# Everything it creates is named agend-dq-* and removed at the end (KEEP=1 keeps it). Needs: docker + compose v2,
# a built checkout (npm run build), PW_DIR (playwright-core) and CHROME. Run from the repo root.
set -euo pipefail
REPO=$(pwd); DQ=$(mktemp -d); OUT=${OUT:-$DQ/out}; PORT=${PORT:-19381}
log() { printf '\n== %s\n' "$*"; }
cleanup() {
  [ "${KEEP:-}" = 1 ] && return
  (cd "$DQ" && docker compose -p agend-dq -f compose.yaml -f compose.e2e.yaml down -v >/dev/null 2>&1) || true
  docker rm -f agend-dq-mock agend-dq-cli >/dev/null 2>&1 || true
  docker network rm agend-dq-net >/dev/null 2>&1 || true
  docker rmi agend-dq-img:proto >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "image from this checkout (npm pack → docker/Dockerfile)"
rm -f docker/*.tgz && npm pack --pack-destination docker >/dev/null
PKG=$(basename docker/*.tgz)
docker build -q -t agend-dq-img:proto --build-arg AGEND_PACKAGE=/ctx/$PKG docker
rm -f docker/*.tgz

log "mock Anthropic API on a private network"
docker network create agend-dq-net >/dev/null
docker create --name agend-dq-mock --network agend-dq-net node:22-bookworm node /mock.mjs 8080 >/dev/null
docker cp scripts/manual/docker-quick-install/mock-anthropic.mjs agend-dq-mock:/mock.mjs
docker start agend-dq-mock >/dev/null

log "compose up (docker/compose.yaml + an e2e override: local image, the mock, host port $PORT)"
cp docker/compose.yaml "$DQ/"
cat > "$DQ/compose.e2e.yaml" <<YAML
services:
  agend:
    image: agend-dq-img:proto
    pull_policy: never
    container_name: agend-dq-agend
    networks: [dq]
    environment:
      ANTHROPIC_BASE_URL: http://agend-dq-mock:8080
      ANTHROPIC_API_KEY: test-key-not-real
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    ports: !override
      - "127.0.0.1:$PORT:19280"
networks:
  dq: { name: agend-dq-net, external: true }
volumes:
  agend-home: { name: agend-dq-home }
  agend-work: { name: agend-dq-work }
YAML
printf 'AGEND_INSTANCE=dev\nAGEND_BACKEND=claude-code\n' > "$DQ/.env"
compose() { (cd "$DQ" && docker compose -p agend-dq -f compose.yaml -f compose.e2e.yaml "$@"); }
compose up -d
ready() { timeout 240 sh -c "until curl -fsS http://127.0.0.1:$PORT/health >/dev/null 2>&1 && docker exec agend-dq-agend tmux list-windows -t agend 2>/dev/null | grep -q dev; do sleep 3; done"; sleep 5; }
ready
docker logs agend-dq-agend 2>&1 | grep 'agend container'
curl -sS -o /dev/null -w 'dashboard from the host: /health %{http_code}\n' http://127.0.0.1:$PORT/health
docker exec agend-dq-agend sh -c 'id; ps -o pid,user,comm -e | head -4'

roundtrip() {
  local code; code=$(docker exec agend-dq-agend agend web --code 2>&1 | sed -n 's/^Code: *\([A-Z0-9-]*\).*/\1/p')
  URL=http://localhost:$PORT CODE=$code OUT="$OUT/$1" npx tsx scripts/manual/docker-quick-install/e2e-browser.mts
}
log "round trip: sign in with a code, send in the web chat, claude replies through AgEnD's reply tool"
roundtrip 1-first
log "in-container refusals"
docker exec agend-dq-agend agend update 2>&1 | tail -1 || true
docker exec agend-dq-agend agend stop 2>&1 | tail -1 || true
log "agend restart → Docker restarts the container; the CLI is not installed again"
docker exec agend-dq-agend agend restart 2>&1 | tail -1 || true
timeout 120 sh -c 'until [ "$(docker inspect agend-dq-agend --format {{.RestartCount}})" -ge 1 ]; do sleep 2; done'; ready
docker inspect agend-dq-agend --format 'restart count {{.RestartCount}}'
docker logs agend-dq-agend 2>&1 | grep 'agend container' | tail -1
roundtrip 2-after-restart
log "compose down + up: the home volume keeps the CLI and the fleet"
compose down; compose up -d; ready
docker logs agend-dq-agend 2>&1 | grep 'agend container'
roundtrip 3-after-recreate
log "CLI leg: every other backend AgEnD installs, kiro-cli and claude-code pinned, in a throwaway container"
docker run --rm --name agend-dq-cli -e AGEND_CLI_VERSIONS=kiro-cli=2.34.0,claude-code=2.1.296 agend-dq-img:proto sh -c \
  'mkdir -p ~/.agend && chmod 700 ~/.agend && printf "instances:\n  k:\n    backend: kiro-cli\n  g:\n    backend: grok\n  c:\n    backend: claude-code\n  x:\n    backend: codex\n  o:\n    backend: opencode\n  a:\n    backend: antigravity\n  m:\n    backend: muse\n" > ~/.agend/fleet.yaml && agend container prepare | grep "agend container"; kiro-cli --version; grok --version; tmux new-session -d -s k -x 120 -y 30 "kiro-cli chat --tui --agent-engine=v2"; sleep 12; tmux capture-pane -p -t k | grep -m1 "signed in"'
