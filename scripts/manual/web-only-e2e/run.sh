#!/bin/bash
# #2910 web-only e2e: a channel-less fleet, end to end, with REAL Claude Code and Codex CLIs against mock model APIs, in a
# private container (no network at run time, 3 GB). See README.md.
#
#   run.sh build <sha> <label>     build that commit (node:22-bookworm, network for npm ci only) → $OUT/app-<label>.tar
#   run.sh start <label>           a container from $IMAGE with the app, both CLIs, both mocks and the fleet started
#   run.sh drive <label>           the journey (drive.mjs) → $OUT/drive-<label>.log
#   run.sh collect <label>         daemon WARN/ERROR lines, fleet.yaml, the mocks' logs → $OUT/*-<label>.*
#   run.sh stop <label>
#
# Env: OUT (results dir, default ~/.cache/agend-web-only-e2e), IMAGE (node 22 + tmux; a user `rh` is made if missing),
#      CLAUDE_BIN (a Claude Code executable), CODEX_BIN (the codex binary, e.g. node_modules/@openai/codex-linux-x64/vendor/
#      x86_64-unknown-linux-musl/bin/codex), REPO (this checkout, for `git archive`; default: the script's repo).
set -u
OUT=${OUT:-~/.cache/agend-web-only-e2e}; mkdir -p "$OUT"
REPO=${REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}
P=$1; shift
C() { echo "agend-web-only-e2e-$1"; }
X() { docker exec "$(C "$L")" bash -c "$1"; }
R() { docker exec "$(C "$L")" su - rh -c "$1"; }

if [ "$P" = build ]; then
  SHA=$1; L=$2; B="$OUT/b-$L"; rm -rf "$B" && mkdir -p "$B"
  git -C "$REPO" archive --format=tar "$SHA" > "$B/src.tar"
  docker run --rm -v "$B":/b node:22-bookworm bash -c 'set -e; mkdir /w && cd /w && tar -xf /b/src.tar && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 && tar -cf /b/app.tar -C /w . && chmod a+r /b/app.tar'
  mv "$B/app.tar" "$OUT/app-$L.tar"; rm -rf "$B"; echo "built $SHA → $OUT/app-$L.tar"
elif [ "$P" = start ]; then
  L=$1; : "${IMAGE:?set IMAGE}" "${CLAUDE_BIN:?set CLAUDE_BIN}" "${CODEX_BIN:?set CODEX_BIN}"
  docker rm -f "$(C "$L")" >/dev/null 2>&1
  docker run -d --name "$(C "$L")" --network none --memory=3g --entrypoint sleep "$IMAGE" infinity >/dev/null
  X 'mkdir -p /opt/app /opt/acc; id rh >/dev/null 2>&1 || useradd -m -s /bin/bash rh'
  docker cp "$OUT/app-$L.tar" "$(C "$L")":/opt/acc/app.tar >/dev/null
  docker cp "$CLAUDE_BIN" "$(C "$L")":/opt/acc/claude >/dev/null
  docker cp "$CODEX_BIN" "$(C "$L")":/opt/acc/codex >/dev/null
  X 'tar -xf /opt/acc/app.tar -C /opt/app && install -m 755 /opt/acc/claude /usr/local/bin/claude && install -m 755 /opt/acc/codex /usr/local/bin/codex && chmod -R a+rX /opt/app /opt/acc'
  X 'E=/opt/app/scripts/manual/web-only-e2e
(cd /tmp && MOCK_LOG=/tmp/mock-anthropic.log node $E/mock-anthropic.mjs 18300 > /tmp/mock-anthropic.out 2>&1 &)
echo approval > /tmp/codex-mode
(cd /tmp && PORT=18762 MOCK_MODE_FILE=/tmp/codex-mode MOCK_LOG=/tmp/mock-codex.log BODY_LOG=/tmp/mock-codex-bodies.log node /opt/app/scripts/manual/codex-version-audit/mock.mjs > /tmp/mock-codex.out 2>&1 &)
sleep 1
mkdir -p /home/rh/.agend /home/rh/w/lead/.claude /home/rh/w/worker /home/rh/w/coder /home/rh/.codex
# The fleet quickstart writes for "Web only": no channel. lead and coder ask before acting (no permission bypass).
cat > /home/rh/.agend/fleet.yaml <<Y
health_port: 19391
defaults:
  backend: claude-code
instances:
  lead: { working_directory: /home/rh/w/lead, backend: claude-code, skipPermissions: false }
  worker: { working_directory: /home/rh/w/worker, backend: claude-code }
  coder: { working_directory: /home/rh/w/coder, backend: codex, skipPermissions: false }
Y
# Claude Code 2.1.30x defaults to auto mode (runs what it judges low-risk without asking): a person who wants to be asked
# sets the default mode.
printf "{\"permissions\":{\"defaultMode\":\"default\"}}\n" > /home/rh/w/lead/.claude/settings.json
# Codex: the mock provider (no OpenAI account); AgEnD copies this into the instance home.
printf "model = \"mock-model\"\nmodel_provider = \"mock\"\n[model_providers.mock]\nname = \"mock\"\nbase_url = \"http://127.0.0.1:18762/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n" > /home/rh/.codex/config.toml
printf "ANTHROPIC_API_KEY=sk-ant-e2e-dummy\nANTHROPIC_BASE_URL=http://127.0.0.1:18300\n" > /home/rh/.agend/.env
chown -R rh:rh /home/rh'
  R 'cd ~ && nohup node /opt/app/dist/cli.js fleet start > /tmp/fleet.out 2>&1 &'
  echo "$L: started"
elif [ "$P" = drive ]; then
  L=$1; R "cd ~ && LABEL=$L node /opt/app/scripts/manual/web-only-e2e/drive.mjs" > "$OUT/drive-$L.log" 2>&1; echo "drive rc=$?" >> "$OUT/drive-$L.log"; cat "$OUT/drive-$L.log"
elif [ "$P" = collect ]; then
  L=$1
  R 'grep -E "^\[[0-9: -]+\] (WARN|ERROR|FATAL)" ~/.agend/daemon.log | cut -c1-300' > "$OUT/daemon-warn-$L.log" 2>&1
  R 'cat ~/.agend/fleet.yaml' > "$OUT/fleet-yaml-$L.txt" 2>&1
  X 'cat /tmp/mock-anthropic.log' > "$OUT/mock-anthropic-$L.log" 2>&1
  X 'cat /tmp/mock-codex-bodies.log' > "$OUT/mock-codex-bodies-$L.log" 2>&1
  echo collected
elif [ "$P" = stop ]; then
  L=$1; docker rm -f "$(C "$L")" >/dev/null 2>&1; echo stopped
fi
